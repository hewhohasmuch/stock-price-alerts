import { describe, it, expect } from "vitest";
import {
  validateTargets, parseYahooFinancialData, classify, buildRow, midTarget, type AnalystTargets,
} from "../src/services/analyst-targets.js";

const T: AnalystTargets = { low: 80, mean: 100, median: null, high: 130, count: 20 };
const ok = { kind: "ok" as const, targets: T };
const usd = (price: number | null) => ({ price, currency: "USD", quoteTime: 1_700_000_000 });
const m = (price: number | null, reportingCurrency: string | null = "USD") => ({ price, reportingCurrency });

describe("validateTargets", () => {
  it("accepts ordered positive targets with an integer count", () => {
    expect(validateTargets({ low: 80, mean: 100, high: 130, count: 20 })).toEqual(ok);
  });

  it("accepts low === mean === high (a single analyst)", () => {
    expect(validateTargets({ low: 50, mean: 50, high: 50, count: 1 }).kind).toBe("ok");
  });

  it("reports no-targets when the provider has no coverage", () => {
    expect(validateTargets({})).toEqual({ kind: "no-targets" });
    expect(validateTargets({ low: 80, mean: 100, high: 130, count: 0 })).toEqual({ kind: "no-targets" });
  });

  it.each([
    ["a missing target", { low: 80, high: 130, count: 5 }, "missing-or-non-numeric-target"],
    ["a non-numeric target", { low: "80", mean: 100, high: 130, count: 5 }, "missing-or-non-numeric-target"],
    ["NaN", { low: NaN, mean: 100, high: 130, count: 5 }, "missing-or-non-numeric-target"],
    ["a negative target", { low: -1, mean: 100, high: 130, count: 5 }, "non-positive-target"],
    ["a zero mean", { low: 0, mean: 0, high: 0, count: 5 }, "non-positive-target"],
    ["low above mean", { low: 110, mean: 100, high: 130, count: 5 }, "targets-out-of-order"],
    ["mean above high", { low: 80, mean: 140, high: 130, count: 5 }, "targets-out-of-order"],
    ["a fractional count", { low: 80, mean: 100, high: 130, count: 2.5 }, "bad-analyst-count"],
    ["a negative count", { low: 80, mean: 100, high: 130, count: -3 }, "bad-analyst-count"],
    ["a missing count", { low: 80, mean: 100, high: 130 }, "bad-analyst-count"],
    ["a count with no targets", { count: 4 }, "count-without-targets"],
  ])("rejects %s", (_label, input, reason) => {
    expect(validateTargets(input)).toEqual({ kind: "invalid", reason });
  });
});

describe("parseYahooFinancialData", () => {
  it("unwraps {raw, fmt} values and the provider's own price", () => {
    const fd = {
      targetLowPrice: { raw: 80, fmt: "80.00" },
      targetMeanPrice: { raw: 100, fmt: "100.00" },
      targetHighPrice: { raw: 130, fmt: "130.00" },
      numberOfAnalystOpinions: { raw: 20, fmt: "20" },
      currentPrice: { raw: 95, fmt: "95.00" },
      financialCurrency: "USD",
    };
    expect(parseYahooFinancialData(fd)).toEqual({ parsed: ok, meta: { price: 95, reportingCurrency: "USD" } });
  });

  it("treats a missing financialData block as no coverage", () => {
    expect(parseYahooFinancialData(null).parsed).toEqual({ kind: "no-targets" });
  });
});

describe("classify", () => {
  it("uses the mean as the denominator when there is no median", () => {
    const r = classify(80.5, { ...T, low: 70 });
    expect(r.status).toBe("below-mid");
    expect(r.pct).toBeCloseTo(-0.195);
    expect(classify(80, { ...T, low: 70 }).pct).toBeCloseTo(-0.2);   // $80 vs $100 -> 20% below, not 25%
  });

  it("is at the boundaries inclusive of the range", () => {
    expect(classify(80, T).status).toBe("below-mid");     // exactly at low is not below it
    expect(classify(79.99, T).status).toBe("below-low");
    expect(classify(130, T).status).toBe("above-mid");    // exactly at high is not above it
    expect(classify(130.01, T).status).toBe("above-high");
  });

  it("reports at-mid when the rounded percentage is 0.0", () => {
    expect(classify(100, T).status).toBe("at-mid");
    expect(classify(100.04, T).status).toBe("at-mid");    // +0.04% rounds to 0.0
    expect(classify(100.06, T).status).toBe("above-mid"); // +0.06% rounds to 0.1
  });

  it("handles an equal low/mean/high range without dividing by its width", () => {
    const flat = { low: 50, mean: 50, median: null, high: 50, count: 1 };
    expect(classify(50, flat).status).toBe("at-mid");
    expect(classify(49, flat).status).toBe("below-low");
    expect(classify(51, flat).status).toBe("above-high");
  });
});

describe("buildRow", () => {
  it("returns a classified row from one price snapshot", () => {
    const row = buildRow(ok, m(95), usd(95));
    expect(row).toMatchObject({ state: "ok", price: 95, currency: "USD", quoteTime: 1_700_000_000, status: "below-mid" });
    expect(row.pct).toBeCloseTo(-0.05);
  });

  it("passes through no-coverage and invalid data as distinct states", () => {
    expect(buildRow({ kind: "no-targets" }, m(null), usd(95))).toEqual({ state: "no-targets" });
    expect(buildRow({ kind: "invalid", reason: "x" }, m(null), usd(95))).toEqual({ state: "targets-unavailable", reason: "x" });
  });

  it("suppresses non-USD listings", () => {
    expect(buildRow(ok, m(95), { price: 95, currency: "CAD" }).state).toBe("targets-unavailable");
  });

  it("suppresses foreign reporters such as ADRs (spike: TSM reports in TWD, trades in USD)", () => {
    expect(buildRow(ok, m(95, "TWD"), usd(95))).toMatchObject({
      state: "targets-unavailable", reason: "foreign-reporting-currency:TWD",
    });
    expect(buildRow(ok, m(95, null), usd(95)).state).toBe("ok");   // reporting currency not given: no evidence of a mismatch
  });

  it("suppresses when currency can't be established", () => {
    expect(buildRow(ok, m(95), { price: 95 }).state).toBe("targets-unavailable");
  });

  it("suppresses a listing/unit mismatch between the provider price and the quote", () => {
    expect(buildRow(ok, m(9.5), usd(95)).state).toBe("targets-unavailable");     // 10x apart
    expect(buildRow(ok, m(105), usd(95)).state).toBe("ok");                      // ~10.5%: an ordinary big move
  });

  it("suppresses implausible target/price ratios (likely stale pre-split targets)", () => {
    expect(buildRow(ok, m(null), usd(10)).state).toBe("targets-unavailable");    // mid (mean, no median) is 10x price
    expect(buildRow(ok, m(null), usd(600)).state).toBe("targets-unavailable");   // mid is 1/6 of price
  });

  it("shows the range with 'price unavailable' when the quote is missing but the listing is USD", () => {
    expect(buildRow(ok, m(null), usd(null))).toMatchObject({ state: "price-unavailable", low: 80, mean: 100, high: 130 });
    expect(buildRow(ok, m(null), usd(0)).state).toBe("price-unavailable");
    expect(buildRow(ok, m(null), usd(-5)).state).toBe("price-unavailable");
  });

  it("withholds the range when there is no quote at all (currency unknown)", () => {
    const row = buildRow(ok, m(null), null);
    expect(row.state).toBe("price-unavailable");
    expect(row.low).toBeUndefined();
  });
});

describe("median target", () => {
  // Seven analysts: six cluster at $14–$16, one outlier at $40 drags the mean to $18.57.
  const SKEW: AnalystTargets = { low: 14, mean: 18.57, median: 15, high: 40, count: 7 };

  it("keeps a valid median and falls back to null when it's missing or non-numeric", () => {
    expect(validateTargets({ low: 14, mean: 18.57, median: 15, high: 40, count: 7 })).toEqual({ kind: "ok", targets: SKEW });
    const noMedian = validateTargets({ low: 80, mean: 100, high: 130, count: 20 });
    expect(noMedian).toEqual(ok);
    expect(validateTargets({ low: 80, mean: 100, median: "98", high: 130, count: 20 })).toEqual(ok);
    expect(validateTargets({ low: 80, mean: 100, median: NaN, high: 130, count: 20 })).toEqual(ok);
  });

  it.each([
    ["below low", 79],
    ["above high", 131],
    ["non-positive", 0],
  ])("rejects a median %s as inconsistent data", (_label, median) => {
    expect(validateTargets({ low: 80, mean: 100, median, high: 130, count: 20 }))
      .toEqual({ kind: "invalid", reason: "median-out-of-order" });
  });

  it("accepts a median at either end of the range", () => {
    expect(validateTargets({ low: 80, mean: 100, median: 80, high: 130, count: 20 }).kind).toBe("ok");
    expect(validateTargets({ low: 80, mean: 100, median: 130, high: 130, count: 20 }).kind).toBe("ok");
  });

  it("parses Yahoo's targetMedianPrice", () => {
    const fd = {
      targetLowPrice: { raw: 14 }, targetMeanPrice: { raw: 18.57 }, targetMedianPrice: { raw: 15 },
      targetHighPrice: { raw: 40 }, numberOfAnalystOpinions: { raw: 7 }, financialCurrency: "USD",
    };
    expect(parseYahooFinancialData(fd).parsed).toEqual({ kind: "ok", targets: SKEW });
  });

  it("picks the median as the middle target, or the mean when there is none", () => {
    expect(midTarget(SKEW)).toEqual({ value: 15, basis: "median" });
    expect(midTarget(T)).toEqual({ value: 100, basis: "mean" });
  });

  it("classifies against the median, not the outlier-skewed mean", () => {
    const r = classify(16, SKEW);
    expect(r.status).toBe("above-mid");            // vs. the mean this would read "below"
    expect(r.pct).toBeCloseTo(1 / 15);
    expect(classify(15, SKEW).status).toBe("at-mid");
    expect(classify(14.5, SKEW).pct).toBeCloseTo(-0.5 / 15);
  });

  it("tags rows with the basis used, including price-unavailable rows", () => {
    expect(buildRow({ kind: "ok", targets: SKEW }, m(15), usd(15))).toMatchObject({
      state: "ok", median: 15, mean: 18.57, basis: "median", status: "at-mid",
    });
    expect(buildRow(ok, m(95), usd(95))).toMatchObject({ basis: "mean", median: null });
    expect(buildRow({ kind: "ok", targets: SKEW }, m(null), usd(null))).toMatchObject({
      state: "price-unavailable", basis: "median",
    });
  });

  it("runs the stale-target ratio check against the median", () => {
    // median $15 is within 5x of a $3.10 price; the $18.57 mean would not be — median decides.
    const wide: AnalystTargets = { low: 2, mean: 18.57, median: 15, high: 40, count: 7 };
    expect(buildRow({ kind: "ok", targets: wide }, m(null), usd(3.1)).state).toBe("ok");
    expect(buildRow({ kind: "ok", targets: wide }, m(null), usd(2.9)).state).toBe("targets-unavailable");
  });
});
