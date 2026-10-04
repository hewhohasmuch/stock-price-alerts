import { describe, it, expect, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import {
  createAccountRecovery, validateNewPassword, hashToken, isSessionCurrent, EXPIRED_LINK_ERROR,
  type AccountStore, type Mailer, type TokenPurpose,
} from "../src/services/account-recovery.js";

// ── In-memory fakes that follow the AccountStore contract ────────────────────

interface FakeUser { id: string; username: string; passwordHash: string; email: string | null; verified: boolean; sessionVersion: number }
interface FakeToken { tokenHash: string; userId: string; purpose: TokenPurpose; email: string; createdAt: number; expiresAt: number; usedAt: number | null }

function makeStore(now: () => number) {
  const users = new Map<string, FakeUser>();
  const tokens: FakeToken[] = [];
  const HOUR = 3600_000;
  const store: AccountStore = {
    async findRecoveryTargets(identifier) {
      const id = identifier.toLowerCase();
      return [...users.values()]
        .filter(u => u.email && u.verified && (u.username.toLowerCase() === id || u.email.toLowerCase() === id))
        .map(u => ({ userId: u.id, username: u.username, email: u.email! }));
    },
    async issueToken(a) {
      const t = now();
      if (a.maxPerAccountPerHour != null &&
          tokens.filter(k => k.userId === a.userId && k.purpose === a.purpose && k.createdAt > t - HOUR).length >= a.maxPerAccountPerHour) return false;
      if (tokens.filter(k => k.email.toLowerCase() === a.email.toLowerCase() && k.createdAt > t - HOUR).length >= a.maxPerAddressPerHour) return false;
      for (const k of tokens) if (k.userId === a.userId && k.purpose === a.purpose && k.usedAt == null) k.usedAt = t;
      tokens.push({ tokenHash: a.tokenHash, userId: a.userId, purpose: a.purpose, email: a.email,
        createdAt: t, expiresAt: t + a.ttlMinutes * 60_000, usedAt: null });
      return true;
    },
    async consumeResetToken(tokenHash, newHash) {
      const t = now();
      const k = tokens.find(x => x.tokenHash === tokenHash && x.purpose === "reset" && x.usedAt == null && x.expiresAt > t);
      if (!k) return null;
      k.usedAt = t;
      const u = users.get(k.userId)!;
      u.passwordHash = newHash; u.sessionVersion++;
      for (const x of tokens) if (x.userId === u.id && x.purpose === "reset" && x.usedAt == null) x.usedAt = t;
      return { userId: u.id, username: u.username, email: k.email };
    },
    async changePassword(userId, verify, newHash) {
      const u = users.get(userId);
      if (!u) return { status: "no-user" };
      if (!(await verify(u.passwordHash))) return { status: "wrong-password" };
      u.passwordHash = newHash; u.sessionVersion++;
      for (const x of tokens) if (x.userId === u.id && x.purpose === "reset" && x.usedAt == null) x.usedAt = now();
      return { status: "ok", sessionVersion: u.sessionVersion, username: u.username, email: u.verified ? u.email : null };
    },
    async consumeVerifyToken(tokenHash) {
      const t = now();
      const k = tokens.find(x => x.tokenHash === tokenHash && x.purpose === "verify_email" && x.usedAt == null && x.expiresAt > t);
      if (!k) return null;
      k.usedAt = t;
      const u = users.get(k.userId)!;
      const previousEmail = u.verified ? u.email : null;
      u.email = k.email; u.verified = true;
      for (const x of tokens) if (x.userId === u.id && x.purpose === "reset" && x.usedAt == null) x.usedAt = t;
      return { userId: u.id, username: u.username, email: k.email, previousEmail };
    },
    async getUsername(userId) { return users.get(userId)?.username ?? null; },
  };
  return { store, users, tokens };
}

function makeMailer() {
  const sent: { kind: string; to: string; username: string; link?: string; newEmail?: string }[] = [];
  const mailer: Mailer = {
    async sendResetLink(to, username, link) { sent.push({ kind: "reset", to, username, link }); },
    async sendVerifyLink(to, username, link) { sent.push({ kind: "verify", to, username, link }); },
    async sendPasswordChanged(to, username) { sent.push({ kind: "password-changed", to, username }); },
    async sendEmailChanged(to, username, newEmail) { sent.push({ kind: "email-changed", to, username, newEmail }); },
  };
  return { mailer, sent };
}

const GOOD = "correct horse battery";     // 21 chars
const GOOD2 = "another long passphrase";  // 23 chars

let clock: number;
let env: ReturnType<typeof makeStore>;
let mail: ReturnType<typeof makeMailer>;
let svc: ReturnType<typeof createAccountRecovery>;

async function addUser(id: string, username: string, email: string | null, verified = true, password = "old-password") {
  env.users.set(id, { id, username, passwordHash: await bcrypt.hash(password, 4), email, verified, sessionVersion: 0 });
}
const tokenFrom = (link: string) => link.split(/#(?:reset|verify)=/)[1];

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 5, 12);
  env = makeStore(() => clock);
  mail = makeMailer();
  svc = createAccountRecovery({ store: env.store, mailer: mail.mailer, appUrl: "https://wekintech.com", bcryptCost: 4, log: () => {} });
  await addUser("u1", "cmac", "cmac@example.com");
});

describe("validateNewPassword", () => {
  it.each([
    ["14 characters is too short", "a".repeat(14), /at least 15/],
    ["15 characters is accepted", "a".repeat(15), null],
    ["64 characters is accepted", "a".repeat(64), null],
    ["65 characters is too long", "a".repeat(65), /at most 64/],
    ["over 72 UTF-8 bytes is rejected even within 64 characters", "é".repeat(37), /too long once encoded/],  // 74 bytes
    ["exactly 72 UTF-8 bytes is accepted", "é".repeat(36), null],
    ["emoji count as one character each", "😀".repeat(15), null],                                      // 60 bytes
    ["non-strings are rejected", 12345, /required/],
  ])("%s", (_name, pw, expected) => {
    const r = validateNewPassword(pw);
    if (expected === null) expect(r).toBeNull();
    else expect(r).toMatch(expected as RegExp);
  });
});

describe("requestReset", () => {
  it("emails a fragment link and stores only the token hash", async () => {
    await svc.requestReset("CMAC");
    expect(mail.sent).toHaveLength(1);
    const { link, to, username } = mail.sent[0];
    expect(to).toBe("cmac@example.com");
    expect(username).toBe("cmac");
    expect(link).toMatch(/^https:\/\/wekintech\.com\/#reset=[A-Za-z0-9_-]{43}$/);
    const token = tokenFrom(link!);
    expect(env.tokens[0].tokenHash).toBe(hashToken(token));
    expect(env.tokens[0].tokenHash).not.toContain(token);
  });

  it("matches by verified email, case-insensitively", async () => {
    await svc.requestReset("CMAC@Example.com");
    expect(mail.sent.map(m => m.username)).toEqual(["cmac"]);
  });

  it("sends nothing for an unknown identifier", async () => {
    await svc.requestReset("nobody");
    expect(mail.sent).toHaveLength(0);
    expect(env.tokens).toHaveLength(0);
  });

  it("sends nothing to an account whose email is unverified", async () => {
    await addUser("u2", "newbie", "newbie@example.com", false);
    await svc.requestReset("newbie");
    await svc.requestReset("newbie@example.com");
    expect(mail.sent).toHaveLength(0);
  });

  it("sends one link per account sharing a verified email", async () => {
    await addUser("u2", "cmac2", "cmac@example.com");
    await svc.requestReset("cmac@example.com");
    expect(mail.sent.map(m => m.username).sort()).toEqual(["cmac", "cmac2"]);
    expect(new Set(mail.sent.map(m => m.link)).size).toBe(2);
  });

  it("a new request cancels the previous link", async () => {
    await svc.requestReset("cmac");
    await svc.requestReset("cmac");
    const [first, second] = mail.sent.map(m => tokenFrom(m.link!));
    expect((await svc.resetPassword(first, GOOD)).ok).toBe(false);
    expect((await svc.resetPassword(second, GOOD)).ok).toBe(true);
  });

  it("stops after 3 per account per hour without rotating the last link", async () => {
    for (let i = 0; i < 4; i++) await svc.requestReset("cmac");
    expect(mail.sent).toHaveLength(3);
    expect((await svc.resetPassword(tokenFrom(mail.sent[2].link!), GOOD)).ok).toBe(true);
  });

  it("stops after 5 emails per address per hour across accounts", async () => {
    for (const n of [2, 3, 4]) await addUser(`u${n}`, `cmac${n}`, "cmac@example.com");
    await svc.requestReset("cmac@example.com");   // 4 emails
    await svc.requestReset("cmac@example.com");   // only 1 more allowed
    expect(mail.sent).toHaveLength(5);
  });

  it("allows more after the hour passes", async () => {
    for (let i = 0; i < 3; i++) await svc.requestReset("cmac");
    clock += 3600_001;
    await svc.requestReset("cmac");
    expect(mail.sent).toHaveLength(4);
  });

  it("sends nothing and logs when APP_URL is missing", async () => {
    const logs: string[] = [];
    const s = createAccountRecovery({ store: env.store, mailer: mail.mailer, appUrl: null, bcryptCost: 4, log: m => logs.push(m) });
    await s.requestReset("cmac");
    expect(mail.sent).toHaveLength(0);
    expect(logs.join()).toMatch(/APP_URL/);
  });

  it("a mail failure does not throw and does not log the token", async () => {
    const logs: string[] = [];
    const broken = { ...mail.mailer, sendResetLink: async () => { throw new Error("SMTP down"); } };
    const s = createAccountRecovery({ store: env.store, mailer: broken, appUrl: "https://x.test", bcryptCost: 4, log: m => logs.push(m) });
    await expect(s.requestReset("cmac")).resolves.toBeUndefined();
    expect(logs.join()).toMatch(/SMTP down/);
    expect(logs.join()).not.toMatch(/#reset=/);
  });
});

describe("resetPassword", () => {
  async function linkToken() { await svc.requestReset("cmac"); return tokenFrom(mail.sent.at(-1)!.link!); }

  it("sets the new password, bumps the session version and notifies", async () => {
    const token = await linkToken();
    expect(await svc.resetPassword(token, GOOD)).toEqual({ ok: true, userId: "u1" });
    const u = env.users.get("u1")!;
    expect(await bcrypt.compare(GOOD, u.passwordHash)).toBe(true);
    expect(u.sessionVersion).toBe(1);
    expect(mail.sent.at(-1)).toMatchObject({ kind: "password-changed", to: "cmac@example.com" });
  });

  it("works only once", async () => {
    const token = await linkToken();
    await svc.resetPassword(token, GOOD);
    expect(await svc.resetPassword(token, GOOD2)).toEqual({ ok: false, error: EXPIRED_LINK_ERROR });
  });

  it("expires after 30 minutes", async () => {
    const token = await linkToken();
    clock += 30 * 60_000 + 1;
    expect(await svc.resetPassword(token, GOOD)).toEqual({ ok: false, error: EXPIRED_LINK_ERROR });
  });

  it("rejects a weak password without using up the link", async () => {
    const token = await linkToken();
    expect(await svc.resetPassword(token, "short")).toMatchObject({ ok: false, error: expect.stringMatching(/15/) });
    expect((await svc.resetPassword(token, GOOD)).ok).toBe(true);
  });

  it("rejects an unknown token", async () => {
    expect(await svc.resetPassword("not-a-real-token", GOOD)).toEqual({ ok: false, error: EXPIRED_LINK_ERROR });
  });
});

describe("changePassword", () => {
  it("changes the password with the right current password", async () => {
    const r = await svc.changePassword("u1", "old-password", GOOD);
    expect(r).toEqual({ ok: true, sessionVersion: 1 });
    expect(await bcrypt.compare(GOOD, env.users.get("u1")!.passwordHash)).toBe(true);
    expect(mail.sent.at(-1)).toMatchObject({ kind: "password-changed" });
  });

  it("rejects a wrong current password and changes nothing", async () => {
    const before = env.users.get("u1")!.passwordHash;
    expect(await svc.changePassword("u1", "wrong", GOOD)).toEqual({ ok: false, error: "Current password is incorrect." });
    expect(env.users.get("u1")!.passwordHash).toBe(before);
    expect(mail.sent).toHaveLength(0);
  });

  it("invalidates outstanding reset links", async () => {
    await svc.requestReset("cmac");
    const token = tokenFrom(mail.sent[0].link!);
    await svc.changePassword("u1", "old-password", GOOD);
    expect((await svc.resetPassword(token, GOOD2)).ok).toBe(false);
  });

  it("does not email a password-changed notice to an unverified address", async () => {
    await addUser("u2", "newbie", "newbie@example.com", false);
    await svc.changePassword("u2", "old-password", GOOD);
    expect(mail.sent).toHaveLength(0);
  });
});

describe("email verification", () => {
  it("verifies a new signup address", async () => {
    await addUser("u2", "newbie", "newbie@example.com", false);
    await svc.requestEmailVerification("u2", "newbie@example.com");
    expect(mail.sent[0]).toMatchObject({ kind: "verify", to: "newbie@example.com" });
    expect(mail.sent[0].link).toMatch(/\/#verify=/);
    expect(await svc.verifyEmail(tokenFrom(mail.sent[0].link!))).toEqual({ ok: true, email: "newbie@example.com" });
    expect(env.users.get("u2")).toMatchObject({ verified: true });
  });

  it("an email change keeps the old address until confirmed, then notifies it", async () => {
    await svc.requestEmailVerification("u1", "new@example.com");
    expect(env.users.get("u1")).toMatchObject({ email: "cmac@example.com", verified: true });
    await svc.verifyEmail(tokenFrom(mail.sent[0].link!));
    expect(env.users.get("u1")).toMatchObject({ email: "new@example.com", verified: true });
    expect(mail.sent.at(-1)).toMatchObject({ kind: "email-changed", to: "cmac@example.com", newEmail: "new@example.com" });
  });

  it("confirming a new address invalidates outstanding reset links", async () => {
    await svc.requestReset("cmac");
    const reset = tokenFrom(mail.sent[0].link!);
    await svc.requestEmailVerification("u1", "new@example.com");
    await svc.verifyEmail(tokenFrom(mail.sent[1].link!));
    expect((await svc.resetPassword(reset, GOOD)).ok).toBe(false);
  });

  it("a verify link works once and expires after 24 hours", async () => {
    await svc.requestEmailVerification("u1", "new@example.com");
    const token = tokenFrom(mail.sent[0].link!);
    await svc.requestEmailVerification("u1", "other@example.com");
    expect((await svc.verifyEmail(token)).ok).toBe(false);                 // superseded
    const latest = tokenFrom(mail.sent[1].link!);
    clock += 24 * 3600_000 + 1;
    expect((await svc.verifyEmail(latest)).ok).toBe(false);                // expired
  });

  it("a reset link cannot be used as a verify link", async () => {
    await svc.requestReset("cmac");
    expect((await svc.verifyEmail(tokenFrom(mail.sent[0].link!))).ok).toBe(false);
  });
});

describe("isSessionCurrent", () => {
  it("accepts a matching version", () => expect(isSessionCurrent(2, 2)).toBe(true));
  it("rejects an older version", () => expect(isSessionCurrent(1, 2)).toBe(false));
  it("treats a session from before this feature as version 0", () => {
    expect(isSessionCurrent(undefined, 0)).toBe(true);
    expect(isSessionCurrent(undefined, 1)).toBe(false);
  });
  it("rejects a deleted user", () => expect(isSessionCurrent(0, null)).toBe(false));
});
