import type { StockAlert, PriceResult, TriggeredAlert } from "../types.js";

export function evaluateAlerts(
  alerts: StockAlert[],
  prices: PriceResult[],
): TriggeredAlert[] {
  const priceMap = new Map(prices.map((p) => [p.symbol, p]));
  const triggered: TriggeredAlert[] = [];

  for (const alert of alerts) {
    const priceData = priceMap.get(alert.symbol);
    if (!priceData) continue;

    if (alert.abovePrice != null && priceData.price >= alert.abovePrice &&
        !hasBreachedToday(alert, "above")) {
      triggered.push({
        alert,
        currentPrice: priceData.price,
        direction: "above",
        threshold: alert.abovePrice,
      });
    }

    if (alert.belowPrice != null && priceData.price <= alert.belowPrice &&
        !hasBreachedToday(alert, "below")) {
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

function hasBreachedToday(alert: StockAlert, direction: "above" | "below"): boolean {
  const ts = direction === "above" ? alert.lastNotifiedAboveAt : alert.lastNotifiedBelowAt;
  if (!ts) return false;
  return new Date(ts).toDateString() === new Date().toDateString();
}
