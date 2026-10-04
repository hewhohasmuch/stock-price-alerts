# Account Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add self-service forgot/reset password, change password, and email-ownership verification to the public app, with the concurrency, revocation and throttling guarantees in the spec.

**Architecture:** The work splits into four parts:
- **Service** (`src/services/account-recovery.ts`): pure. It holds the password rules, token creation and hashing, and the orchestration, with an injected `AccountStore` and `Mailer`, following the `createMarketDirectionService` pattern.
- **Store** (`src/services/account-store.ts`): a Postgres implementation where every multi-step operation runs in one transaction and always locks the user row before token rows.
- **Server routes** (`src/server.ts`): they wire the service to HTTP. `requireAuth` now enforces `users.session_version`.
- **Front end** (`public/index.html`): adds the forgot, reset and verify flows and the Settings cards.

**Tech Stack:** TypeScript (ES2022, `.js` import suffixes), Express 4 with express-session and connect-pg-simple, `pg`, `bcryptjs` (cost 10), nodemailer, Vitest 4, and Node `crypto` (`randomBytes`, `sha256`).

**Spec:** `docs/superpowers/specs/2026-10-04-account-recovery-design.md`. Read it first; the spec wins on conflicts.

**Branch:** `feat/account-recovery`, created from `main`. The spec is already committed. This branch is independent of PR #27.

**How this plan was prepared:** every code block and diff below was run before writing. Unit tests 33/33, database tests 10/10 (repeated 5×), the end-to-end HTTP check 32/32, and `tsc` was clean. The front-end patch was checked for anchors and syntax only; Chrome wasn't connected, so Task 5 verifies it in a browser. Diffs are against `main` at `2e3dcda` and apply cleanly (`git apply --check`).

## Global Constraints

- **New passwords:** 15–64 characters (code points) and at most 72 UTF-8 bytes. Never truncate. Applies to register, reset and change. Login is unchanged.
- **bcrypt:** cost 10.
- **Tokens:** `randomBytes(32)` base64url. Only `sha256` hex is stored.
- **Link lifetimes:** reset links 30 minutes, verify links 24 hours. Both are single-use.
- **Throttles:** per IP via `rateLimitAuth` (10 per 15 minutes; 429). Per account, 3 reset emails per hour. Per address, 5 emails per hour across verify and reset. Throttled requests return the generic 200, rotate nothing and send nothing.
- **Generic reply** from `POST /api/auth/forgot`, always 200: `If an account matches, we've sent a reset link to its email.`
- **Links:** `APP_URL/#reset=<token>` and `APP_URL/#verify=<token>`. The token goes in the **fragment**, and the base comes **never** from the request Host header.
- **Lock order** in every transaction: the `users` row, then `account_tokens` rows.
- **Sessions:** a session is valid only while `session.sv` equals `users.session_version`. A missing `sv` counts as 0.
- **CSRF:** new account mutations require `Content-Type: application/json` (415 otherwise), on top of the `SameSite=Strict` cookie.
- **Dev email logging:** only when `NODE_ENV !== "production"` **and** `DEV_LOG_EMAIL_LINKS=1`. Tokens never appear in other logs.
- **No new npm dependencies.**
- **Commit messages** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Deploy day for existing users:** nobody is logged out (sessions without `sv` count as 0), and existing emails stay verified (grandfathering). *Test: Task 2, "grandfathers existing emails…", plus `isSessionCurrent(undefined, 0)` in Task 1.*
2. **Mail scanners opening links:** opening `#reset` or `#verify` must not use the link up. Reset only happens when the form is submitted; verify is posted by the page's JavaScript, which scanners don't run. *Check: Task 5, Step 4.*
3. **A logged-in user opens someone else's reset link:** the reset form still shows; after success that browser is logged out and sees the login screen. *Check: Task 5, Step 4.*
4. **SMTP down or APP_URL missing in production:** the user sees the same generic message, an error is logged without the token, and nothing crashes. *Test: Task 1, "a mail failure does not throw…" and "sends nothing and logs when APP_URL is missing".*
5. **Two browsers during a password change:** the changing browser stays logged in and the other gets 401. *Test: Task 4 end-to-end check, "changing browser stays logged in" and "other browser is logged out after change".*

---

### Task 1: Account-recovery service (pure)

**Files:**
- Create: `src/services/account-recovery.ts`
- Create: `tests/account-recovery.test.ts`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - **Functions:** `validateNewPassword(pw: unknown): string | null`, `newToken()`, `hashToken(token)`, `isSessionCurrent(sessionVersion: number | undefined, currentVersion: number | null): boolean`.
  - **Constants:** `EXPIRED_LINK_ERROR`.
  - **Types:** `AccountStore`, `Mailer`, `RecoveryTarget`, `TokenPurpose`.
  - **`createAccountRecovery({store, mailer, appUrl, bcryptCost?, log?})`** returns:
    - `requestReset(identifier)`
    - `resetPassword(token, pw) → {ok:true,userId} | {ok:false,error}`
    - `changePassword(userId, current, next) → {ok:true,sessionVersion} | {ok:false,error}`
    - `requestEmailVerification(userId, email)`
    - `verifyEmail(token) → {ok:true,email} | {ok:false,error}`

- [ ] **Step 1: Write the failing tests.** Create `tests/account-recovery.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them and watch them fail.**
  Run: `npx vitest run tests/account-recovery.test.ts`
  Expected: FAIL, because `../src/services/account-recovery.js` cannot be resolved.

- [ ] **Step 3: Implement.** Create `src/services/account-recovery.ts`:

```ts
// Account recovery: forgot/reset password, change password, email verification.
// No Express and no SQL here — storage and email are injected (see createAccountRecovery).
// Spec: docs/superpowers/specs/2026-10-04-account-recovery-design.md
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

export const PASSWORD_MIN_CHARS = 15;
export const PASSWORD_MAX_CHARS = 64;
export const BCRYPT_MAX_BYTES = 72;
export const RESET_TTL_MINUTES = 30;
export const VERIFY_TTL_MINUTES = 24 * 60;
export const MAX_RESETS_PER_ACCOUNT_PER_HOUR = 3;
export const MAX_EMAILS_PER_ADDRESS_PER_HOUR = 5;

export const EXPIRED_LINK_ERROR = "This link has expired or was already used.";

/** Returns an error message, or null when the password is acceptable for a NEW password. */
export function validateNewPassword(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required.";
  const chars = [...password].length;            // count code points, not UTF-16 units
  if (chars < PASSWORD_MIN_CHARS) return `Password must be at least ${PASSWORD_MIN_CHARS} characters.`;
  if (chars > PASSWORD_MAX_CHARS) return `Password must be at most ${PASSWORD_MAX_CHARS} characters.`;
  if (Buffer.byteLength(password, "utf8") > BCRYPT_MAX_BYTES) {
    return "Password is too long once encoded; please use fewer special characters.";
  }
  return null;
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A session is valid only while its stored version matches the user's current session_version.
 * Sessions created before this feature have no version and count as 0 (every user starts at 0).
 */
export function isSessionCurrent(sessionVersion: number | undefined, currentVersion: number | null): boolean {
  return currentVersion !== null && (sessionVersion ?? 0) === currentVersion;
}

export type TokenPurpose = "reset" | "verify_email";

export interface RecoveryTarget { userId: string; username: string; email: string }

export interface AccountStore {
  /** Accounts matching a username or a VERIFIED email (case-insensitive) that have a verified email. */
  findRecoveryTargets(identifier: string): Promise<RecoveryTarget[]>;
  /**
   * In one transaction with the user row locked: check throttles, invalidate the user's open
   * tokens of this purpose, insert the new token. Returns false (and changes nothing) if throttled.
   */
  issueToken(args: {
    userId: string; purpose: TokenPurpose; email: string; tokenHash: string; ttlMinutes: number;
    maxPerAccountPerHour: number | null; maxPerAddressPerHour: number;
  }): Promise<boolean>;
  /** Claim a reset token and set the new password hash, bump session_version, invalidate the
   *  user's other reset tokens — all in one transaction. Null if expired/used/unknown. */
  consumeResetToken(tokenHash: string, newPasswordHash: string): Promise<RecoveryTarget | null>;
  /** Lock the user, check the current password with `verify`, set the new hash, bump
   *  session_version, invalidate open reset tokens — one transaction. */
  changePassword(
    userId: string,
    verify: (currentHash: string) => Promise<boolean>,
    newPasswordHash: string,
  ): Promise<{ status: "ok"; sessionVersion: number; username: string; email: string | null }
           | { status: "wrong-password" | "no-user" }>;
  /** Claim a verify token; set notification_email + email_verified_at; invalidate open reset
   *  tokens — one transaction. Returns the previous verified address (if any) for notification. */
  consumeVerifyToken(tokenHash: string):
    Promise<{ userId: string; username: string; email: string; previousEmail: string | null } | null>;
  getUsername(userId: string): Promise<string | null>;
}

export interface Mailer {
  sendResetLink(to: string, username: string, link: string): Promise<void>;
  sendVerifyLink(to: string, username: string, link: string): Promise<void>;
  sendPasswordChanged(to: string, username: string): Promise<void>;
  sendEmailChanged(to: string, username: string, newEmail: string): Promise<void>;
}

export interface RecoveryDeps {
  store: AccountStore;
  mailer: Mailer;
  /** Trusted base URL, e.g. https://wekintech.com — never derived from request headers. */
  appUrl: string | null;
  bcryptCost?: number;
  log?: (msg: string) => void;
}

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export function createAccountRecovery(deps: RecoveryDeps) {
  const { store, mailer, appUrl } = deps;
  const cost = deps.bcryptCost ?? 10;
  const log = deps.log ?? ((m: string) => console.error(m));

  function link(kind: "reset" | "verify", token: string): string | null {
    if (!appUrl) return null;
    // Token in the fragment: browsers never send it to the server or in Referer.
    return `${appUrl.replace(/\/+$/, "")}/#${kind}=${token}`;
  }

  // Email failures must never change the HTTP outcome (and never log tokens).
  async function safeSend(what: string, send: () => Promise<void>): Promise<void> {
    try { await send(); } catch (err) { log(`[account-recovery] ${what} email failed: ${(err as Error).message}`); }
  }

  async function requestReset(identifier: unknown): Promise<void> {
    if (typeof identifier !== "string" || !identifier.trim()) return;
    if (!appUrl) { log("[account-recovery] APP_URL is not set; reset email not sent"); return; }
    const targets = await store.findRecoveryTargets(identifier.trim());
    for (const t of targets) {
      const token = newToken();
      const issued = await store.issueToken({
        userId: t.userId, purpose: "reset", email: t.email, tokenHash: hashToken(token),
        ttlMinutes: RESET_TTL_MINUTES,
        maxPerAccountPerHour: MAX_RESETS_PER_ACCOUNT_PER_HOUR,
        maxPerAddressPerHour: MAX_EMAILS_PER_ADDRESS_PER_HOUR,
      });
      if (issued) await safeSend("reset", () => mailer.sendResetLink(t.email, t.username, link("reset", token)!));
    }
  }

  async function resetPassword(token: unknown, newPassword: unknown): Promise<Result<{ userId: string }>> {
    const rule = validateNewPassword(newPassword);
    if (rule) return { ok: false, error: rule };
    if (typeof token !== "string" || !token) return { ok: false, error: EXPIRED_LINK_ERROR };
    const hash = await bcrypt.hash(newPassword as string, cost);
    const user = await store.consumeResetToken(hashToken(token), hash);
    if (!user) return { ok: false, error: EXPIRED_LINK_ERROR };
    await safeSend("password-changed", () => mailer.sendPasswordChanged(user.email, user.username));
    return { ok: true, userId: user.userId };
  }

  async function changePassword(userId: string, current: unknown, next: unknown):
      Promise<Result<{ sessionVersion: number }>> {
    if (typeof current !== "string" || !current) return { ok: false, error: "Current password is required." };
    const rule = validateNewPassword(next);
    if (rule) return { ok: false, error: rule };
    const newHash = await bcrypt.hash(next as string, cost);
    const result = await store.changePassword(userId, (h) => bcrypt.compare(current, h), newHash);
    if (result.status !== "ok") return { ok: false, error: "Current password is incorrect." };
    const { email, username, sessionVersion } = result;
    if (email) await safeSend("password-changed", () => mailer.sendPasswordChanged(email, username));
    return { ok: true, sessionVersion };
  }

  /** Sends a verification link for `email` (signup or change). Silently skips if throttled. */
  async function requestEmailVerification(userId: string, email: string): Promise<void> {
    if (!appUrl) { log("[account-recovery] APP_URL is not set; verification email not sent"); return; }
    const username = await store.getUsername(userId);
    if (!username) return;
    const token = newToken();
    const issued = await store.issueToken({
      userId, purpose: "verify_email", email, tokenHash: hashToken(token),
      ttlMinutes: VERIFY_TTL_MINUTES, maxPerAccountPerHour: null,
      maxPerAddressPerHour: MAX_EMAILS_PER_ADDRESS_PER_HOUR,
    });
    if (issued) await safeSend("verify", () => mailer.sendVerifyLink(email, username, link("verify", token)!));
  }

  async function verifyEmail(token: unknown): Promise<Result<{ email: string }>> {
    if (typeof token !== "string" || !token) return { ok: false, error: EXPIRED_LINK_ERROR };
    const r = await store.consumeVerifyToken(hashToken(token));
    if (!r) return { ok: false, error: EXPIRED_LINK_ERROR };
    if (r.previousEmail && r.previousEmail.toLowerCase() !== r.email.toLowerCase()) {
      const prev = r.previousEmail;
      await safeSend("email-changed", () => mailer.sendEmailChanged(prev, r.username, r.email));
    }
    return { ok: true, email: r.email };
  }

  return { requestReset, resetPassword, changePassword, requestEmailVerification, verifyEmail };
}
```

- [ ] **Step 4: Run the tests.**
  Run: `npx vitest run tests/account-recovery.test.ts`
  Expected: PASS, 37 tests.

- [ ] **Step 5: Add the file to the default suite.** In `package.json`, set:
```json
    "test": "vitest run tests/alert-evaluator.test.ts tests/account-recovery.test.ts",
```
  Run: `npm test && npm run build`
  Expected: all pass; `tsc` prints nothing.

- [ ] **Step 6: Commit.**
```bash
git add src/services/account-recovery.ts tests/account-recovery.test.ts package.json
git commit -m "Add account recovery service with password rules and one-time tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schema, user fields, Postgres store, verified-only alert email

**Files:**
- Modify:
  - `src/db.ts`: migrations, user columns, `createUser(…, email?)`, verified-only `userEmail`; remove `updateUserNotificationEmail`
  - `src/types.ts`: `User` gains `sessionVersion` and `emailVerified`
  - `package.json`: adds a `test:db` script
- Create:
  - `src/services/account-store.ts`
  - `tests/account-recovery.db.test.ts`

**Interfaces:**
- Consumes (from Task 1): `AccountStore`, `RecoveryTarget`, `createAccountRecovery`, `hashToken`, `isSessionCurrent`.
- Produces:
  - **`createPgAccountStore(pool): PgAccountStore`.** It implements `AccountStore` plus:
    - `getSessionVersion(userId): Promise<number|null>`
    - `getAccountStatus(userId): Promise<{emailVerified, pendingEmail}|null>`
    - `deleteSessions(userId, exceptSid?)`
  - **`createUser(username, password, email?)`.**
  - **`User`** now has `sessionVersion: number` and `emailVerified: boolean`.
  - **`StockAlert.userEmail`** is null unless the address is verified.

**One-time setup.** The database tests need a **local** test database separate from your dev one. Create it once:
```bash
node -e "require('dotenv').config();const pg=require('pg');const u=new URL(process.env.DATABASE_URL);if(!/^(localhost|127\.0\.0\.1)$/.test(u.hostname))throw 'not local';const c=new pg.Client({connectionString:u.toString()});c.connect().then(()=>c.query('CREATE DATABASE stock_alerts_test')).then(()=>console.log('created')).catch(e=>console.log(e.message)).finally(()=>c.end())"
```
Then set `TEST_DATABASE_URL` to the same URL with `/stock_alerts_test` as the database name. Don't commit it. The test file refuses any host other than localhost.

- [ ] **Step 1: Write the failing database tests.** Create `tests/account-recovery.db.test.ts`:

```ts
// Database guarantees for account recovery. Opt-in: runs only when TEST_DATABASE_URL points
// at a LOCAL database (it creates and deletes users). Not part of `npm test`; run with
//   TEST_DATABASE_URL=postgresql://.../stock_alerts_test npm run test:db
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const isLocal = !!url && /^(localhost|127\.0\.0\.1)$/.test(new URL(url).hostname);
if (url && !isLocal) throw new Error("TEST_DATABASE_URL must point at localhost");
if (isLocal) {
  // db.ts builds its pool from these at import time.
  process.env.DATABASE_URL = url;
  process.env.DATABASE_URL_UNPOOLED = url;
}

describe.skipIf(!isLocal)("account recovery — database guarantees", async () => {
  const db = await import("../src/db.js");
  const { createPgAccountStore } = await import("../src/services/account-store.js");
  const { createAccountRecovery, hashToken, isSessionCurrent } = await import("../src/services/account-recovery.js");
  const { pool } = db;
  const store = createPgAccountStore(pool);
  const links: string[] = [];
  const mailer = {
    sendResetLink: async (_to: string, _u: string, link: string) => { links.push(link); },
    sendVerifyLink: async (_to: string, _u: string, link: string) => { links.push(link); },
    sendPasswordChanged: async () => {},
    sendEmailChanged: async () => {},
  };
  const svc = createAccountRecovery({ store, mailer, appUrl: "https://example.test", bcryptCost: 4, log: () => {} });
  const tokenOf = (link: string) => link.split(/#(?:reset|verify)=/)[1];
  const PW = "correct horse battery";
  let n = 0;

  async function verifiedUser(): Promise<string> {
    const name = `zz_ar_${process.pid}_${++n}`;
    const u = await db.createUser(name, "old-password", `${name}@example.test`);
    await pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [u.id]);
    return u.id;
  }
  async function openResetTokens(userId: string): Promise<number> {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM account_tokens
       WHERE user_id = $1 AND purpose = 'reset' AND used_at IS NULL AND expires_at > now()`, [userId]);
    return rows[0].n;
  }
  async function resetLinkFor(userId: string): Promise<string> {
    const { rows } = await pool.query(`SELECT username FROM users WHERE id = $1`, [userId]);
    await svc.requestReset(rows[0].username);
    return tokenOf(links.at(-1)!);
  }

  beforeAll(async () => { await db.initDb(); });
  beforeEach(() => { links.length = 0; });
  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE username LIKE 'zz_ar_%'`);
    await pool.end();
  });

  it("grandfathers existing emails as verified, but not users created afterwards", async () => {
    await pool.query(`ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at`);
    const old = `zz_ar_${process.pid}_old`;
    await pool.query(`INSERT INTO users (id, username, password_hash, notification_email)
                      VALUES ($1, $1, 'x', 'old@example.test')`, [old]);
    await db.initDb();
    const fresh = await db.createUser(`zz_ar_${process.pid}_fresh`, "old-password", "fresh@example.test");
    await db.initDb();                                    // re-running must not grandfather new rows
    expect((await db.findUserById(old))!.emailVerified).toBe(true);
    expect((await db.findUserById(fresh.id))!.emailVerified).toBe(false);
  });

  it("lets exactly one of two simultaneous resets with the same token succeed", async () => {
    const id = await verifiedUser();
    const token = await resetLinkFor(id);
    const results = await Promise.all([svc.resetPassword(token, PW), svc.resetPassword(token, PW + "!")]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(await store.getSessionVersion(id)).toBe(1);
  });

  it("leaves exactly one valid link after simultaneous reset requests", async () => {
    const id = await verifiedUser();
    const { rows } = await pool.query(`SELECT username FROM users WHERE id = $1`, [id]);
    await Promise.all([svc.requestReset(rows[0].username), svc.requestReset(rows[0].username)]);
    expect(await openResetTokens(id)).toBe(1);
  });

  it("rolls back a failed reset and leaves the token usable", async () => {
    const id = await verifiedUser();
    const token = await resetLinkFor(id);
    await expect(store.consumeResetToken(hashToken(token), null as unknown as string)).rejects.toThrow();
    expect(await store.getSessionVersion(id)).toBe(0);
    expect((await svc.resetPassword(token, PW)).ok).toBe(true);
  });

  it("an old reset link stops working after a Settings password change", async () => {
    const id = await verifiedUser();
    const token = await resetLinkFor(id);
    expect((await svc.changePassword(id, "old-password", PW)).ok).toBe(true);
    expect((await svc.resetPassword(token, PW + "!")).ok).toBe(false);
  });

  it("an old reset link stops working after an email change is confirmed", async () => {
    const id = await verifiedUser();
    const token = await resetLinkFor(id);
    await svc.requestEmailVerification(id, `new_${id}@example.test`);
    expect((await svc.verifyEmail(tokenOf(links.at(-1)!))).ok).toBe(true);
    expect((await svc.resetPassword(token, PW)).ok).toBe(false);
  });

  it("serializes change-password with a concurrent reset: the losing request changes nothing", async () => {
    const id = await verifiedUser();
    const token = await resetLinkFor(id);
    const [changed, reset] = await Promise.all([
      svc.changePassword(id, "old-password", PW),
      svc.resetPassword(token, PW + "!"),
    ]);
    // Either order is fine, but never both: each one invalidates or bumps for the other.
    expect([changed.ok, reset.ok].filter(Boolean)).toHaveLength(1);
    expect(await store.getSessionVersion(id)).toBe(1);
  });

  it("a session saved with the old version is rejected after revocation", async () => {
    const id = await verifiedUser();
    const before = await store.getSessionVersion(id);
    expect(isSessionCurrent(undefined, before)).toBe(true);   // pre-existing sessions stay valid
    await svc.resetPassword(await resetLinkFor(id), PW);
    // Simulate an in-flight request re-saving its (stale) session after the reset.
    expect(isSessionCurrent(before ?? 0, await store.getSessionVersion(id))).toBe(false);
  });

  it("withholds alert emails for unverified addresses", async () => {
    const u = await db.createUser(`zz_ar_${process.pid}_alerts`, "old-password", "unverified@example.test");
    await pool.query(`INSERT INTO alerts (id, user_id, symbol, name) VALUES ($1, $2, 'AAPL', 'Apple')`,
      [`zz_ar_alert_${u.id}`, u.id]);
    const mine = (await db.getEnabledAlerts()).find(a => a.userId === u.id)!;
    expect(mine.userEmail ?? null).toBeNull();
    await pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [u.id]);
    expect((await db.getEnabledAlerts()).find(a => a.userId === u.id)!.userEmail).toBe("unverified@example.test");
  });

  it("reports a pending email change", async () => {
    const id = await verifiedUser();
    await svc.requestEmailVerification(id, `pending_${id}@example.test`);
    expect(await store.getAccountStatus(id)).toEqual({ emailVerified: true, pendingEmail: `pending_${id}@example.test` });
  });
});
```

  Add to `package.json` scripts: `"test:db": "vitest run tests/account-recovery.db.test.ts",`

- [ ] **Step 2: Run them and watch them fail.**
  Run: `TEST_DATABASE_URL=postgresql://<user>:<pass>@localhost:5432/stock_alerts_test npm run test:db`
  Expected: FAIL, because `../src/services/account-store.js` cannot be resolved.

- [ ] **Step 3: Apply the `db.ts` changes.** Save this as `db.diff` in the scratchpad and run `git apply db.diff`:

```diff
--- a/src/db.ts
+++ b/src/db.ts
@@ -75,6 +75,27 @@ export async function initDb(): Promise<void> {
     -- UNIQUE constraint on username is case-sensitive, but lookups treat
     -- usernames as case-insensitive).
     CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));
+
+    -- Migration: account recovery (email verification, session revocation, one-time tokens).
+    -- email_verified_at is added WITH a default so rows that exist at migration time are
+    -- grandfathered as verified; the default is then dropped so new users start unverified.
+    -- Both statements are no-ops on later runs.
+    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ DEFAULT now();
+    ALTER TABLE users ALTER COLUMN email_verified_at DROP DEFAULT;
+    ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
+
+    CREATE TABLE IF NOT EXISTS account_tokens (
+      token_hash  TEXT PRIMARY KEY,
+      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
+      purpose     TEXT NOT NULL CHECK (purpose IN ('reset', 'verify_email')),
+      email       TEXT NOT NULL,
+      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
+      expires_at  TIMESTAMPTZ NOT NULL,
+      used_at     TIMESTAMPTZ
+    );
+    CREATE INDEX IF NOT EXISTS account_tokens_user_idx ON account_tokens (user_id, purpose, created_at);
+    CREATE INDEX IF NOT EXISTS account_tokens_email_idx ON account_tokens (LOWER(email), created_at);
+    DELETE FROM account_tokens WHERE created_at < now() - INTERVAL '24 hours';
   `);
 }
 
@@ -122,15 +143,16 @@ export async function checkRateLimit(ip: string): Promise<{ allowed: boolean; re
 
 // ── User functions ──────────────────────────────────────────────────────
 
-export async function createUser(username: string, password: string): Promise<User> {
+export async function createUser(username: string, password: string, email?: string): Promise<User> {
   const id = randomUUID();
   const passwordHash = await bcrypt.hash(password, 10);
   try {
     const { rows } = await pool.query(
-      `INSERT INTO users (id, username, password_hash)
-       VALUES ($1, $2, $3)
-       RETURNING id, username, password_hash AS "passwordHash", notification_email AS "notificationEmail", created_at AS "createdAt"`,
-      [id, username, passwordHash],
+      `INSERT INTO users (id, username, password_hash, notification_email)
+       VALUES ($1, $2, $3, $4)
+       RETURNING id, username, password_hash AS "passwordHash", notification_email AS "notificationEmail", created_at AS "createdAt",
+              session_version AS "sessionVersion", (email_verified_at IS NOT NULL) AS "emailVerified"`,
+      [id, username, passwordHash, email ?? null],
     );
     return { ...rows[0], createdAt: rows[0].createdAt.toISOString() };
   } catch (err: any) {
@@ -141,7 +163,8 @@ export async function createUser(username: string, password: string): Promise<Us
 
 export async function verifyUser(username: string, password: string): Promise<User | null> {
   const { rows } = await pool.query(
-    `SELECT id, username, password_hash AS "passwordHash", notification_email AS "notificationEmail", created_at AS "createdAt"
+    `SELECT id, username, password_hash AS "passwordHash", notification_email AS "notificationEmail", created_at AS "createdAt",
+              session_version AS "sessionVersion", (email_verified_at IS NOT NULL) AS "emailVerified"
      FROM users WHERE LOWER(username) = LOWER($1)`,
     [username],
   );
@@ -154,7 +177,8 @@ export async function verifyUser(username: string, password: string): Promise<Us
 
 export async function findUserById(id: string): Promise<User | null> {
   const { rows } = await pool.query(
-    `SELECT id, username, password_hash AS "passwordHash", notification_email AS "notificationEmail", created_at AS "createdAt"
+    `SELECT id, username, password_hash AS "passwordHash", notification_email AS "notificationEmail", created_at AS "createdAt",
+              session_version AS "sessionVersion", (email_verified_at IS NOT NULL) AS "emailVerified"
      FROM users WHERE id = $1`,
     [id],
   );
@@ -164,7 +188,8 @@ export async function findUserById(id: string): Promise<User | null> {
 
 export async function findUserByUsername(username: string): Promise<User | null> {
   const { rows } = await pool.query(
-    `SELECT id, username, password_hash AS "passwordHash", notification_email AS "notificationEmail", created_at AS "createdAt"
+    `SELECT id, username, password_hash AS "passwordHash", notification_email AS "notificationEmail", created_at AS "createdAt",
+              session_version AS "sessionVersion", (email_verified_at IS NOT NULL) AS "emailVerified"
      FROM users WHERE LOWER(username) = LOWER($1)`,
     [username],
   );
@@ -172,13 +197,6 @@ export async function findUserByUsername(username: string): Promise<User | null>
   return { ...rows[0], createdAt: rows[0].createdAt.toISOString() };
 }
 
-export async function updateUserNotificationEmail(userId: string, email: string): Promise<void> {
-  await pool.query(
-    `UPDATE users SET notification_email = $1 WHERE id = $2`,
-    [email, userId],
-  );
-}
-
 // ── Alert functions ─────────────────────────────────────────────────────
 
 function rowToAlert(row: any): StockAlert {
@@ -332,7 +350,7 @@ export async function getEnabledAlerts(): Promise<StockAlert[]> {
        a.created_at AS "createdAt",
        a.alert_type AS "alertType", a.params_json AS "params",
        a.state_json AS "state", a.last_triggered_at AS "lastTriggeredAt",
-       u.notification_email AS "userEmail"
+       CASE WHEN u.email_verified_at IS NOT NULL THEN u.notification_email END AS "userEmail"
      FROM alerts a
      JOIN users u ON u.id = a.user_id
      WHERE a.enabled = true`,
```

- [ ] **Step 4: Apply the `types.ts` change** (`git apply types.diff`):

```diff
--- a/src/types.ts
+++ b/src/types.ts
@@ -4,6 +4,8 @@ export interface User {
   passwordHash: string;
   notificationEmail?: string;
   createdAt: string;
+  sessionVersion: number;
+  emailVerified: boolean;
 }
 
 export type AlertType = "absolute-threshold" | "percent-change" | "trailing-high";
```

- [ ] **Step 5: Create the store.** Create `src/services/account-store.ts`:

```ts
// Postgres implementation of AccountStore. Every multi-step operation runs in one transaction;
// token claims are a single conditional UPDATE so a token can be used at most once, even under
// simultaneous requests (the second UPDATE waits on the row lock, then matches zero rows).
// Lock order is ALWAYS users row first, then account_tokens rows, in every transaction, so
// concurrent reset / change-password / verify / issue cannot deadlock.
import type pg from "pg";
import type { AccountStore, RecoveryTarget } from "./account-recovery.js";

export interface PgAccountStore extends AccountStore {
  getSessionVersion(userId: string): Promise<number | null>;
  getAccountStatus(userId: string): Promise<{ emailVerified: boolean; pendingEmail: string | null } | null>;
  /** Best-effort cleanup of stored sessions; revocation itself is enforced by session_version. */
  deleteSessions(userId: string, exceptSid?: string): Promise<void>;
}

export function createPgAccountStore(pool: pg.Pool): PgAccountStore {
  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** Find the token's user (no lock on the token) and lock that user row. */
  async function lockTokenOwner(c: pg.PoolClient, tokenHash: string, purpose: string) {
    const t = await c.query(
      `SELECT user_id FROM account_tokens WHERE token_hash = $1 AND purpose = $2`, [tokenHash, purpose]);
    if (t.rowCount === 0) return null;
    const u = await c.query(
      `SELECT username, notification_email, email_verified_at FROM users WHERE id = $1 FOR UPDATE`,
      [t.rows[0].user_id]);
    return u.rowCount ? (u.rows[0] as { username: string; notification_email: string | null; email_verified_at: Date | null }) : null;
  }

  /** Atomically mark the token used if still valid; null when expired, used or unknown. */
  async function claimToken(c: pg.PoolClient, tokenHash: string, purpose: string) {
    const r = await c.query(
      `UPDATE account_tokens SET used_at = now()
       WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id, email`, [tokenHash, purpose]);
    return r.rowCount ? { userId: r.rows[0].user_id as string, email: r.rows[0].email as string } : null;
  }

  const invalidateOpenResets = (c: pg.PoolClient, userId: string) => c.query(
    `UPDATE account_tokens SET used_at = now()
     WHERE user_id = $1 AND purpose = 'reset' AND used_at IS NULL`, [userId]);

  return {
    async findRecoveryTargets(identifier) {
      const { rows } = await pool.query(
        `SELECT id AS "userId", username, notification_email AS email
         FROM users
         WHERE notification_email IS NOT NULL AND email_verified_at IS NOT NULL
           AND (LOWER(username) = LOWER($1) OR LOWER(notification_email) = LOWER($1))
         ORDER BY created_at`, [identifier]);
      return rows as RecoveryTarget[];
    },

    issueToken(a) {
      return tx(async c => {
        const user = await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [a.userId]);
        if (user.rowCount === 0) return false;
        if (a.maxPerAccountPerHour != null) {
          const { rows } = await c.query(
            `SELECT count(*)::int AS n FROM account_tokens
             WHERE user_id = $1 AND purpose = $2 AND created_at > now() - INTERVAL '1 hour'`,
            [a.userId, a.purpose]);
          if (rows[0].n >= a.maxPerAccountPerHour) return false;
        }
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM account_tokens
           WHERE LOWER(email) = LOWER($1) AND created_at > now() - INTERVAL '1 hour'`, [a.email]);
        if (rows[0].n >= a.maxPerAddressPerHour) return false;
        await c.query(
          `UPDATE account_tokens SET used_at = now()
           WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [a.userId, a.purpose]);
        await c.query(
          `INSERT INTO account_tokens (token_hash, user_id, purpose, email, expires_at)
           VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
          [a.tokenHash, a.userId, a.purpose, a.email, a.ttlMinutes]);
        return true;
      });
    },

    consumeResetToken(tokenHash, newPasswordHash) {
      return tx(async c => {
        const owner = await lockTokenOwner(c, tokenHash, "reset");
        if (!owner) return null;
        const claim = await claimToken(c, tokenHash, "reset");
        if (!claim) return null;
        const { userId, email } = claim;
        await c.query(
          `UPDATE users SET password_hash = $2, session_version = session_version + 1 WHERE id = $1`,
          [userId, newPasswordHash]);
        await invalidateOpenResets(c, userId);
        return { userId, username: owner.username, email };
      });
    },

    changePassword(userId, verify, newPasswordHash) {
      return tx(async c => {
        const u = await c.query(
          `SELECT username, password_hash, notification_email, email_verified_at
           FROM users WHERE id = $1 FOR UPDATE`, [userId]);
        if (u.rowCount === 0) return { status: "no-user" as const };
        const row = u.rows[0];
        if (!(await verify(row.password_hash))) return { status: "wrong-password" as const };
        const upd = await c.query(
          `UPDATE users SET password_hash = $2, session_version = session_version + 1
           WHERE id = $1 RETURNING session_version`, [userId, newPasswordHash]);
        await invalidateOpenResets(c, userId);
        return {
          status: "ok" as const,
          sessionVersion: upd.rows[0].session_version as number,
          username: row.username as string,
          email: row.email_verified_at ? (row.notification_email as string | null) : null,
        };
      });
    },

    consumeVerifyToken(tokenHash) {
      return tx(async c => {
        const prev = await lockTokenOwner(c, tokenHash, "verify_email");
        if (!prev) return null;
        const claim = await claimToken(c, tokenHash, "verify_email");
        if (!claim) return null;
        const { userId, email } = claim;
        await c.query(
          `UPDATE users SET notification_email = $2, email_verified_at = now() WHERE id = $1`, [userId, email]);
        await invalidateOpenResets(c, userId);
        return {
          userId, username: prev.username, email,
          previousEmail: prev.email_verified_at ? prev.notification_email : null,
        };
      });
    },

    async getUsername(userId) {
      const { rows } = await pool.query(`SELECT username FROM users WHERE id = $1`, [userId]);
      return rows[0]?.username ?? null;
    },

    async getSessionVersion(userId) {
      const { rows } = await pool.query(`SELECT session_version FROM users WHERE id = $1`, [userId]);
      return rows.length ? rows[0].session_version : null;
    },

    async getAccountStatus(userId) {
      const { rows } = await pool.query(
        `SELECT (u.email_verified_at IS NOT NULL) AS "emailVerified",
                (SELECT t.email FROM account_tokens t
                  WHERE t.user_id = u.id AND t.purpose = 'verify_email'
                    AND t.used_at IS NULL AND t.expires_at > now()
                  ORDER BY t.created_at DESC LIMIT 1) AS "pendingEmail"
         FROM users u WHERE u.id = $1`, [userId]);
      return rows[0] ?? null;
    },

    async deleteSessions(userId, exceptSid) {
      try {
        await pool.query(
          `DELETE FROM session WHERE sess->>'userId' = $1 AND ($2::text IS NULL OR sid <> $2)`,
          [userId, exceptSid ?? null]);
      } catch { /* session table may not exist yet; version check already revokes */ }
    },
  };
}
```

- [ ] **Step 6: Run the database tests, five times** to catch flaky concurrency.
  Run: `for i in 1 2 3 4 5; do TEST_DATABASE_URL=… npm run test:db 2>&1 | grep "Tests "; done`
  Expected: `10 passed (10)` every time. If a `deadlock detected` error appears, a transaction took locks out of order (it must take the user row before any token rows).

- [ ] **Step 7: Check that the default suite still passes.**
  Run: `npm test && npm run build`
  Expected: pass, and `tsc` is clean. `src/cli.ts` still calls `createUser(username, password)`, and the optional email keeps it compiling.

- [ ] **Step 8: Commit.**
```bash
git add src/db.ts src/types.ts src/services/account-store.ts tests/account-recovery.db.test.ts package.json
git commit -m "Add account tokens schema, session versioning and transactional account store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Config and account mailer

**Files:**
- Modify:
  - `src/config.ts`: adds `appUrl` and `devLogEmailLinks`
  - `src/services/email-sender.ts`: adds `createSmtpMailer()`
  - `.env.example`

**Interfaces:**
- Consumes (from Task 1): the `Mailer` type.
- Produces: `config.appUrl: string | null`, `config.devLogEmailLinks: boolean`, and `createSmtpMailer(): Mailer`.

These changes are configuration and message wiring. Task 1's tests already cover the service's mail behaviour with a fake mailer, and Task 4's end-to-end check exercises `createSmtpMailer` in dev-log mode.

- [ ] **Step 1: Apply the config diff** (`git apply config.diff`):

```diff
--- a/src/config.ts
+++ b/src/config.ts
@@ -23,6 +23,12 @@ export const config = {
   cooldownMinutes: Number(process.env.COOLDOWN_MINUTES || 60),
   alpacaApiKey: process.env.ALPACA_API_KEY,
   alpacaSecretKey: process.env.ALPACA_SECRET_KEY,
+  // Trusted public base URL for links in emails (e.g. https://wekintech.com). Never derived
+  // from request headers. Without it, reset/verification emails are not sent.
+  appUrl: process.env.APP_URL?.trim() || null,
+  // Local development only: print account emails (including their links) to the console
+  // instead of sending them. Ignored in production.
+  devLogEmailLinks: process.env.NODE_ENV !== "production" && process.env.DEV_LOG_EMAIL_LINKS === "1",
 };
 
 export function isEmailConfigured(): boolean {
```

- [ ] **Step 2: Apply the mailer diff** (`git apply email-sender.diff`):

```diff
--- a/src/services/email-sender.ts
+++ b/src/services/email-sender.ts
@@ -1,6 +1,7 @@
 import nodemailer from "nodemailer";
-import { config } from "../config.js";
+import { config, isEmailConfigured } from "../config.js";
 import type { TriggeredAlert } from "../types.js";
+import type { Mailer } from "./account-recovery.js";
 
 let transporter: nodemailer.Transporter | null = null;
 
@@ -51,3 +52,48 @@ export async function sendEmailAlert(triggered: TriggeredAlert): Promise<void> {
     text,
   });
 }
+
+// ── Account emails (password reset, verification, notices) ──────────────
+
+async function sendAccountEmail(to: string, subject: string, lines: string[]): Promise<void> {
+  const text = lines.join("\n");
+  if (config.devLogEmailLinks) {
+    console.log(`[dev email] to=${to} subject="${subject}"\n${text}`);
+    return;
+  }
+  if (!isEmailConfigured()) throw new Error("SMTP is not configured");
+  await getTransporter().sendMail({ from: config.smtp.user, to, subject, text });
+}
+
+export function createSmtpMailer(): Mailer {
+  return {
+    sendResetLink: (to, username, link) => sendAccountEmail(to, "Reset your Price Alert password", [
+      `Someone asked to reset the password for "${username}" on Price Alert.`,
+      ``,
+      `To choose a new password, open this link within 30 minutes:`,
+      link,
+      ``,
+      `The link works once. If you didn't ask for this, ignore this email; your password stays the same.`,
+    ]),
+    sendVerifyLink: (to, username, link) => sendAccountEmail(to, "Confirm your email for Price Alert", [
+      `Please confirm that this address belongs to the Price Alert account "${username}".`,
+      ``,
+      `Open this link within 24 hours:`,
+      link,
+      ``,
+      `Until you confirm, alert emails and password resets won't be sent here.`,
+      `If you didn't sign up, ignore this email.`,
+    ]),
+    sendPasswordChanged: (to, username) => sendAccountEmail(to, "Your Price Alert password was changed", [
+      `The password for "${username}" on Price Alert was just changed, and other devices were logged out.`,
+      ``,
+      `If this wasn't you, use "Forgot password?" on the login page right away.`,
+    ]),
+    sendEmailChanged: (to, username, newEmail) => sendAccountEmail(to, "Your Price Alert email was changed", [
+      `The email address for "${username}" on Price Alert was changed to ${newEmail}.`,
+      `Alerts and password resets now go to that address.`,
+      ``,
+      `If this wasn't you, contact the site owner.`,
+    ]),
+  };
+}
```

- [ ] **Step 3: Document the settings.** Append to `.env.example`:
```
# Public base URL used in password-reset and email-verification links (no trailing slash).
# Required in production (e.g. https://wekintech.com); without it those emails are not sent.
APP_URL=http://localhost:3000
# Local development only: print account emails (with their links) to the console instead of sending.
# DEV_LOG_EMAIL_LINKS=1
```

- [ ] **Step 4: Verify.**
  Run: `npm test && npm run build`
  Expected: pass and clean.

- [ ] **Step 5: Commit.**
```bash
git add src/config.ts src/services/email-sender.ts .env.example
git commit -m "Add APP_URL config and account email messages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Routes and session revocation

**Files:**
- Modify: `src/server.ts`. This sets up the store and service, and adds `requireJson` and an async `requireAuth` that checks the session version. It also updates register, login and `/me`, and adds `forgot`, `reset`, `verify-email`, `resend-verification` and `settings/password`, plus the new `settings/email` behaviour.

**Interfaces:**
- Consumes:
  - **Task 1:** `createAccountRecovery`, `isSessionCurrent`, `validateNewPassword`.
  - **Task 2:** `createPgAccountStore`, `createUser(…, email)`, `User.sessionVersion`.
  - **Task 3:** `config.appUrl`, `createSmtpMailer`.
- Produces (HTTP, used by Task 5):
  - **Register:** `POST /api/auth/register {username,email,password}` returns 201.
  - **Me:** `GET /api/auth/me` returns `{id, username, notificationEmail, emailVerified, pendingEmail}`.
  - **Forgot:** `POST /api/auth/forgot {identifier}` returns 200 with `{ok, message}`.
  - **Reset:** `POST /api/auth/reset {token,password}` returns 200 or 400 `{error}`.
  - **Verify:** `POST /api/auth/verify-email {token}` returns 200 `{ok,email}` or 400.
  - **Resend:** `POST /api/settings/resend-verification {}` returns 200.
  - **Change email:** `PATCH /api/settings/email {email,currentPassword}` returns 200 `{ok,pendingEmail}` or 400.
  - **Change password:** `PATCH /api/settings/password {currentPassword,newPassword}` returns 200 or 400.

This repo has no reliable server test harness: `tests/server.test.ts` expects an already-running server. So the gate here is a throwaway end-to-end script against the real server and the **test** database. Keep it in the session scratchpad, **not** in the repo.

- [ ] **Step 1: Write the end-to-end check** as `e2e.mjs` in the scratchpad:

```js
// Throwaway end-to-end check of the account-recovery HTTP flows (keep OUT of the repo).
// Needs: the server running on E2E_BASE (default http://localhost:3201) against TEST_DATABASE_URL,
// with DEV_LOG_EMAIL_LINKS=1 and its stdout written to E2E_SERVER_LOG.
import fs from "node:fs";
import { createRequire } from "node:module";
const pg = createRequire("C:/Projects/stock-price-alerts/package.json")("pg");
const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
await db.connect();
// The per-IP limit (10 / 15 min) is not under test here; reset it so one IP can run every flow.
const resetIpLimit = () => db.query("DELETE FROM login_attempts");
const BASE = process.env.E2E_BASE || "http://localhost:3201";
const LOG = process.env.E2E_SERVER_LOG;
if (!LOG || !process.env.TEST_DATABASE_URL) throw new Error("set E2E_SERVER_LOG and TEST_DATABASE_URL");
const results = [];
const check = (name, cond, extra = "") => { results.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); };

function browser() {
  let cookie = "";
  return async (method, path, body, contentType = "application/json") => {
    await resetIpLimit();
    const res = await fetch(BASE + path, {
      method, headers: { ...(body !== undefined ? { "Content-Type": contentType } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : (contentType === "application/json" ? JSON.stringify(body) : body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
}
const lastLink = (kind) => {
  const m = [...fs.readFileSync(LOG, "utf8").matchAll(new RegExp(`#${kind}=([A-Za-z0-9_-]+)`, "g"))];
  return m.length ? m[m.length - 1][1] : null;
};
const count = (re) => (fs.readFileSync(LOG, "utf8").match(re) || []).length;

const name = `zz_e2e_${Date.now() % 100000}`;
const email = `${name}@example.test`;
const PW1 = "first long passphrase", PW2 = "second long passphrase", PW3 = "third long passphrase";
const A = browser(), B = browser();

let r = await A("POST", "/api/auth/register", { username: name, email, password: "short" });
check("register rejects a short password", r.status === 400 && /15/.test(r.data?.error), JSON.stringify(r));
r = await A("POST", "/api/auth/register", `username=${name}`, "application/x-www-form-urlencoded");
check("register rejects non-JSON (CSRF guard)", r.status === 415, r.status);
r = await A("POST", "/api/auth/register", { username: name, email, password: PW1 });
check("register succeeds", r.status === 201, JSON.stringify(r));
r = await A("GET", "/api/auth/me");
check("new account starts unverified", r.data?.emailVerified === false, JSON.stringify(r.data));
const verifyToken = lastLink("verify");
check("verification email logged", !!verifyToken);

const resetsBefore = count(/#reset=/g);
r = await B("POST", "/api/auth/forgot", { identifier: name });
check("forgot for unverified account: generic 200", r.status === 200 && /If an account matches/.test(r.data?.message));
check("forgot for unverified account sends nothing", count(/#reset=/g) === resetsBefore);

r = await A("POST", "/api/auth/verify-email", { token: verifyToken });
check("verify-email succeeds", r.status === 200, JSON.stringify(r));
r = await A("POST", "/api/auth/verify-email", { token: verifyToken });
check("verify link works once", r.status === 400);
r = await A("GET", "/api/auth/me");
check("account now verified", r.data?.emailVerified === true && r.data?.notificationEmail === email);

r = await B("POST", "/api/auth/login", { username: name, password: PW1 });
check("second browser logs in", r.status === 200);
r = await B("POST", "/api/auth/forgot", { identifier: email.toUpperCase() });
const resetToken = lastLink("reset");
check("forgot by email (any case) sends a link", r.status === 200 && !!resetToken);
r = await B("POST", "/api/auth/forgot", { identifier: "nobody_at_all" });
check("forgot for unknown account: same generic 200", r.status === 200 && r.data?.message === "If an account matches, we've sent a reset link to its email.");

r = await A("POST", "/api/auth/reset", { token: resetToken, password: PW2 });
check("reset succeeds", r.status === 200, JSON.stringify(r));
check("password-changed notice sent", count(/password was changed/g) >= 1);
r = await A("GET", "/api/auth/me");
check("resetting browser is logged out", r.status === 401, r.status);
r = await B("GET", "/api/auth/me");
check("other browser is logged out", r.status === 401, r.status);
r = await A("POST", "/api/auth/reset", { token: resetToken, password: PW3 });
check("reset link works once", r.status === 400 && /expired or was already used/.test(r.data?.error));
r = await A("POST", "/api/auth/login", { username: name, password: PW1 });
check("old password no longer works", r.status === 401);
r = await A("POST", "/api/auth/login", { username: name, password: PW2 });
check("new password works", r.status === 200);

await B("POST", "/api/auth/login", { username: name, password: PW2 });
r = await A("PATCH", "/api/settings/password", { currentPassword: "wrong wrong wrong", newPassword: PW3 });
check("change password rejects wrong current password", r.status === 400 && /incorrect/.test(r.data?.error));
r = await A("PATCH", "/api/settings/password", { currentPassword: PW2, newPassword: PW3 });
check("change password succeeds", r.status === 200, JSON.stringify(r));
r = await A("GET", "/api/auth/me");
check("changing browser stays logged in", r.status === 200, r.status);
r = await B("GET", "/api/auth/me");
check("other browser is logged out after change", r.status === 401, r.status);

const newEmail = `new_${email}`;
r = await A("PATCH", "/api/settings/email", { email: newEmail, currentPassword: "wrong wrong wrong" });
check("email change requires the current password", r.status === 400);
r = await A("PATCH", "/api/settings/email", { email: newEmail, currentPassword: PW3 });
check("email change accepted as pending", r.status === 200 && r.data?.pendingEmail === newEmail, JSON.stringify(r));
r = await A("GET", "/api/auth/me");
check("old email stays active while pending", r.data?.notificationEmail === email && r.data?.pendingEmail === newEmail, JSON.stringify(r.data));
r = await A("POST", "/api/auth/verify-email", { token: lastLink("verify") });
check("confirming the new email succeeds", r.status === 200);
r = await A("GET", "/api/auth/me");
check("new email active, nothing pending", r.data?.notificationEmail === newEmail && r.data?.pendingEmail === null, JSON.stringify(r.data));
check("old address notified of the change", new RegExp(`to=${email.replace(/[.]/g, "\\.")} subject="Your Price Alert email was changed"`).test(fs.readFileSync(LOG, "utf8")));

const log = fs.readFileSync(LOG, "utf8");
const tokenLines = log.split("\n").filter(l => /[#](reset|verify)=/.test(l));
check("tokens appear only inside dev-email bodies", tokenLines.every(l => /^https?:\/\//.test(l.trim())), tokenLines.join(" | "));
check("server logged no errors", !/error/i.test(log.replace(/\[dev email\][^\n]*/g, "")), log.match(/.*error.*/i)?.[0]);

await db.end();
console.log(results.join("\n"));
console.log(`${results.filter(x => x.startsWith("PASS")).length}/${results.length} passed`);
```

- [ ] **Step 2: Run it against the current code and watch it fail.** Start the server against the test database, with emails logged instead of sent:
```bash
TEST_DATABASE_URL=… ; DATABASE_URL=$TEST_DATABASE_URL DATABASE_URL_UNPOOLED=$TEST_DATABASE_URL \
  APP_URL=http://localhost:3201 DEV_LOG_EMAIL_LINKS=1 PORT=3201 npx tsx src/server.ts > <scratchpad>/server.log 2>&1 &
TEST_DATABASE_URL=… E2E_SERVER_LOG=<scratchpad>/server.log node <scratchpad>/e2e.mjs
```
  Expected: many `FAIL` lines, starting with `register rejects a short password` (the old 6-character rule). Stop the server.

- [ ] **Step 3: Apply the server diff** (`git apply server.diff`):

```diff
--- a/src/server.ts
+++ b/src/server.ts
@@ -11,20 +11,36 @@ import {
   updateAlertNotes, updateAlertThresholds, updateAlertParams, resetBreach,
   setAlertShortlisted, setAlertStaged, updateAlertShares,
   resetTypedTrigger, createUser, verifyUser,
-  findUserById, updateUserNotificationEmail,
+  findUserById,
 } from "./db.js";
 import type { AlertParams, AlertType, PercentChangeParams } from "./types.js";
 import { fetchSinglePrice, fetchPrices } from "./services/price-fetcher.js";
 import { checkPrices } from "./scheduler.js";
 import { isMarketOpen } from "./utils/market-hours.js";
+import { config } from "./config.js";
+import { createSmtpMailer } from "./services/email-sender.js";
+import { createPgAccountStore } from "./services/account-store.js";
+import {
+  createAccountRecovery, isSessionCurrent, validateNewPassword,
+} from "./services/account-recovery.js";
 
 declare module "express-session" {
   interface SessionData {
     userId: string;
     username: string;
+    sv: number;   // users.session_version at login; see requireAuth
   }
 }
 
+const accountStore = createPgAccountStore(pool);
+const recovery = createAccountRecovery({
+  store: accountStore,
+  mailer: createSmtpMailer(),
+  appUrl: config.appUrl,
+});
+const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
+const FORGOT_MESSAGE = "If an account matches, we've sent a reset link to its email.";
+
 const __dirname = dirname(fileURLToPath(import.meta.url));
 const app = express();
 const PORT = Number(process.env.PORT) || 3000;
@@ -114,24 +130,61 @@ app.get("/health", (_req, res) => {
 
 // ── Auth routes ─────────────────────────────────────────────────────────
 
-app.post("/api/auth/register", rateLimitAuth, async (req, res) => {
+// CSRF protection for account mutations: the session cookie is SameSite=Strict, and these
+// routes only accept JSON bodies (a cross-site HTML form cannot send application/json).
+function requireJson(req: express.Request, res: express.Response, next: express.NextFunction) {
+  if (!req.is("application/json")) {
+    res.status(415).json({ error: "Content-Type must be application/json" });
+    return;
+  }
+  next();
+}
+
+/** Valid only while session.sv matches users.session_version (bumped on password change/reset). */
+async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
+  const userId = req.session.userId;
+  if (!userId) {
+    res.status(401).json({ error: "Not authenticated" });
+    return;
+  }
+  try {
+    const current = await accountStore.getSessionVersion(userId);
+    if (!isSessionCurrent(req.session.sv, current)) {
+      req.session.destroy(() => res.status(401).json({ error: "Not authenticated" }));
+      return;
+    }
+    next();
+  } catch (err) {
+    next(err);
+  }
+}
+
+app.post("/api/auth/register", requireJson, rateLimitAuth, async (req, res) => {
   try {
     const { username, password } = req.body;
-    if (!username || !password) {
-      res.status(400).json({ error: "username and password required" });
+    const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
+    if (typeof username !== "string" || !username || typeof password !== "string") {
+      res.status(400).json({ error: "username, email and password required" });
       return;
     }
     if (username.length < 3 || username.length > 30) {
       res.status(400).json({ error: "Username must be 3-30 characters" });
       return;
     }
-    if (password.length < 6) {
-      res.status(400).json({ error: "Password must be at least 6 characters" });
+    if (!EMAIL_RE.test(email)) {
+      res.status(400).json({ error: "A valid email address is required" });
+      return;
+    }
+    const rule = validateNewPassword(password);
+    if (rule) {
+      res.status(400).json({ error: rule });
       return;
     }
-    const user = await createUser(username, password);
+    const user = await createUser(username, password, email);
     req.session.userId = user.id;
     req.session.username = user.username;
+    req.session.sv = user.sessionVersion;
+    await recovery.requestEmailVerification(user.id, email);
     res.status(201).json({ id: user.id, username: user.username });
   } catch (err) {
     const msg = (err as Error).message;
@@ -158,6 +211,7 @@ app.post("/api/auth/login", rateLimitAuth, async (req, res) => {
     }
     req.session.userId = user.id;
     req.session.username = user.username;
+    req.session.sv = user.sessionVersion;
     res.json({ id: user.id, username: user.username });
   } catch (err) {
     console.error("POST /api/auth/login error:", err);
@@ -171,17 +225,16 @@ app.post("/api/auth/logout", (req, res) => {
   });
 });
 
-app.get("/api/auth/me", async (req, res) => {
-  if (!req.session.userId) {
-    res.status(401).json({ error: "Not authenticated" });
-    return;
-  }
+app.get("/api/auth/me", requireAuth, async (req, res) => {
   try {
-    const user = await findUserById(req.session.userId);
+    const userId = req.session.userId!;
+    const [user, status] = await Promise.all([findUserById(userId), accountStore.getAccountStatus(userId)]);
     res.json({
-      id: req.session.userId,
+      id: userId,
       username: req.session.username,
       notificationEmail: user?.notificationEmail ?? null,
+      emailVerified: status?.emailVerified ?? false,
+      pendingEmail: status?.pendingEmail ?? null,
     });
   } catch (err) {
     console.error("GET /api/auth/me error:", err);
@@ -189,45 +242,111 @@ app.get("/api/auth/me", async (req, res) => {
   }
 });
 
-// ── Settings routes ─────────────────────────────────────────────────────
+// Always the same answer, so it can't be used to discover accounts (429 only for IP throttling).
+app.post("/api/auth/forgot", requireJson, rateLimitAuth, async (req, res) => {
+  try {
+    await recovery.requestReset(req.body.identifier);
+  } catch (err) {
+    console.error("POST /api/auth/forgot error:", (err as Error).message);
+  }
+  res.json({ ok: true, message: FORGOT_MESSAGE });
+});
 
-app.patch("/api/settings/email", async (req, res) => {
-  if (!req.session.userId) {
-    res.status(401).json({ error: "Not authenticated" });
-    return;
+app.post("/api/auth/reset", requireJson, rateLimitAuth, async (req, res) => {
+  try {
+    const result = await recovery.resetPassword(req.body.token, req.body.password);
+    if (!result.ok) {
+      res.status(400).json({ error: result.error });
+      return;
+    }
+    // session_version already revokes every session; deleting the rows is cleanup. This
+    // browser is logged out too, even if it was logged in as a different account.
+    await accountStore.deleteSessions(result.userId);
+    req.session.destroy(() => res.json({ ok: true }));
+  } catch (err) {
+    console.error("POST /api/auth/reset error:", (err as Error).message);
+    res.status(500).json({ error: "Password reset failed" });
   }
+});
+
+app.post("/api/auth/verify-email", requireJson, rateLimitAuth, async (req, res) => {
   try {
-    const { email } = req.body;
-    if (typeof email !== "string" || !email.trim()) {
-      res.status(400).json({ error: "email is required" });
+    const result = await recovery.verifyEmail(req.body.token);
+    if (!result.ok) {
+      res.status(400).json({ error: result.error });
       return;
     }
-    const trimmed = email.trim();
-    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
+    res.json({ ok: true, email: result.email });
+  } catch (err) {
+    console.error("POST /api/auth/verify-email error:", (err as Error).message);
+    res.status(500).json({ error: "Email verification failed" });
+  }
+});
+
+// ── Settings routes ─────────────────────────────────────────────────────
+
+app.post("/api/settings/resend-verification", requireJson, rateLimitAuth, requireAuth, async (req, res) => {
+  try {
+    const userId = req.session.userId!;
+    const [user, status] = await Promise.all([findUserById(userId), accountStore.getAccountStatus(userId)]);
+    const target = status?.pendingEmail ?? (status?.emailVerified ? null : user?.notificationEmail ?? null);
+    if (target) await recovery.requestEmailVerification(userId, target);
+    res.json({ ok: true });
+  } catch (err) {
+    console.error("POST /api/settings/resend-verification error:", (err as Error).message);
+    res.status(500).json({ error: "Failed to send verification email" });
+  }
+});
+
+// The new address only takes effect once confirmed; the current address keeps working until then.
+app.patch("/api/settings/email", requireJson, rateLimitAuth, requireAuth, async (req, res) => {
+  try {
+    const userId = req.session.userId!;
+    const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
+    if (!EMAIL_RE.test(email)) {
       res.status(400).json({ error: "Invalid email address" });
       return;
     }
-    await updateUserNotificationEmail(req.session.userId, trimmed);
-    res.json({ ok: true });
+    const user = await verifyUser(req.session.username!, String(req.body.currentPassword ?? ""));
+    if (!user || user.id !== userId) {
+      res.status(400).json({ error: "Current password is incorrect." });
+      return;
+    }
+    await recovery.requestEmailVerification(userId, email);
+    res.json({ ok: true, pendingEmail: email });
   } catch (err) {
     console.error("PATCH /api/settings/email error:", err);
     res.status(500).json({ error: "Failed to update email" });
   }
 });
 
-// ── Auth middleware ──────────────────────────────────────────────────────
-
-function requireAuth(
-  req: express.Request,
-  res: express.Response,
-  next: express.NextFunction
-) {
-  if (!req.session.userId) {
-    res.status(401).json({ error: "Not authenticated" });
-    return;
+app.patch("/api/settings/password", requireJson, rateLimitAuth, requireAuth, async (req, res) => {
+  try {
+    const userId = req.session.userId!;
+    const username = req.session.username!;
+    const result = await recovery.changePassword(userId, req.body.currentPassword, req.body.newPassword);
+    if (!result.ok) {
+      res.status(400).json({ error: result.error });
+      return;
+    }
+    // Keep this browser logged in under a fresh session id with the new version;
+    // every other session fails the version check.
+    req.session.regenerate(async (err) => {
+      if (err) {
+        res.status(500).json({ error: "Password changed; please log in again." });
+        return;
+      }
+      req.session.userId = userId;
+      req.session.username = username;
+      req.session.sv = result.sessionVersion;
+      await accountStore.deleteSessions(userId, req.sessionID);
+      res.json({ ok: true });
+    });
+  } catch (err) {
+    console.error("PATCH /api/settings/password error:", (err as Error).message);
+    res.status(500).json({ error: "Failed to change password" });
   }
-  next();
-}
+});
 
 // ── Typed alert param validation ─────────────────────────────────────────
 
```

- [ ] **Step 4: Rerun the end-to-end check.** Restart the server exactly as in Step 2 and rerun the script.
  Expected: `32/32 passed`. Stop the server afterwards (and free port 3201).

- [ ] **Step 5: Verify.**
  Run: `npm test && npm run build && TEST_DATABASE_URL=… npm run test:db`
  Expected: all pass and `tsc` is clean.

- [ ] **Step 6: Commit.**
```bash
git add src/server.ts
git commit -m "Add forgot/reset/verify/change-password routes and session-version revocation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Front end

**Files:**
- Modify: `public/index.html`. This adds:
  - the referrer meta tag and styles
  - the register email field and hint
  - the forgot and reset forms
  - a flash banner
  - the email-status line, the current-password field and the Change Password card in Settings
  - the "Confirm Your Email" modal
  - `#reset`/`#verify` handling before `checkAuth()`

**Interfaces:**
- Consumes (from Task 4): the HTTP endpoints listed in Task 4's Produces block and their exact response fields.
- Produces: in-page functions `showForgotForm()`, `showLoginForm(notice?)`, `showResetForm(token)`, `flash(msg, isError?)`, `confirmEmailLink(token)`, `resendVerification()` and `renderEmailStatus()`.

The dashboard has no front-end test harness, so this task is verified manually in Step 4.

- [ ] **Step 1: Apply the UI diff** (`git apply index.diff`):

```diff
--- a/public/index.html
+++ b/public/index.html
@@ -4,6 +4,7 @@
   <meta charset="UTF-8">
   <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
   <meta name="theme-color" content="#4a6cf7">
+  <meta name="referrer" content="no-referrer">
   <title>Stock Price Alert Dashboard</title>
   <link rel="icon" href="/favicon-64.png" type="image/png" sizes="64x64">
   <link rel="icon" href="/favicon.ico" sizes="64x64">
@@ -176,6 +177,15 @@
     .auth-toggle a:hover { text-decoration: underline; }
 
     .hidden { display: none !important; }
+    .field-hint { font-size: 12px; color: var(--text-muted); margin: -8px 0 12px; }
+    .auth-links { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
+    .flash-msg {
+      position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 100;
+      max-width: calc(100% - 32px); padding: 10px 16px; border-radius: 6px; font-size: 14px;
+      background: var(--badge-on-bg); color: var(--badge-on-color); box-shadow: 0 2px 8px var(--card-shadow);
+    }
+    .flash-msg.error { background: var(--badge-off-bg); color: var(--badge-off-color); }
+    .email-status { font-size: 13px; color: var(--text-secondary); margin-top: 6px; }
 
     /* Modal */
     .modal-overlay {
@@ -339,16 +349,48 @@
           <label for="authUsername">Username</label>
           <input id="authUsername" type="text" required autocomplete="username">
         </div>
+        <div class="form-group hidden" id="authEmailGroup">
+          <label for="authEmail">Email</label>
+          <input id="authEmail" type="email" autocomplete="email">
+        </div>
         <div class="form-group">
           <label for="authPassword">Password</label>
           <input id="authPassword" type="password" required autocomplete="current-password">
         </div>
+        <div class="field-hint hidden" id="authPasswordHint">At least 15 characters. A passphrase like "blue coffee ticker tape" works well.</div>
         <button type="submit" class="btn-primary" id="authBtn">Log In</button>
         <div id="authError" class="error-msg"></div>
+        <div id="authNotice" class="success-msg hidden"></div>
+      </form>
+      <form id="forgotForm" class="hidden">
+        <div class="form-group">
+          <label for="forgotIdentifier">Username or email</label>
+          <input id="forgotIdentifier" type="text" required autocomplete="username">
+        </div>
+        <button type="submit" class="btn-primary" id="forgotBtn">Send reset link</button>
+        <div id="forgotError" class="error-msg"></div>
+        <div id="forgotNotice" class="success-msg hidden"></div>
       </form>
-      <div class="auth-toggle">
-        <span id="authToggleText">Don't have an account?</span>
-        <a id="authToggleLink" onclick="toggleAuthMode()">Register</a>
+      <form id="resetForm" class="hidden">
+        <div class="form-group">
+          <label for="resetPassword1">New password</label>
+          <input id="resetPassword1" type="password" required autocomplete="new-password">
+        </div>
+        <div class="field-hint">At least 15 characters. A passphrase like "blue coffee ticker tape" works well.</div>
+        <div class="form-group">
+          <label for="resetPassword2">Repeat new password</label>
+          <input id="resetPassword2" type="password" required autocomplete="new-password">
+        </div>
+        <button type="submit" class="btn-primary" id="resetBtn">Set new password</button>
+        <div id="resetError" class="error-msg"></div>
+      </form>
+      <div class="auth-toggle auth-links" id="authLinks">
+        <span><span id="authToggleText">Don't have an account?</span>
+          <a id="authToggleLink" onclick="toggleAuthMode()">Register</a></span>
+        <a id="forgotLink" onclick="showForgotForm()">Forgot password?</a>
+      </div>
+      <div class="auth-toggle hidden" id="backToLogin">
+        <a onclick="showLoginForm()">Back to log in</a>
       </div>
     </div>
   </div>
@@ -495,10 +537,39 @@
             <input id="settingsEmail" type="email" placeholder="you@example.com" style="width: 100%; max-width: 320px;" readonly>
             <button type="button" id="editEmailBtn" class="btn-secondary" onclick="enableEmailEdit()">Edit Email</button>
           </div>
+          <div id="emailStatus" class="email-status hidden">
+            <span id="emailStatusText"></span>
+            <a id="resendVerifyLink" onclick="resendVerification()" style="color: var(--primary); cursor: pointer;">Resend link</a>
+          </div>
+        </div>
+        <div class="form-group hidden" id="emailPasswordGroup" style="margin-bottom: 14px;">
+          <label for="settingsEmailPassword">Current password</label>
+          <input id="settingsEmailPassword" type="password" autocomplete="current-password" style="width: 100%; max-width: 320px;">
         </div>
         <button type="submit" class="btn-primary hidden" id="settingsBtn">Save Email</button>
         <div id="settingsError" class="error-msg"></div>
-        <div id="settingsSuccess" class="success-msg hidden">Email saved successfully.</div>
+        <div id="settingsSuccess" class="success-msg hidden">Check your new inbox for a confirmation link.</div>
+      </form>
+    </div>
+    <div class="card">
+      <h2>Change Password</h2>
+      <form id="passwordForm">
+        <div class="form-group" style="margin-bottom: 14px;">
+          <label for="pwCurrent">Current password</label>
+          <input id="pwCurrent" type="password" required autocomplete="current-password" style="width: 100%; max-width: 320px;">
+        </div>
+        <div class="form-group" style="margin-bottom: 14px;">
+          <label for="pwNew1">New password</label>
+          <input id="pwNew1" type="password" required autocomplete="new-password" style="width: 100%; max-width: 320px;">
+        </div>
+        <div class="field-hint">At least 15 characters. A passphrase like "blue coffee ticker tape" works well.</div>
+        <div class="form-group" style="margin-bottom: 14px;">
+          <label for="pwNew2">Repeat new password</label>
+          <input id="pwNew2" type="password" required autocomplete="new-password" style="width: 100%; max-width: 320px;">
+        </div>
+        <button type="submit" class="btn-primary" id="pwBtn">Change password</button>
+        <div id="pwError" class="error-msg"></div>
+        <div id="pwSuccess" class="success-msg hidden">Password changed. Other devices were logged out.</div>
       </form>
     </div>
   </div>
@@ -506,11 +577,12 @@
   <!-- No-email modal -->
   <div id="noEmailModal" class="modal-overlay hidden">
     <div class="modal-card">
-      <h3>Email Required</h3>
-      <p>An email address is needed for sending alerts to your inbox!</p>
+      <h3 id="emailModalTitle">Email Required</h3>
+      <p id="emailModalText">An email address is needed for sending alerts to your inbox!</p>
       <a onclick="goToSettings()">Go to Settings</a>
     </div>
   </div>
+  <div id="flashMsg" class="flash-msg hidden" role="status"></div>
 
   <script>
     // ── Auth state ────────────────────────────────────────────────────────
@@ -539,9 +611,135 @@
       authToggleText.textContent = isRegisterMode ? "Already have an account?" : "Don't have an account?";
       authToggleLink.textContent = isRegisterMode ? "Log in" : "Register";
       authPassword.autocomplete  = isRegisterMode ? "new-password" : "current-password";
+      document.getElementById("authEmailGroup").classList.toggle("hidden", !isRegisterMode);
+      document.getElementById("authEmail").required = isRegisterMode;
+      document.getElementById("authPasswordHint").classList.toggle("hidden", !isRegisterMode);
+      document.getElementById("forgotLink").classList.toggle("hidden", isRegisterMode);
       authError.textContent = "";
     }
 
+    // ── Forgot / reset password ───────────────────────────────────────────
+    let resetToken = null;
+
+    function setAuthView(view) {          // "login" | "forgot" | "reset"
+      authForm.classList.toggle("hidden", view !== "login");
+      document.getElementById("forgotForm").classList.toggle("hidden", view !== "forgot");
+      document.getElementById("resetForm").classList.toggle("hidden", view !== "reset");
+      document.getElementById("authLinks").classList.toggle("hidden", view !== "login");
+      document.getElementById("backToLogin").classList.toggle("hidden", view === "login");
+      authTitle.textContent = view === "forgot" ? "Forgot Password"
+        : view === "reset" ? "Set New Password"
+        : (isRegisterMode ? "Create Account" : "Log In");
+    }
+
+    function showForgotForm() {
+      document.getElementById("forgotError").textContent = "";
+      document.getElementById("forgotNotice").classList.add("hidden");
+      setAuthView("forgot");
+      document.getElementById("forgotIdentifier").focus();
+    }
+
+    function showLoginForm(notice) {
+      resetToken = null;
+      if (isRegisterMode) toggleAuthMode();
+      setAuthView("login");
+      const n = document.getElementById("authNotice");
+      n.textContent = notice || "";
+      n.classList.toggle("hidden", !notice);
+    }
+
+    function showResetForm(token) {
+      resetToken = token;
+      showAuth();
+      document.getElementById("resetError").textContent = "";
+      setAuthView("reset");
+      document.getElementById("resetPassword1").focus();
+    }
+
+    function flash(message, isError) {
+      const el = document.getElementById("flashMsg");
+      el.textContent = message;
+      el.classList.toggle("error", !!isError);
+      el.classList.remove("hidden");
+      clearTimeout(flash.timer);
+      flash.timer = setTimeout(() => el.classList.add("hidden"), 6000);
+    }
+
+    async function postJson(url, body, method = "POST") {
+      const res = await fetch(url, {
+        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
+      });
+      let data = {};
+      try { data = await res.json(); } catch {}
+      return { ok: res.ok, status: res.status, data };
+    }
+
+    document.getElementById("forgotForm").addEventListener("submit", async (e) => {
+      e.preventDefault();
+      const btn = document.getElementById("forgotBtn");
+      const err = document.getElementById("forgotError");
+      const notice = document.getElementById("forgotNotice");
+      err.textContent = "";
+      notice.classList.add("hidden");
+      btn.disabled = true;
+      try {
+        const r = await postJson("/api/auth/forgot", { identifier: document.getElementById("forgotIdentifier").value.trim() });
+        if (r.ok) {
+          notice.textContent = r.data.message + " The link works for 30 minutes.";
+          notice.classList.remove("hidden");
+        } else {
+          err.textContent = r.data.error || "Something went wrong.";
+        }
+      } catch {
+        err.textContent = "Network error.";
+      } finally {
+        btn.disabled = false;
+      }
+    });
+
+    document.getElementById("resetForm").addEventListener("submit", async (e) => {
+      e.preventDefault();
+      const err = document.getElementById("resetError");
+      const p1 = document.getElementById("resetPassword1").value;
+      const p2 = document.getElementById("resetPassword2").value;
+      err.textContent = "";
+      if (p1 !== p2) { err.textContent = "Passwords don't match."; return; }
+      const btn = document.getElementById("resetBtn");
+      btn.disabled = true;
+      try {
+        const r = await postJson("/api/auth/reset", { token: resetToken, password: p1 });
+        if (r.ok) {
+          document.getElementById("resetForm").reset();
+          showLoginForm("Password updated, please log in.");
+        } else {
+          err.textContent = r.data.error || "Something went wrong.";
+        }
+      } catch {
+        err.textContent = "Network error.";
+      } finally {
+        btn.disabled = false;
+      }
+    });
+
+    async function confirmEmailLink(token) {
+      try {
+        const r = await postJson("/api/auth/verify-email", { token });
+        if (r.ok) flash("Email confirmed. Alerts and password resets will go to " + r.data.email + ".");
+        else flash(r.data.error || "That confirmation link didn't work.", true);
+      } catch {
+        flash("Network error while confirming your email.", true);
+      }
+    }
+
+    async function resendVerification() {
+      try {
+        const r = await postJson("/api/settings/resend-verification", {});
+        flash(r.ok ? "Confirmation link sent. Check your inbox." : (r.data.error || "Couldn't send the link."), !r.ok);
+      } catch {
+        flash("Network error.", true);
+      }
+    }
+
     function showAuth() {
       authScreen.classList.remove("hidden");
       dashboard.classList.add("hidden");
@@ -557,11 +755,13 @@
       dashboard.classList.remove("hidden");
       headerRight.classList.remove("hidden");
       headerUser.textContent = currentUser ? currentUser.username : "";
-      if (currentUser && !currentUser.notificationEmail) {
-        noEmailModal.classList.remove("hidden");
-      } else {
-        noEmailModal.classList.add("hidden");
-      }
+      const needsEmail = currentUser && !currentUser.notificationEmail;
+      const needsVerify = currentUser && currentUser.notificationEmail && !currentUser.emailVerified;
+      document.getElementById("emailModalTitle").textContent = needsVerify ? "Confirm Your Email" : "Email Required";
+      document.getElementById("emailModalText").textContent = needsVerify
+        ? "Check " + currentUser.notificationEmail + " for a confirmation link. Alerts and password resets wait until you confirm it."
+        : "An email address is needed for sending alerts to your inbox!";
+      noEmailModal.classList.toggle("hidden", !(needsEmail || needsVerify));
       hideAddForm();
       showWatchlistTab();
       loadAlerts();
@@ -577,6 +777,12 @@
       document.getElementById("settingsEmail").value = emailVal;
       document.getElementById("settingsError").textContent = "";
       document.getElementById("settingsSuccess").classList.add("hidden");
+      document.getElementById("emailPasswordGroup").classList.add("hidden");
+      document.getElementById("settingsEmailPassword").value = "";
+      document.getElementById("passwordForm").reset();
+      document.getElementById("pwError").textContent = "";
+      document.getElementById("pwSuccess").classList.add("hidden");
+      renderEmailStatus();
       if (emailVal) {
         document.getElementById("settingsEmail").readOnly = true;
         document.getElementById("editEmailBtn").classList.remove("hidden");
@@ -588,7 +794,22 @@
       }
     }
 
+    function renderEmailStatus() {
+      const status = document.getElementById("emailStatus");
+      const text = document.getElementById("emailStatusText");
+      if (currentUser && currentUser.pendingEmail) {
+        text.textContent = "Waiting for you to confirm " + currentUser.pendingEmail + ". Until then, emails go to your current address.";
+      } else if (currentUser && currentUser.notificationEmail && !currentUser.emailVerified) {
+        text.textContent = "Not confirmed yet. Check your inbox for the confirmation link.";
+      } else {
+        status.classList.add("hidden");
+        return;
+      }
+      status.classList.remove("hidden");
+    }
+
     function enableEmailEdit() {
+      document.getElementById("emailPasswordGroup").classList.remove("hidden");
       document.getElementById("settingsEmail").readOnly = false;
       document.getElementById("settingsEmail").focus();
       document.getElementById("editEmailBtn").classList.add("hidden");
@@ -606,7 +827,9 @@
       authError.textContent = "";
       const username = authUsername.value.trim();
       const password = authPassword.value;
-      if (!username || !password) return;
+      const email = document.getElementById("authEmail").value.trim();
+      if (!username || !password || (isRegisterMode && !email)) return;
+      document.getElementById("authNotice").classList.add("hidden");
 
       authBtn.disabled = true;
       authBtn.textContent = isRegisterMode ? "Registering..." : "Logging in...";
@@ -616,13 +839,14 @@
         const res = await fetch(endpoint, {
           method: "POST",
           headers: { "Content-Type": "application/json" },
-          body: JSON.stringify({ username, password }),
+          body: JSON.stringify(isRegisterMode ? { username, email, password } : { username, password }),
         });
         const data = await res.json();
         if (!res.ok) {
           authError.textContent = data.error || "Something went wrong.";
           return;
         }
+        if (isRegisterMode) flash("Account created. Check " + email + " for a confirmation link.");
         // Fetch full user profile (includes notificationEmail)
         const meRes = await fetch("/api/auth/me");
         currentUser = meRes.ok ? await meRes.json() : { id: data.id, username: data.username, notificationEmail: null };
@@ -675,17 +899,22 @@
       settingsBtn.disabled = true;
       settingsBtn.textContent = "Saving...";
       try {
+        const currentPassword = document.getElementById("settingsEmailPassword").value;
         const res = await fetch("/api/settings/email", {
           method: "PATCH",
           headers: { "Content-Type": "application/json" },
-          body: JSON.stringify({ email }),
+          body: JSON.stringify({ email, currentPassword }),
         });
         const data = await res.json();
         if (!res.ok) {
           settingsError.textContent = data.error || "Failed to save email.";
           return;
         }
-        currentUser.notificationEmail = email;
+        currentUser.pendingEmail = data.pendingEmail;
+        document.getElementById("settingsEmail").value = currentUser.notificationEmail || "";
+        document.getElementById("settingsEmailPassword").value = "";
+        document.getElementById("emailPasswordGroup").classList.add("hidden");
+        renderEmailStatus();
         settingsSuccess.classList.remove("hidden");
         document.getElementById("settingsEmail").readOnly = true;
         document.getElementById("editEmailBtn").classList.remove("hidden");
@@ -698,6 +927,34 @@
       }
     });
 
+    document.getElementById("passwordForm").addEventListener("submit", async (e) => {
+      e.preventDefault();
+      const err = document.getElementById("pwError");
+      const ok = document.getElementById("pwSuccess");
+      const btn = document.getElementById("pwBtn");
+      err.textContent = "";
+      ok.classList.add("hidden");
+      const currentPassword = document.getElementById("pwCurrent").value;
+      const newPassword = document.getElementById("pwNew1").value;
+      if (newPassword !== document.getElementById("pwNew2").value) { err.textContent = "New passwords don't match."; return; }
+      btn.disabled = true;
+      try {
+        const r = await postJson("/api/settings/password", { currentPassword, newPassword }, "PATCH");
+        if (r.ok) {
+          document.getElementById("passwordForm").reset();
+          ok.classList.remove("hidden");
+        } else if (r.status === 401) {
+          showAuth();
+        } else {
+          err.textContent = r.data.error || "Failed to change password.";
+        }
+      } catch {
+        err.textContent = "Network error.";
+      } finally {
+        btn.disabled = false;
+      }
+    });
+
     // ── Dashboard logic ──────────────────────────────────────────────────
 
     const alertsBody = document.getElementById("alertsBody");
@@ -1262,7 +1519,13 @@
 
     // ── Boot ──────────────────────────────────────────────────────────────
     updateSortArrows();
-    checkAuth();
+    (async function boot() {
+      const link = location.hash.match(/^#(reset|verify)=([A-Za-z0-9_-]+)$/);
+      if (link) history.replaceState(null, "", location.pathname + location.search);
+      if (link && link[1] === "reset") { showResetForm(link[2]); return; }   // opening never uses the link
+      if (link && link[1] === "verify") await confirmEmailLink(link[2]);
+      checkAuth();
+    })();
 
     // Auto-refresh prices every 60 seconds
     setInterval(() => {
```

- [ ] **Step 2: Check the script still parses.**
```bash
node -e "const h=require('fs').readFileSync('public/index.html','utf8');new Function(h.slice(h.lastIndexOf('<script>')+8,h.lastIndexOf('</script>')));console.log('ok')"
```
  Expected: `ok`.

- [ ] **Step 3: Start the server** against the test database, as in Task 4 Step 2, but on port 3000 with `APP_URL=http://localhost:3000`. Then open http://localhost:3000.

- [ ] **Step 4: Manual browser check.** Use throwaway test accounts in the test database; read links from the server log.
  1. **Register:** clicking **Register** shows Email plus the 15-character hint, and "Forgot password?" hides. A 14-character password shows the server's error. A valid signup shows the flash "Account created…" and then the **Confirm Your Email** modal.
  2. **Confirm:** open the logged `#verify=` link in the same browser. The flash says "Email confirmed…", the URL bar no longer shows the token, and the modal is gone.
  3. **Forgot:** log out, click **Forgot password?**, and enter the username. The generic message appears. Open the logged `#reset=` link **while logged in as a different test user** (Review Focus 3): the "Set New Password" form shows and the token is stripped from the URL.
  4. **Refresh:** reload; the normal app returns. Open the link again; it's still usable, because opening it didn't use it up (Review Focus 2).
  5. **Reset:** submit mismatched passwords ("Passwords don't match."), then a valid one. You land on the login screen with "Password updated, please log in." Submitting the same link again shows "expired or was already used".
  6. **Settings → Change Password:** a wrong current password shows an error; the right one shows "Password changed…" and you stay logged in.
  7. **Settings → Edit Email:** the current-password field appears. Saving shows "Check your new inbox…" and the status line "Waiting for you to confirm…". **Resend link** shows a flash. Confirming through the logged link switches the address.
  8. **Layout:** at 320px width and in dark theme, the forms and banner fit and stay readable.

- [ ] **Step 5: Commit.**
```bash
git add public/index.html
git commit -m "Add forgot/reset/verify flows and password settings to dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation and deployment settings

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none.

- [ ] **Step 1: Update CLAUDE.md.**
  - In **Commands**, add `npm run test:db   # opt-in DB guarantees for account recovery; needs TEST_DATABASE_URL (localhost only)`, and update the `npm test` comment to list the `account-recovery` suite.
  - Replace the body of **### Auth & sessions** with:
```markdown
`express-session` backed by Postgres (`connect-pg-simple`, same pool). `SESSION_SECRET` is required in production (throws at startup if missing) and falls back to a random per-process UUID otherwise. Username/password auth (`bcryptjs`, cost 10), no external provider. IP-based rate limiting for `/api/auth/*` and account settings (10 attempts / 15 min) lives in Postgres (`login_attempts`).

**Account recovery** (`src/services/account-recovery.ts` = pure logic with injected store/mailer; `src/services/account-store.ts` = Postgres transactions):
- New passwords: 15–64 chars and ≤72 UTF-8 bytes (bcrypt limit), checked by `validateNewPassword()` for register, reset and change; login accepts older shorter passwords.
- Email is the recovery credential, so it must be verified: `users.email_verified_at` (rows that existed at migration were grandfathered). Alert emails and reset links only go to verified addresses; an email change stays pending (old address active) until the new one is confirmed.
- One-time tokens in `account_tokens` (sha256 only; reset 30 min, verify 24 h); links use the URL fragment (`APP_URL/#reset=…`, `#verify=…`) so tokens never reach server logs. Lock order is always `users` row then token rows — keep it that way or concurrent resets deadlock.
- Revocation: `users.session_version` is bumped on reset/change; `requireAuth` rejects sessions whose `sv` differs (missing `sv` = 0).
- `APP_URL` must be set per Vercel environment (Production: https://wekintech.com). `DEV_LOG_EMAIL_LINKS=1` prints account emails to the console in local dev only.
```
  - In **Configuration**, add a bullet: `APP_URL` is the trusted base URL for email links (never derived from request headers); without it, reset and verification emails are not sent.

- [ ] **Step 2: Commit.**
```bash
git add CLAUDE.md
git commit -m "Document account recovery in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Deployment settings (the user does these in Vercel; Claude can guide).**
  - Add `APP_URL=https://wekintech.com` for **Production**.
  - Add `APP_URL` for **Preview** set to the branch preview URL (`https://stock-price-alerts-git-feat-acco…vercel.app`; copy the exact domain from the deployment).
  - Don't set `DEV_LOG_EMAIL_LINKS` anywhere on Vercel.

- [ ] **Step 4: Check on the preview.** After pushing, open the preview and run, with the user's own account:
  1. forgot password by username
  2. receive the real email
  3. reset
  4. confirm the "password changed" email arrives
  5. confirm another device was logged out

---

## Self-review notes

- **Spec coverage:**

| Spec section | Task |
|---|---|
| Decisions and password rule | 1 |
| Data | 2 |
| Concurrency | 2 |
| Session revocation | 1, 2, 4 |
| Throttling | 1, 2, 4 |
| Endpoints and CSRF | 4 |
| Service | 1 |
| Email | 3 |
| Alerts verified-only | 2 |
| Front end | 5 |
| Risks documented | 6 |
| Testing | 1, 2, 4, 5 |

- **Departures from the spec:**
  - **Session-row deletion** happens **after** the reset transaction, as best-effort cleanup (`deleteSessions`), rather than inside it. The real guarantee is the `session_version` bump, which *is* in the transaction. That way a missing `session` table (connect-pg-simple creates it lazily) can't fail a reset.
  - **The token claim** happens after locking the user row (a lookup without a lock, then a `FOR UPDATE` on the user, then the conditional `UPDATE` claim). Claiming first deadlocks with a concurrent change-password, which the database tests reproduced, so the order follows the plan's lock rule.
  - **File split:** the store lives in `src/services/account-store.ts` rather than inside `db.ts`, which is already 430 lines.
- **CLI unchanged:** `src/cli.ts` still creates users without an email and without the 15-character rule. It's an admin tool; noted here, not changed.
