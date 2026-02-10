import pg from "pg";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import type { StockAlert, Settings, User } from "./types.js";

const isLocal = config.databaseUrl.includes("localhost");
const dbUrl = !isLocal && !config.databaseUrl.includes("sslmode=")
  ? config.databaseUrl + (config.databaseUrl.includes("?") ? "&" : "?") + "sslmode=require"
  : config.databaseUrl;

const pool = new pg.Pool({
  connectionString: dbUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

// ── Schema initialization ────────────────────────────────────────────────

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS login_attempts (
      ip             TEXT PRIMARY KEY,
      attempt_count  INTEGER NOT NULL DEFAULT 1,
      window_start   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol          TEXT NOT NULL,
      name            TEXT NOT NULL,
      above_price     DOUBLE PRECISION,
      below_price     DOUBLE PRECISION,
      notes           TEXT,
      enabled         BOOLEAN NOT NULL DEFAULT true,
      last_notified_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ── Rate limiting ───────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 10;

export async function checkRateLimit(ip: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);

  // Upsert: reset if window expired, otherwise increment
  const { rows } = await pool.query(
    `INSERT INTO login_attempts (ip, attempt_count, window_start)
     VALUES ($1, 1, now())
     ON CONFLICT (ip) DO UPDATE SET
       attempt_count = CASE
         WHEN login_attempts.window_start < $2 THEN 1
         ELSE login_attempts.attempt_count + 1
       END,
       window_start = CASE
         WHEN login_attempts.window_start < $2 THEN now()
         ELSE login_attempts.window_start
       END
     RETURNING attempt_count, window_start`,
    [ip, windowStart],
  );

  const row = rows[0];
  if (row.attempt_count > RATE_LIMIT_MAX) {
    const windowEnd = new Date(row.window_start).getTime() + RATE_LIMIT_WINDOW_MS;
    const retryAfterSeconds = Math.ceil((windowEnd - Date.now()) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
  }

  return { allowed: true };
}

// ── User functions ──────────────────────────────────────────────────────

export async function createUser(username: string, password: string): Promise<User> {
  const id = randomUUID().slice(0, 8);
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (id, username, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, password_hash AS "passwordHash", created_at AS "createdAt"`,
      [id, username, passwordHash],
    );
    return { ...rows[0], createdAt: rows[0].createdAt.toISOString() };
  } catch (err: any) {
    if (err.code === "23505") throw new Error("Username already taken");
    throw err;
  }
}

export async function verifyUser(username: string, password: string): Promise<User | null> {
  const { rows } = await pool.query(
    `SELECT id, username, password_hash AS "passwordHash", created_at AS "createdAt"
     FROM users WHERE LOWER(username) = LOWER($1)`,
    [username],
  );
  if (rows.length === 0) return null;
  const user = rows[0];
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;
  return { ...user, createdAt: user.createdAt.toISOString() };
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await pool.query(
    `SELECT id, username, password_hash AS "passwordHash", created_at AS "createdAt"
     FROM users WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  return { ...rows[0], createdAt: rows[0].createdAt.toISOString() };
}

export async function findUserByUsername(username: string): Promise<User | null> {
  const { rows } = await pool.query(
    `SELECT id, username, password_hash AS "passwordHash", created_at AS "createdAt"
     FROM users WHERE LOWER(username) = LOWER($1)`,
    [username],
  );
  if (rows.length === 0) return null;
  return { ...rows[0], createdAt: rows[0].createdAt.toISOString() };
}

// ── Alert functions ─────────────────────────────────────────────────────

function rowToAlert(row: any): StockAlert {
  return {
    id: row.id,
    userId: row.userId,
    symbol: row.symbol,
    name: row.name,
    abovePrice: row.abovePrice ?? undefined,
    belowPrice: row.belowPrice ?? undefined,
    notes: row.notes ?? undefined,
    enabled: row.enabled,
    lastNotifiedAt: row.lastNotifiedAt ? row.lastNotifiedAt.toISOString() : undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

const ALERT_COLUMNS = `
  id, user_id AS "userId", symbol, name,
  above_price AS "abovePrice", below_price AS "belowPrice",
  notes, enabled, last_notified_at AS "lastNotifiedAt",
  created_at AS "createdAt"
`;

export async function addAlert(
  userId: string,
  symbol: string,
  name: string,
  abovePrice?: number,
  belowPrice?: number,
  notes?: string,
): Promise<StockAlert> {
  const id = randomUUID().slice(0, 8);
  const { rows } = await pool.query(
    `INSERT INTO alerts (id, user_id, symbol, name, above_price, below_price, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${ALERT_COLUMNS}`,
    [id, userId, symbol.toUpperCase(), name, abovePrice ?? null, belowPrice ?? null, notes ?? null],
  );
  return rowToAlert(rows[0]);
}

export async function removeAlert(id: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM alerts WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function listAlerts(userId: string): Promise<StockAlert[]> {
  const { rows } = await pool.query(
    `SELECT ${ALERT_COLUMNS} FROM alerts WHERE user_id = $1`,
    [userId],
  );
  return rows.map(rowToAlert);
}

export async function getEnabledAlerts(): Promise<StockAlert[]> {
  const { rows } = await pool.query(
    `SELECT ${ALERT_COLUMNS} FROM alerts WHERE enabled = true`,
  );
  return rows.map(rowToAlert);
}

export async function setAlertEnabled(id: string, userId: string, enabled: boolean): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE alerts SET enabled = $1 WHERE id = $2 AND user_id = $3`,
    [enabled, id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function updateAlertNotes(id: string, userId: string, notes: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE alerts SET notes = $1 WHERE id = $2 AND user_id = $3`,
    [notes, id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function updateAlertThresholds(
  id: string,
  userId: string,
  abovePrice: number | undefined,
  belowPrice: number | undefined,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE alerts SET above_price = $1, below_price = $2 WHERE id = $3 AND user_id = $4`,
    [abovePrice ?? null, belowPrice ?? null, id, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function updateLastNotified(id: string): Promise<void> {
  await pool.query(
    `UPDATE alerts SET last_notified_at = now() WHERE id = $1`,
    [id],
  );
}

export async function getSettings(): Promise<Settings> {
  return {
    checkIntervalCron: config.checkIntervalCron,
    cooldownMinutes: config.cooldownMinutes,
    notifyEmail: true,
    notifySms: true,
  };
}

export { pool };
