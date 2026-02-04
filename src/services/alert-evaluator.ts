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

    if (isInCooldown(alert, cooldownMinutes, now)) continue;

    if (alert.abovePrice != null && priceData.price >= alert.abovePrice) {
      triggered.push({
        alert,
        currentPrice: priceData.price,
        direction: "above",
        threshold: alert.abovePrice,
      });
    } else if (alert.belowPrice != null && priceData.price <= alert.belowPrice) {
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

function isInCooldown(alert: StockAlert, cooldownMinutes: number, now: number): boolean {
  if (!alert.lastNotifiedAt) return false;
  const elapsed = now - new Date(alert.lastNotifiedAt).getTime();
  return elapsed < cooldownMinutes * 60 * 1000;
}
