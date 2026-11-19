// Pure logic for the Analyst Targets view: validate analyst price targets, decide whether
// they can be compared with the live quote, and classify the price against them.
// No I/O here — see analyst-targets-service.ts.
//
// Framing rule: these are analysts' 12-month price *opinions*, not intrinsic value and not a
// margin of safety. Labels stay factual ("Below lowest target"), and anything we cannot
// establish is suppressed rather than guessed.

export interface AnalystTargets {
  low: number;
  mean: number;
  median: number | null;   // null when the provider gives no usable median
  high: number;
  count: number;   // number of analyst opinions behind the targets
}

/** Which figure the "middle" target (tick, middle number, status) is based on. */
export type MidBasis = "median" | "mean";

export type ParseResult =
  | { kind: "ok"; targets: AnalystTargets }
  | { kind: "no-targets" }                    // provider answered: no analyst coverage
  | { kind: "invalid"; reason: string };      // provider answered with unusable data

export type RowState =
  | "ok"
  | "price-unavailable"
  | "no-targets"
  | "targets-unavailable"
  | "temporarily-unavailable";

export type Status = "below-low" | "below-mid" | "at-mid" | "above-mid" | "above-high";

export interface TargetRow {
  state: RowState;
  low?: number;
  mean?: number;
  median?: number | null;
  basis?: MidBasis;
  high?: number;
  count?: number;
  price?: number;
  currency?: string;
  quoteTime?: number;      // unix seconds of the quote used for classification
  pct?: number;            // (price − mid) / mid, mid = median, or mean when no median
  status?: Status;
  reason?: string;         // internal diagnostic; logged server-side, never displayed
}

export interface Quote {
  price?: number | null;
  currency?: string;
  quoteTime?: number;
}

/** Above this relative gap between the provider's own price and our quote, we assume the
 *  targets and the quote don't refer to the same listing/unit (ADR ratios, GBp vs GBP, …).
 *  Wide enough not to trip on an earnings-day move between two Yahoo endpoints. */
export const PRICE_MISMATCH_TOLERANCE = 0.15;
/** Heuristic for stale pre-split targets: a middle target this far from price is suppressed. */
export const MIN_MID_TO_PRICE = 0.2;
export const MAX_MID_TO_PRICE = 5;
/** Below this many analysts the UI shows a "Few analysts" badge. */
export const THIN_COVERAGE = 3;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validate normalized target values. A provider adapter maps its response into this shape. */
export function validateTargets(input: {
  low?: unknown; mean?: unknown; median?: unknown; high?: unknown; count?: unknown;
}): ParseResult {
  const { low, mean, median, high, count } = input;
  const values = [low, mean, high];
  const allMissing = values.every(v => v == null);

  if (count === 0 || (allMissing && count == null)) return { kind: "no-targets" };
  if (allMissing) return { kind: "invalid", reason: "count-without-targets" };
  if (!values.every(isNum)) return { kind: "invalid", reason: "missing-or-non-numeric-target" };
  if (!isNum(count) || !Number.isInteger(count) || count < 1) return { kind: "invalid", reason: "bad-analyst-count" };

  const [l, m, h] = values as number[];
  if (l <= 0 || m <= 0 || h <= 0) return { kind: "invalid", reason: "non-positive-target" };
  if (l > m || m > h) return { kind: "invalid", reason: "targets-out-of-order" };

  // The median is optional (missing or non-numeric → fall back to the mean), but a numeric
  // median outside the range means the data is inconsistent, so nothing is shown.
  const med = isNum(median) ? median : null;
  if (med != null && (med <= 0 || med < l || med > h)) return { kind: "invalid", reason: "median-out-of-order" };

  return { kind: "ok", targets: { low: l, mean: m, median: med, high: h, count } };
}

/** Yahoo values come either bare or as `{ raw, fmt }`. */
function rawValue(v: unknown): unknown {
  return v && typeof v === "object" && "raw" in v ? (v as { raw: unknown }).raw : v;
}

/** What the provider says about its own figures, used only for comparability checks. */
export interface ProviderMeta {
  price: number | null;               // provider's current price, same listing as the targets
  reportingCurrency: string | null;   // financial-statement currency (does NOT establish target currency)
}

export interface ParsedTargets {
  parsed: ParseResult;
  meta: ProviderMeta;
}

/** Adapter for Yahoo `quoteSummary?modules=financialData`. `fd` is `result[0].financialData`. */
export function parseYahooFinancialData(fd: unknown): ParsedTargets {
  if (!fd || typeof fd !== "object") {
    return { parsed: { kind: "no-targets" }, meta: { price: null, reportingCurrency: null } };
  }
  const o = fd as Record<string, unknown>;
  const price = rawValue(o.currentPrice);
  const ccy = o.financialCurrency;
  return {
    parsed: validateTargets({
      low: rawValue(o.targetLowPrice),
      mean: rawValue(o.targetMeanPrice),
      median: rawValue(o.targetMedianPrice),
      high: rawValue(o.targetHighPrice),
      count: rawValue(o.numberOfAnalystOpinions),
    }),
    meta: {
      price: isNum(price) && price > 0 ? price : null,
      reportingCurrency: typeof ccy === "string" && ccy ? ccy : null,
    },
  };
}

/** The "middle" target: the median, which one outlier analyst can't drag around, or the
 *  mean when the provider gives no median. `basis` says which, so labels stay truthful. */
export function midTarget(t: AnalystTargets): { value: number; basis: MidBasis } {
  return t.median != null ? { value: t.median, basis: "median" } : { value: t.mean, basis: "mean" };
}

/** Where the price sits against the targets. pct uses the middle target as denominator:
 *  price $80 vs median $100 → pct −0.20 → "20% below median target". */
export function classify(price: number, t: AnalystTargets): { status: Status; pct: number } {
  const mid = midTarget(t).value;
  const pct = (price - mid) / mid;
  if (price < t.low) return { status: "below-low", pct };
  if (price > t.high) return { status: "above-high", pct };
  const roundedPct = Math.round(pct * 1000) / 10;   // one decimal place, in percent
  if (roundedPct === 0) return { status: "at-mid", pct };
  return { status: pct < 0 ? "below-mid" : "above-mid", pct };
}

/** Combine validated targets with the quote into a displayable row. Suppresses the
 *  comparison (never adjusts values) when comparability can't be established. */
export function buildRow(parsed: ParseResult, meta: ProviderMeta, quote: Quote | null): TargetRow {
  if (parsed.kind === "no-targets") return { state: "no-targets" };
  if (parsed.kind === "invalid") return { state: "targets-unavailable", reason: parsed.reason };

  const t = parsed.targets;
  const { value: mid, basis } = midTarget(t);
  const currency = quote?.currency;
  const price = quote?.price;
  const priceOk = isNum(price) && price > 0;
  const providerPrice = meta.price;

  if (currency && currency !== "USD") return { state: "targets-unavailable", reason: `non-usd-listing:${currency}` };
  // Foreign reporters (e.g. ADRs like TSM: reports in TWD, trades in USD) — we can't establish
  // which currency/share unit the targets use, so don't compare.
  if (meta.reportingCurrency && meta.reportingCurrency !== "USD") {
    return { state: "targets-unavailable", reason: `foreign-reporting-currency:${meta.reportingCurrency}` };
  }
  if (!priceOk) {
    // Without a quote we can't confirm the listing currency, so only show the range if we know it's USD.
    return currency === "USD"
      ? { state: "price-unavailable", ...t, basis, currency }
      : { state: "price-unavailable", reason: "no-quote" };
  }
  if (!currency) return { state: "targets-unavailable", reason: "currency-unknown" };
  if (providerPrice != null && Math.abs(providerPrice - price) / price > PRICE_MISMATCH_TOLERANCE) {
    return { state: "targets-unavailable", reason: "price-mismatch" };
  }
  const ratio = mid / price;
  if (ratio < MIN_MID_TO_PRICE || ratio > MAX_MID_TO_PRICE) {
    return { state: "targets-unavailable", reason: "implausible-target-ratio" };
  }

  const { status, pct } = classify(price, t);
  return { state: "ok", ...t, basis, price, currency, quoteTime: quote?.quoteTime, pct, status };
}
