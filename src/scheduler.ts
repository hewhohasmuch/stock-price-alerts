import cron from "node-cron";
import { config, isEmailConfigured, isSmsConfigured } from "./config.js";
import { getEnabledAlerts } from "./db.js";
import { fetchPrices } from "./services/price-fetcher.js";
import { evaluateAlerts } from "./services/alert-evaluator.js";
import { notify } from "./services/notifier.js";

async function checkPrices(): Promise<void> {
  const alerts = await getEnabledAlerts();
  if (alerts.length === 0) {
    console.log(`[${timestamp()}] No enabled alerts. Add some with: npx tsx src/cli.ts add <SYMBOL> --above <price>`);
    return;
  }

  const symbols = [...new Set(alerts.map((a) => a.symbol))];
  console.log(`[${timestamp()}] Checking ${symbols.length} symbol(s): ${symbols.join(", ")}`);

  let prices;
  try {
    prices = await fetchPrices(symbols);
  } catch (err) {
    console.error(`[${timestamp()}] Failed to fetch prices:`, (err as Error).message);
    return;
  }

  for (const p of prices) {
    console.log(`  ${p.symbol}: $${p.price.toFixed(2)}`);
  }

  const triggered = evaluateAlerts(alerts, prices, config.cooldownMinutes);

  if (triggered.length === 0) {
    console.log(`  No thresholds crossed.`);
    return;
  }

  await notify(triggered);
}

function timestamp(): string {
  return new Date().toLocaleTimeString();
}

export function startScheduler(): void {
  console.log("Stock Price Alert Scheduler");
  console.log("==========================");
  console.log(`Schedule: ${config.checkIntervalCron}`);
  console.log(`Cooldown: ${config.cooldownMinutes} minutes`);
  console.log(`Email:    ${isEmailConfigured() ? "configured" : "not configured"}`);
  console.log(`SMS:      ${isSmsConfigured() ? "configured" : "not configured"}`);
  console.log();

  // Run immediately on start
  checkPrices();

  // Then schedule recurring checks
  cron.schedule(config.checkIntervalCron, () => {
    checkPrices();
  });

  console.log("Scheduler running.\n");
}

// Allow standalone execution: npx tsx src/scheduler.ts
const isDirectRun = process.argv[1]?.includes("scheduler");
if (isDirectRun) {
  startScheduler();
}
