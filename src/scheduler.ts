import cron from "node-cron";
import { config, isEmailConfigured, isSmsConfigured } from "./config.js";
import { getEnabledAlerts, saveAlertState } from "./db.js";
import { fetchPrices } from "./services/price-fetcher.js";
import { evaluateAlerts } from "./services/alert-evaluator.js";
import { notify } from "./services/notifier.js";
import type { NotifyResult } from "./services/notifier.js";
import { isMarketOpen } from "./utils/market-hours.js";

export interface CheckResult {
  alertCount: number;
  priceCount: number;
  triggeredCount: number;
  notifications: NotifyResult[];
}

export async function checkPrices(): Promise<CheckResult> {
  const alerts = await getEnabledAlerts();
  if (alerts.length === 0) {
    console.log(`[${timestamp()}] No enabled alerts.`);
    return { alertCount: 0, priceCount: 0, triggeredCount: 0, notifications: [] };
  }

  const symbols = [...new Set(alerts.map((a) => a.symbol))];
  console.log(`[${timestamp()}] Checking ${symbols.length} symbol(s): ${symbols.join(", ")}`);

  let prices;
  try {
    prices = await fetchPrices(symbols);
  } catch (err) {
    console.error(`[${timestamp()}] Failed to fetch prices:`, (err as Error).message);
    return { alertCount: alerts.length, priceCount: 0, triggeredCount: 0, notifications: [] };
  }

  for (const p of prices) {
    console.log(`  ${p.symbol}: $${p.price.toFixed(2)}`);
  }

  const { triggered, stateUpdates } = evaluateAlerts(alerts, prices);

  // Persist evaluator state (e.g. trailing high-water mark) even when
  // nothing triggered, so the ratchet survives across runs.
  for (const alert of stateUpdates) {
    if (!alert.state) continue;
    try {
      await saveAlertState(alert.id, alert.state);
    } catch (err) {
      console.error(`  Failed to save state for alert ${alert.id}:`, (err as Error).message);
    }
  }

  if (triggered.length === 0) {
    console.log(`  No thresholds crossed.`);
    return { alertCount: alerts.length, priceCount: prices.length, triggeredCount: 0, notifications: [] };
  }

  const notifications = await notify(triggered);
  return { alertCount: alerts.length, priceCount: prices.length, triggeredCount: triggered.length, notifications };
}

function timestamp(): string {
  return new Date().toLocaleTimeString();
}

export function startScheduler(): void {
  console.log("Stock Price Alert Scheduler");
  console.log("==========================");
  console.log(`Schedule: ${config.checkIntervalCron}`);
  console.log(`Email:    ${isEmailConfigured() ? "configured" : "not configured"}`);
  console.log(`SMS:      ${isSmsConfigured() ? "configured" : "not configured"}`);
  console.log();

  // Run immediately on start
  checkPrices();

  // Then schedule recurring checks
  cron.schedule(config.checkIntervalCron, async () => {
    if (!await isMarketOpen()) {
      console.log(`[${timestamp()}] Market closed — skipping price check.`);
      return;
    }
    checkPrices();
  });

  console.log("Scheduler running.\n");
}

// Allow standalone execution: npx tsx src/scheduler.ts
const isDirectRun = process.argv[1]?.includes("scheduler");
if (isDirectRun) {
  const { initDb } = await import("./db.js");
  await initDb();
  startScheduler();
}
