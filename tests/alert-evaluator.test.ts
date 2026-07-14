import { describe, it, expect } from "vitest";
import { evaluateAlerts } from "../src/services/alert-evaluator.js";
import type { StockAlert, PriceResult, TrailingHighState } from "../src/types.js";

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

function yesterday(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

const prices: PriceResult[] = [
  { symbol: "AAPL", price: 200, name: "Apple Inc.", previousClose: 190 },
  { symbol: "MSFT", price: 400, name: "Microsoft Corp.", previousClose: 410 },
];

describe("evaluateAlerts — absolute threshold (legacy)", () => {
  it("triggers above alert when price >= threshold", () => {
    const alerts = [makeAlert({ abovePrice: 190 })];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].direction).toBe("above");
    expect(triggered[0].currentPrice).toBe(200);
    expect(triggered[0].threshold).toBe(190);
  });

  it("triggers below alert when price <= threshold", () => {
    const alerts = [makeAlert({ belowPrice: 210 })];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].direction).toBe("below");
    expect(triggered[0].threshold).toBe(210);
  });

  it("does not trigger when price is between thresholds", () => {
    const alerts = [makeAlert({ abovePrice: 250, belowPrice: 150 })];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(0);
  });

  it("skips alert if symbol has no price data", () => {
    const alerts = [makeAlert({ symbol: "TSLA", abovePrice: 100 })];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(0);
  });

  it("skips above alert already notified today", () => {
    const alerts = [
      makeAlert({ abovePrice: 190, lastNotifiedAboveAt: new Date().toISOString() }),
    ];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(0);
  });

  it("skips below alert already notified today", () => {
    const alerts = [
      makeAlert({ belowPrice: 210, lastNotifiedBelowAt: new Date().toISOString() }),
    ];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(0);
  });

  it("triggers again when last notification was on a previous day", () => {
    const alerts = [makeAlert({ abovePrice: 190, lastNotifiedAboveAt: yesterday() })];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(1);
  });

  it("above cooldown does not block below alert", () => {
    const alerts = [
      makeAlert({
        abovePrice: 190,
        belowPrice: 210,
        lastNotifiedAboveAt: new Date().toISOString(),
      }),
    ];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].direction).toBe("below");
  });

  it("below cooldown does not block above alert", () => {
    const alerts = [
      makeAlert({
        abovePrice: 190,
        belowPrice: 210,
        lastNotifiedBelowAt: new Date().toISOString(),
      }),
    ];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].direction).toBe("above");
  });

  it("triggers exact price match for above and below", () => {
    const above = evaluateAlerts([makeAlert({ abovePrice: 200 })], prices);
    expect(above.triggered).toHaveLength(1);
    expect(above.triggered[0].direction).toBe("above");

    const below = evaluateAlerts([makeAlert({ belowPrice: 200 })], prices);
    expect(below.triggered).toHaveLength(1);
    expect(below.triggered[0].direction).toBe("below");
  });

  it("handles multiple alerts for different symbols", () => {
    const alerts = [
      makeAlert({ id: "a1", symbol: "AAPL", abovePrice: 190 }),
      makeAlert({ id: "a2", symbol: "MSFT", belowPrice: 410 }),
    ];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(2);
  });

  it("returns empty results when no alerts or no prices provided", () => {
    expect(evaluateAlerts([], prices).triggered).toHaveLength(0);
    expect(evaluateAlerts([makeAlert({ abovePrice: 190 })], []).triggered).toHaveLength(0);
  });

  it("triggers both above and below when both match", () => {
    const alerts = [makeAlert({ abovePrice: 200, belowPrice: 200 })];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(2);
    expect(triggered[0].direction).toBe("above");
    expect(triggered[1].direction).toBe("below");
  });

  it("never reports state updates for stateless legacy alerts", () => {
    const alerts = [makeAlert({ abovePrice: 190 })];
    const { stateUpdates } = evaluateAlerts(alerts, prices);
    expect(stateUpdates).toHaveLength(0);
  });
});

describe("evaluateAlerts — percent-change", () => {
  function pcAlert(percent: number, direction: "up" | "down" | "either", overrides: Partial<StockAlert> = {}): StockAlert {
    return makeAlert({
      alertType: "percent-change",
      params: { percent, direction },
      ...overrides,
    });
  }

  // AAPL: 190 -> 200 is +5.26%; MSFT: 410 -> 400 is -2.44%

  it("triggers 'up' when gain exceeds percent", () => {
    const { triggered } = evaluateAlerts([pcAlert(5, "up")], prices);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].message).toContain("AAPL is up 5.3% today");
    expect(triggered[0].message).toContain("$190.00 → $200.00");
  });

  it("does not trigger 'up' when gain is below percent", () => {
    const { triggered } = evaluateAlerts([pcAlert(6, "up")], prices);
    expect(triggered).toHaveLength(0);
  });

  it("does not trigger 'down' on a gain", () => {
    const { triggered } = evaluateAlerts([pcAlert(5, "down")], prices);
    expect(triggered).toHaveLength(0);
  });

  it("triggers 'down' when loss exceeds percent", () => {
    const { triggered } = evaluateAlerts([pcAlert(2, "down", { symbol: "MSFT" })], prices);
    expect(triggered).toHaveLength(1);
    expect(triggered[0].message).toContain("MSFT is down 2.4% today");
  });

  it("triggers 'either' on moves in both directions", () => {
    const up = evaluateAlerts([pcAlert(5, "either")], prices);
    expect(up.triggered).toHaveLength(1);
    const down = evaluateAlerts([pcAlert(2, "either", { symbol: "MSFT" })], prices);
    expect(down.triggered).toHaveLength(1);
  });

  it("does not trigger with missing or zero previous close", () => {
    const badPrices: PriceResult[] = [
      { symbol: "AAPL", price: 200, name: "Apple Inc." },
      { symbol: "MSFT", price: 400, name: "Microsoft Corp.", previousClose: 0 },
    ];
    const alerts = [pcAlert(1, "either"), pcAlert(1, "either", { symbol: "MSFT" })];
    const { triggered } = evaluateAlerts(alerts, badPrices);
    expect(triggered).toHaveLength(0);
  });

  it("does not trigger again the same day", () => {
    const { triggered } = evaluateAlerts(
      [pcAlert(5, "up", { lastTriggeredAt: new Date().toISOString() })],
      prices,
    );
    expect(triggered).toHaveLength(0);
  });

  it("triggers again on a new day", () => {
    const { triggered } = evaluateAlerts(
      [pcAlert(5, "up", { lastTriggeredAt: yesterday() })],
      prices,
    );
    expect(triggered).toHaveLength(1);
  });

  it("ignores invalid params", () => {
    const alerts = [
      makeAlert({ alertType: "percent-change", params: undefined }),
      pcAlert(0, "up"),
      pcAlert(-5, "either"),
    ];
    const { triggered } = evaluateAlerts(alerts, prices);
    expect(triggered).toHaveLength(0);
  });
});

describe("evaluateAlerts — trailing-high", () => {
  function thAlert(percent: number, state?: TrailingHighState, overrides: Partial<StockAlert> = {}): StockAlert {
    return makeAlert({
      alertType: "trailing-high",
      params: { percent },
      state,
      ...overrides,
    });
  }

  function priceAt(price: number): PriceResult[] {
    return [{ symbol: "AAPL", price, name: "Apple Inc.", previousClose: price }];
  }

  it("seeds the high-water mark on first run without triggering", () => {
    const alert = thAlert(10);
    const { triggered, stateUpdates } = evaluateAlerts([alert], priceAt(200));
    expect(triggered).toHaveLength(0);
    expect(stateUpdates).toHaveLength(1);
    expect(alert.state?.highWaterMark).toBe(200);
    expect(alert.state?.highSetUtc).toBeDefined();
  });

  it("ratchets the mark up when price makes a new high", () => {
    const alert = thAlert(10, { highWaterMark: 200, highSetUtc: yesterday() });
    const { triggered, stateUpdates } = evaluateAlerts([alert], priceAt(210));
    expect(triggered).toHaveLength(0);
    expect(stateUpdates).toHaveLength(1);
    expect(alert.state?.highWaterMark).toBe(210);
  });

  it("does not report state change when nothing moved", () => {
    const alert = thAlert(10, { highWaterMark: 200, highSetUtc: yesterday() });
    const { triggered, stateUpdates } = evaluateAlerts([alert], priceAt(195));
    expect(triggered).toHaveLength(0);
    expect(stateUpdates).toHaveLength(0);
  });

  it("triggers when drawdown reaches percent", () => {
    const alert = thAlert(10, { highWaterMark: 200, highSetUtc: yesterday() });
    const { triggered, stateUpdates } = evaluateAlerts([alert], priceAt(180));
    expect(triggered).toHaveLength(1);
    expect(triggered[0].message).toContain("AAPL is down 10.0% from its recent high of $200.00");
    expect(triggered[0].message).toContain("Current price: $180.00");
    // Trigger flag must be persisted
    expect(stateUpdates).toHaveLength(1);
    expect(alert.state?.triggeredAtMark).toBe(true);
  });

  it("does not re-trigger during the same drawdown episode", () => {
    const alert = thAlert(10, {
      highWaterMark: 200,
      highSetUtc: yesterday(),
      triggeredAtMark: true,
    });
    const { triggered } = evaluateAlerts([alert], priceAt(170));
    expect(triggered).toHaveLength(0);
  });

  it("re-arms after a new high and can trigger again", () => {
    const alert = thAlert(10, {
      highWaterMark: 200,
      highSetUtc: yesterday(),
      triggeredAtMark: true,
    });

    // New high clears the trigger flag
    const run1 = evaluateAlerts([alert], priceAt(220));
    expect(run1.triggered).toHaveLength(0);
    expect(run1.stateUpdates).toHaveLength(1);
    expect(alert.state?.highWaterMark).toBe(220);
    expect(alert.state?.triggeredAtMark).toBeUndefined();

    // Subsequent drawdown from the new high triggers again
    const run2 = evaluateAlerts([alert], priceAt(198));
    expect(run2.triggered).toHaveLength(1);
    expect(run2.triggered[0].message).toContain("down 10.0% from its recent high of $220.00");
  });

  it("a new high never triggers even with drawdown percent zero-adjacent params", () => {
    const alert = thAlert(0.1, { highWaterMark: 200, highSetUtc: yesterday() });
    const { triggered } = evaluateAlerts([alert], priceAt(250));
    expect(triggered).toHaveLength(0);
    expect(alert.state?.highWaterMark).toBe(250);
  });

  it("ignores invalid params", () => {
    const alerts = [
      makeAlert({ alertType: "trailing-high", params: undefined }),
      thAlert(0),
    ];
    const { triggered, stateUpdates } = evaluateAlerts(alerts, priceAt(100));
    expect(triggered).toHaveLength(0);
    expect(stateUpdates).toHaveLength(0);
  });
});
