import { Command } from "commander";
import { addAlert, removeAlert, listAlerts, setAlertEnabled } from "./db.js";
import { fetchSinglePrice } from "./services/price-fetcher.js";

const program = new Command();

program
  .name("stock-alerts")
  .description("Monitor stock prices and get alerts when they cross thresholds");

program
  .command("add <symbol>")
  .description("Add a stock price alert")
  .option("--above <price>", "Alert when price goes above this value")
  .option("--below <price>", "Alert when price goes below this value")
  .action(async (symbol: string, opts: { above?: string; below?: string }) => {
    const above = opts.above ? parseFloat(opts.above) : undefined;
    const below = opts.below ? parseFloat(opts.below) : undefined;

    if (above == null && below == null) {
      console.error("Error: Provide at least one of --above or --below");
      process.exit(1);
    }

    console.log(`Fetching current price for ${symbol.toUpperCase()}...`);

    let name = symbol.toUpperCase();
    try {
      const priceData = await fetchSinglePrice(symbol.toUpperCase());
      if (priceData) {
        name = priceData.name;
        console.log(`  Current price: $${priceData.price.toFixed(2)} (${name})`);
      } else {
        console.warn(`  Warning: Could not fetch price for ${symbol}. Adding alert anyway.`);
      }
    } catch {
      console.warn(`  Warning: Could not fetch price for ${symbol}. Adding alert anyway.`);
    }

    const alert = await addAlert(name === symbol.toUpperCase() ? symbol.toUpperCase() : symbol.toUpperCase(), name, above, below);

    console.log(`\nAlert added:`);
    console.log(`  ID:     ${alert.id}`);
    console.log(`  Symbol: ${alert.symbol}`);
    console.log(`  Name:   ${alert.name}`);
    if (above != null) console.log(`  Above:  $${above}`);
    if (below != null) console.log(`  Below:  $${below}`);
  });

program
  .command("remove <id>")
  .description("Remove a stock price alert")
  .action(async (id: string) => {
    const removed = await removeAlert(id);
    if (removed) {
      console.log(`Alert ${id} removed.`);
    } else {
      console.error(`Alert ${id} not found.`);
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List all stock price alerts")
  .action(async () => {
    const alerts = await listAlerts();
    if (alerts.length === 0) {
      console.log("No alerts configured. Use 'add' to create one.");
      return;
    }

    console.log(`\n${"ID".padEnd(10)} ${"Symbol".padEnd(8)} ${"Name".padEnd(25)} ${"Above".padEnd(10)} ${"Below".padEnd(10)} ${"Enabled".padEnd(8)} Last Notified`);
    console.log("-".repeat(95));

    for (const a of alerts) {
      const above = a.abovePrice != null ? `$${a.abovePrice}` : "-";
      const below = a.belowPrice != null ? `$${a.belowPrice}` : "-";
      const enabled = a.enabled ? "Yes" : "No";
      const lastNotified = a.lastNotifiedAt
        ? new Date(a.lastNotifiedAt).toLocaleString()
        : "Never";

      console.log(
        `${a.id.padEnd(10)} ${a.symbol.padEnd(8)} ${a.name.slice(0, 24).padEnd(25)} ${above.padEnd(10)} ${below.padEnd(10)} ${enabled.padEnd(8)} ${lastNotified}`
      );
    }
    console.log();
  });

program
  .command("enable <id>")
  .description("Enable a stock price alert")
  .action(async (id: string) => {
    const ok = await setAlertEnabled(id, true);
    if (ok) {
      console.log(`Alert ${id} enabled.`);
    } else {
      console.error(`Alert ${id} not found.`);
      process.exit(1);
    }
  });

program
  .command("disable <id>")
  .description("Disable a stock price alert")
  .action(async (id: string) => {
    const ok = await setAlertEnabled(id, false);
    if (ok) {
      console.log(`Alert ${id} disabled.`);
    } else {
      console.error(`Alert ${id} not found.`);
      process.exit(1);
    }
  });

program.parse();
