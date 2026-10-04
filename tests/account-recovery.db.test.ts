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

  it("keeps separate per-address budgets for verify and reset emails", async () => {
    const id = await verifiedUser();
    const { rows } = await pool.query(`SELECT username, notification_email FROM users WHERE id = $1`, [id]);
    // Five other accounts flood this address with confirmation emails…
    for (let i = 0; i < 5; i++) {
      const other = await db.createUser(`zz_ar_${process.pid}_flood${++n}`, "old-password", rows[0].notification_email);
      await svc.requestEmailVerification(other.id, rows[0].notification_email);
    }
    links.length = 0;
    // …but the owner can still get a reset link.
    await svc.requestReset(rows[0].username);
    expect(links).toHaveLength(1);
  });

  it("enforces the global daily cap in the store", async () => {
    const id = await verifiedUser();
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM account_tokens WHERE created_at > now() - INTERVAL '24 hours'`);
    const issued = await store.issueToken({
      userId: id, purpose: "reset", email: "cap@example.test", tokenHash: hashToken("cap-" + id), ttlMinutes: 30,
      maxPerAccountPerHour: 3, maxPerAddressPerHour: 5, maxGlobalPerDay: rows[0].n,
    });
    expect(issued).toBe(false);
  });

  it("does not report a new user's own unconfirmed address as a pending change", async () => {
    const u = await db.createUser(`zz_ar_${process.pid}_newbie`, "old-password", "newbie@example.test");
    await svc.requestEmailVerification(u.id, "newbie@example.test");
    expect(await store.getAccountStatus(u.id)).toEqual({ emailVerified: false, pendingEmail: null });
  });

  it("reports a pending email change", async () => {
    const id = await verifiedUser();
    await svc.requestEmailVerification(id, `pending_${id}@example.test`);
    expect(await store.getAccountStatus(id)).toEqual({ emailVerified: true, pendingEmail: `pending_${id}@example.test` });
  });
});
