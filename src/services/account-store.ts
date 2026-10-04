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
        const perAddress = await c.query(
          `SELECT count(*)::int AS n FROM account_tokens
           WHERE LOWER(email) = LOWER($1) AND purpose = $2 AND created_at > now() - INTERVAL '1 hour'`,
          [a.email, a.purpose]);
        if (perAddress.rows[0].n >= a.maxPerAddressPerHour) return false;
        // Not locked across users, so concurrent requests can overshoot by a few; it's a safety valve.
        const global = await c.query(
          `SELECT count(*)::int AS n FROM account_tokens WHERE created_at > now() - INTERVAL '24 hours'`);
        if (global.rows[0].n >= a.maxGlobalPerDay) return false;
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
                    AND LOWER(t.email) <> LOWER(COALESCE(u.notification_email, ''))
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
