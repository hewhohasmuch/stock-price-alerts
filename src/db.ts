import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { JSONFilePreset } from "lowdb/node";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { DbSchema, StockAlert, Settings, User } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DATA_DIR, "db.json");

// Ensure the data directory exists before lowdb tries to write
mkdirSync(DATA_DIR, { recursive: true });

const defaultSettings: Settings = {
  checkIntervalCron: "*/5 * * * *",
  cooldownMinutes: 60,
  notifyEmail: true,
  notifySms: true,
};

const defaultData: DbSchema = {
  users: [],
  alerts: [],
  settings: defaultSettings,
};

let dbInstance: Awaited<ReturnType<typeof JSONFilePreset<DbSchema>>> | null = null;

async function getDb() {
  if (!dbInstance) {
    dbInstance = await JSONFilePreset<DbSchema>(DB_PATH, defaultData);
    // Ensure users array exists for databases created before auth was added
    if (!dbInstance.data.users) {
      dbInstance.data.users = [];
      await dbInstance.write();
    }
  }
  return dbInstance;
}

// ── User functions ──────────────────────────────────────────────────────

export async function createUser(username: string, password: string): Promise<User> {
  const db = await getDb();
  const existing = db.data.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (existing) {
    throw new Error("Username already taken");
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user: User = {
    id: randomUUID().slice(0, 8),
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  db.data.users.push(user);
  await db.write();
  return user;
}

export async function verifyUser(username: string, password: string): Promise<User | null> {
  const db = await getDb();
  const user = db.data.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (!user) return null;
  const valid = await bcrypt.compare(password, user.passwordHash);
  return valid ? user : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const db = await getDb();
  return db.data.users.find((u) => u.id === id) ?? null;
}

export async function findUserByUsername(username: string): Promise<User | null> {
  const db = await getDb();
  return db.data.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  ) ?? null;
}

// ── Alert functions ─────────────────────────────────────────────────────

export async function addAlert(
  userId: string,
  symbol: string,
  name: string,
  abovePrice?: number,
  belowPrice?: number,
  notes?: string
): Promise<StockAlert> {
  const db = await getDb();
  const alert: StockAlert = {
    id: randomUUID().slice(0, 8),
    userId,
    symbol: symbol.toUpperCase(),
    name,
    abovePrice,
    belowPrice,
    notes,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  db.data.alerts.push(alert);
  await db.write();
  return alert;
}

export async function removeAlert(id: string, userId: string): Promise<boolean> {
  const db = await getDb();
  const idx = db.data.alerts.findIndex((a) => a.id === id && a.userId === userId);
  if (idx === -1) return false;
  db.data.alerts.splice(idx, 1);
  await db.write();
  return true;
}

export async function listAlerts(userId: string): Promise<StockAlert[]> {
  const db = await getDb();
  return db.data.alerts.filter((a) => a.userId === userId);
}

export async function getEnabledAlerts(): Promise<StockAlert[]> {
  const db = await getDb();
  return db.data.alerts.filter((a) => a.enabled);
}

export async function setAlertEnabled(id: string, userId: string, enabled: boolean): Promise<boolean> {
  const db = await getDb();
  const alert = db.data.alerts.find((a) => a.id === id && a.userId === userId);
  if (!alert) return false;
  alert.enabled = enabled;
  await db.write();
  return true;
}

export async function updateAlertNotes(id: string, userId: string, notes: string): Promise<boolean> {
  const db = await getDb();
  const alert = db.data.alerts.find((a) => a.id === id && a.userId === userId);
  if (!alert) return false;
  alert.notes = notes;
  await db.write();
  return true;
}

export async function updateAlertThresholds(
  id: string,
  userId: string,
  abovePrice: number | undefined,
  belowPrice: number | undefined
): Promise<boolean> {
  const db = await getDb();
  const alert = db.data.alerts.find((a) => a.id === id && a.userId === userId);
  if (!alert) return false;
  alert.abovePrice = abovePrice;
  alert.belowPrice = belowPrice;
  await db.write();
  return true;
}

export async function updateLastNotified(id: string): Promise<void> {
  const db = await getDb();
  const alert = db.data.alerts.find((a) => a.id === id);
  if (alert) {
    alert.lastNotifiedAt = new Date().toISOString();
    await db.write();
  }
}

export async function getSettings(): Promise<Settings> {
  const db = await getDb();
  return db.data.settings;
}
