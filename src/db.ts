import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSONFilePreset } from "lowdb/node";
import { randomUUID } from "node:crypto";
import type { DbSchema, StockAlert, Settings } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "db.json");

const defaultSettings: Settings = {
  checkIntervalCron: "*/5 * * * *",
  cooldownMinutes: 60,
  notifyEmail: true,
  notifySms: true,
};

const defaultData: DbSchema = {
  alerts: [],
  settings: defaultSettings,
};

let dbInstance: Awaited<ReturnType<typeof JSONFilePreset<DbSchema>>> | null = null;

async function getDb() {
  if (!dbInstance) {
    dbInstance = await JSONFilePreset<DbSchema>(DB_PATH, defaultData);
  }
  return dbInstance;
}

export async function addAlert(
  symbol: string,
  name: string,
  abovePrice?: number,
  belowPrice?: number,
  notes?: string
): Promise<StockAlert> {
  const db = await getDb();
  const alert: StockAlert = {
    id: randomUUID().slice(0, 8),
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

export async function removeAlert(id: string): Promise<boolean> {
  const db = await getDb();
  const idx = db.data.alerts.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  db.data.alerts.splice(idx, 1);
  await db.write();
  return true;
}

export async function listAlerts(): Promise<StockAlert[]> {
  const db = await getDb();
  return db.data.alerts;
}

export async function getEnabledAlerts(): Promise<StockAlert[]> {
  const db = await getDb();
  return db.data.alerts.filter((a) => a.enabled);
}

export async function setAlertEnabled(id: string, enabled: boolean): Promise<boolean> {
  const db = await getDb();
  const alert = db.data.alerts.find((a) => a.id === id);
  if (!alert) return false;
  alert.enabled = enabled;
  await db.write();
  return true;
}

export async function updateAlertNotes(id: string, notes: string): Promise<boolean> {
  const db = await getDb();
  const alert = db.data.alerts.find((a) => a.id === id);
  if (!alert) return false;
  alert.notes = notes;
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
