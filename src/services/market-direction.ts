// Pure market-direction scoring. No network or clock access — `now` is an input.
// Spec: docs/superpowers/specs/2026-10-04-market-direction-arrows-design.md

export const WINDOW_MINUTES = 90;
export const MAX_FILL_MINUTES = 3;
export const MIN_COVERAGE = 0.9;
// Relative tolerance for "exactly on the baseline" (guards float noise in sums).
const TIE_EPSILON = 1e-9;

export interface DirectionInput {
  timestamps: number[];          // unix seconds, bar START times
  closes: (number | null)[];
  priorClose: number;
  sessionStart: number;          // unix seconds, regular session start
  sessionEnd: number;            // unix seconds, regular session end (exclusive)
  now: number;                   // unix seconds
  fullScale: number;             // fraction, e.g. 0.005 for 0.5%
}

export type UnavailableReason =
  | "invalid-input" | "pre-first-bar" | "insufficient-data" | "fetch-failed";

export interface Reading {
  status: "ok" | "unavailable";
  reason?: UnavailableReason;
  score: number | null;          // −1..1
  distancePct: number | null;    // (price − baseline) / baseline × 100
  sameSidePct: number | null;    // f × 100
  baseline: number | null;
  price: number | null;
  asOf: number | null;           // unix seconds, end of the latest included minute
  minute: number;                // n of the latest included bar (0 = none)
  coverage: number | null;       // real bars in window / window size
  sessionDate: string | null;    // YYYY-MM-DD, America/New_York
  sessionEnd: number | null;     // unix seconds
}

export function nyDate(unixSec: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })
    .format(new Date(unixSec * 1000));
}

function unavailable(
  reason: UnavailableReason,
  extra: Partial<Reading> = {},
): Reading {
  return {
    status: "unavailable", reason,
    score: null, distancePct: null, sameSidePct: null, baseline: null,
    price: null, asOf: null, minute: 0, coverage: null,
    sessionDate: null, sessionEnd: null,
    ...extra,
  };
}

function side(value: number, baseline: number): -1 | 0 | 1 {
  const diff = value - baseline;
  if (Math.abs(diff) <= Math.abs(baseline) * TIE_EPSILON) return 0;
  return diff > 0 ? 1 : -1;
}

export function computeDirection(input: DirectionInput): Reading {
  const { timestamps, closes, priorClose, sessionStart, sessionEnd, now, fullScale } = input;

  const validInput =
    Array.isArray(timestamps) && Array.isArray(closes) &&
    timestamps.length === closes.length &&
    Number.isFinite(priorClose) && priorClose > 0 &&
    Number.isFinite(fullScale) && fullScale > 0 &&
    Number.isFinite(sessionStart) && Number.isFinite(sessionEnd) &&
    sessionStart < sessionEnd && Number.isFinite(now);
  if (!validInput) return unavailable("invalid-input");

  const session = { sessionDate: nyDate(sessionStart), sessionEnd };

  // Collect completed regular-session bars, keyed by minute number.
  // Duplicates: the later occurrence in input order wins.
  const bars = new Map<number, { ts: number; close: number }>();
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const close = closes[i];
    if (!Number.isFinite(ts) || typeof close !== "number" || !Number.isFinite(close) || close <= 0) continue;
    if (ts < sessionStart || ts >= sessionEnd) continue;   // excludes the 16:00 print
    if (ts + 60 > now) continue;                            // still forming
    const minute = Math.floor((ts - sessionStart) / 60) + 1;
    bars.set(minute, { ts, close });
  }

  if (bars.size === 0) {
    return unavailable("pre-first-bar", { ...session, baseline: priorClose });
  }

  const n = Math.max(...bars.keys());

  // Filled series c[1..n]; real[k] marks provider bars.
  const c = new Array<number>(n + 1);
  const real = new Array<boolean>(n + 1).fill(false);
  let prev = priorClose;
  let run = 0;
  for (let k = 1; k <= n; k++) {
    const bar = bars.get(k);
    if (bar) {
      c[k] = bar.close;
      real[k] = true;
      run = 0;
    } else {
      run++;
      if (run > MAX_FILL_MINUTES) {
        return unavailable("insufficient-data", { ...session, minute: n });
      }
      c[k] = prev;
    }
    prev = c[k];
  }

  // Baseline for every minute (needed before trimming the persistence window).
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let k = 1; k <= n; k++) prefix[k] = prefix[k - 1] + c[k];
  const B = new Array<number>(n + 1);
  for (let k = 1; k <= n; k++) {
    B[k] = k < WINDOW_MINUTES
      ? ((WINDOW_MINUTES - k) * priorClose + prefix[k]) / WINDOW_MINUTES
      : (prefix[k] - prefix[k - WINDOW_MINUTES]) / WINDOW_MINUTES;
  }

  const first = Math.max(1, n - WINDOW_MINUTES + 1);
  const windowSize = n - first + 1;
  let realCount = 0;
  for (let i = first; i <= n; i++) if (real[i]) realCount++;
  const coverage = realCount / windowSize;
  if (realCount === 0 || coverage < MIN_COVERAGE) {
    return unavailable("insufficient-data", { ...session, minute: n, coverage });
  }

  const price = c[n];
  const baseline = B[n];
  const sideNow = side(price, baseline);

  let sameSide = 0;
  if (sideNow !== 0) {
    for (let i = first; i <= n; i++) {
      if (real[i] && side(c[i], B[i]) === sideNow) sameSide++;
    }
  }
  const f = sameSide / realCount;

  const distance = (price - baseline) / baseline;
  const d = Math.max(-1, Math.min(1, distance / fullScale));   // clamp BEFORE × f
  const raw = sideNow === 0 ? 0 : d * f;
  const score = raw === 0 ? 0 : raw;                           // normalize −0

  return {
    status: "ok",
    score,
    distancePct: distance * 100,
    sameSidePct: f * 100,
    baseline,
    price,
    asOf: bars.get(n)!.ts + 60,
    minute: n,
    coverage,
    ...session,
  };
}
