import type { StockAlert, PriceResult, TriggeredAlert } from "../types.js";

export function evaluateAlerts(
  alerts: StockAlert[],
  prices: PriceResult[],
  cooldownMinutes: number
): TriggeredAlert[] {
  const priceMap = new Map(prices.map((p) => [p.symbol, p]));
  const triggered: TriggeredAlert[] = [];
  const now = Date.now();

  for (const alert of alerts) {
    const priceData = priceMap.get(alert.symbol);
    if (!priceData) continue;

    if (alert.abovePrice != null && priceData.price >= alert.abovePrice &&
        !isInCooldown(alert, "above", cooldownMinutes, now)) {
      triggered.push({
        alert,
        currentPrice: priceData.price,
        direction: "above",
        threshold: alert.abovePrice,
      });
    }

    if (alert.belowPrice != null && priceData.price <= alert.belowPrice &&
        !isInCooldown(alert, "below", cooldownMinutes, now)) {
      triggered.push({
        alert,
        currentPrice: priceData.price,
        direction: "below",
        threshold: alert.belowPrice,
      });
    }
  }

  return triggered;
}

function isInCooldown(alert: StockAlert, direction: "above" | "below", cooldownMinutes: number, now: number): boolean {
  const timestamp = direction === "above" ? alert.lastNotifiedAboveAt : alert.lastNotifiedBelowAt;
  if (!timestamp) return false;
  const elapsed = now - new Date(timestamp).getTime();
  return elapsed < cooldownMinutes * 60 * 1000;
}
