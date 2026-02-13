import { describe, it, expect } from "vitest";
import { evaluateAlerts } from "../src/services/alert-evaluator.js";
import type { StockAlert, PriceResult } from "../src/types.js";

function makeAlert(overrides: Partial<StockAlert> = {}): StockAlert {
  return {
    id: "test-id",
    userId: "user1",
    symbol: "AAPL",
    name: "Apple Inc.",
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("evaluateAlerts", () => {
  const prices: PriceResult[] = [
    { symbol: "AAPL", price: 200, name: "Apple Inc." },
    { symbol: "MSFT", price: 400, name: "Microsoft Corp." },
  ];

  it("triggers above alert when price >= threshold", () => {
    const alerts = [makeAlert({ abovePrice: 190 })];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("above");
    expect(result[0].currentPrice).toBe(200);
    expect(result[0].threshold).toBe(190);
  });

  it("triggers below alert when price <= threshold", () => {
    const alerts = [makeAlert({ belowPrice: 210 })];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("below");
    expect(result[0].threshold).toBe(210);
  });

  it("does not trigger when price is between thresholds", () => {
    const alerts = [makeAlert({ abovePrice: 250, belowPrice: 150 })];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(0);
  });

  it("skips alert if symbol has no price data", () => {
    const alerts = [makeAlert({ symbol: "TSLA", abovePrice: 100 })];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(0);
  });

  it("skips above alert in above cooldown", () => {
    const alerts = [
      makeAlert({
        abovePrice: 190,
        lastNotifiedAboveAt: new Date().toISOString(),
      }),
    ];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(0);
  });

  it("skips below alert in below cooldown", () => {
    const alerts = [
      makeAlert({
        belowPrice: 210,
        lastNotifiedBelowAt: new Date().toISOString(),
      }),
    ];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(0);
  });

  it("triggers alert past cooldown", () => {
    const pastCooldown = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    const alerts = [makeAlert({ abovePrice: 190, lastNotifiedAboveAt: pastCooldown })];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(1);
  });

  it("above cooldown does not block below alert", () => {
    const alerts = [
      makeAlert({
        abovePrice: 190,
        belowPrice: 210,
        lastNotifiedAboveAt: new Date().toISOString(), // above in cooldown
      }),
    ];
    const result = evaluateAlerts(alerts, prices, 60);
    // above is blocked by cooldown, but below should still trigger
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("below");
  });

  it("below cooldown does not block above alert", () => {
    const alerts = [
      makeAlert({
        abovePrice: 190,
        belowPrice: 210,
        lastNotifiedBelowAt: new Date().toISOString(), // below in cooldown
      }),
    ];
    const result = evaluateAlerts(alerts, prices, 60);
    // below is blocked by cooldown, but above should still trigger
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("above");
  });

  it("triggers exact price match for above", () => {
    const alerts = [makeAlert({ abovePrice: 200 })];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("above");
  });

  it("triggers exact price match for below", () => {
    const alerts = [makeAlert({ belowPrice: 200 })];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe("below");
  });

  it("handles multiple alerts for different symbols", () => {
    const alerts = [
      makeAlert({ id: "a1", symbol: "AAPL", abovePrice: 190 }),
      makeAlert({ id: "a2", symbol: "MSFT", belowPrice: 410 }),
    ];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no alerts provided", () => {
    const result = evaluateAlerts([], prices, 60);
    expect(result).toHaveLength(0);
  });

  it("returns empty array when no prices provided", () => {
    const alerts = [makeAlert({ abovePrice: 190 })];
    const result = evaluateAlerts(alerts, [], 60);
    expect(result).toHaveLength(0);
  });

  it("triggers both above and below when both match", () => {
    // price is 200, above=200, below=200: both should trigger independently
    const alerts = [makeAlert({ abovePrice: 200, belowPrice: 200 })];
    const result = evaluateAlerts(alerts, prices, 60);
    expect(result).toHaveLength(2);
    expect(result[0].direction).toBe("above");
    expect(result[1].direction).toBe("below");
  });
});
