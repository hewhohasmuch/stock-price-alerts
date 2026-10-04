// Fetches 1-minute index bars from Yahoo and turns them into dashboard readings.
// Scoring lives in ./market-direction.ts; this file owns I/O, caching and failure handling.
import { computeDirection, nyDate, type Reading } from "./market-direction.js";
import { isMarketOpen as defaultIsMarketOpen } from "../utils/market-hours.js";

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_SEC = 60;

export interface IndexConfig {
  symbol: string;
  label: string;
  fullScale: number;        // fraction: 0.005 = 0.5%
  lagThresholdSec: number;  // older than this while open → "delayed"
}

export const INDEXES: IndexConfig[] = [
  { symbol: "^GSPC", label: "S&P 500",      fullScale: 0.005,  lagThresholdSec: 300 },
  { symbol: "^DJI",  label: "Dow",          fullScale: 0.0045, lagThresholdSec: 300 },
  { symbol: "^IXIC", label: "Nasdaq",       fullScale: 0.0065, lagThresholdSec: 300 },
  { symbol: "^RUT",  label: "Russell 2000", fullScale: 0.009,  lagThresholdSec: 300 },
];

export interface ChartBars {
  timestamps: number[];
  closes: (number | null)[];
  priorClose: number;
  sessionStart: number;
  sessionEnd: number;
}

export type DataQuality = "ok" | "delayed" | "incomplete" | "unavailable";

export interface IndexReading extends Reading {
  symbol: string;
  label: string;
  dataQuality: DataQuality;
  staleFromError: boolean;
}

export interface MarketDirection {
  marketState: "open" | "closed";
  fetchedAt: number;        // unix seconds — when we fetched, never used as asOf
  indexes: IndexReading[];
}

export async function fetchIndexBars(
  symbol: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ChartBars> {
  const { timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = fetch } = opts;
  const url = `${CHART_URL}${encodeURIComponent(symbol)}?interval=1m&range=1d`;
  const res = await fetchImpl(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Yahoo chart API ${res.status} for ${symbol}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const meta = result?.meta;
  const regular = meta?.currentTradingPeriod?.regular;
  const priorClose = meta?.chartPreviousClose ?? meta?.previousClose;
  if (typeof priorClose !== "number" || typeof regular?.start !== "number" || typeof regular?.end !== "number") {
    throw new Error(`Yahoo chart response for ${symbol} is missing session data`);
  }
  const timestamps: number[] = result.timestamp ?? [];
  let sessionStart: number = regular.start;
  let sessionEnd: number = regular.end;
  // Pre-open, Yahoo may already report today's session while the bars are still the
  // previous day's. Anchor to the bars' own session so the strip shows it as Closed.
  const lastTs = timestamps.length ? Math.max(...timestamps) : NaN;
  if (Number.isFinite(lastTs) && lastTs < sessionStart) {
    const day = nyDate(lastTs);
    sessionStart = nyWallClock(day, 9, 30);
    sessionEnd = nyWallClock(day, 16, 0);  // after an early close, bars simply end sooner
  }
  return {
    timestamps,
    closes: result.indicators?.quote?.[0]?.close ?? [],
    priorClose,
    sessionStart,
    sessionEnd,
  };
}

/** Unix seconds for hh:mm America/New_York wall-clock time on a YYYY-MM-DD date. */
function nyWallClock(day: string, hh: number, mm: number): number {
  const [y, m, d] = day.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm) / 1000;
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" })
    .formatToParts(new Date(asUtc * 1000))
    .find(p => p.type === "timeZoneName")?.value ?? "GMT-05:00";   // e.g. "GMT-04:00"
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offset);
  const minutes = match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : -300;
  return asUtc - minutes * 60;
}

export interface ServiceDeps {
  fetchBars?: (symbol: string) => Promise<ChartBars>;
  isMarketOpen?: () => Promise<boolean>;
  now?: () => number;       // unix seconds
  indexes?: IndexConfig[];
}

export function createMarketDirectionService(deps: ServiceDeps = {}) {
  const fetchBars = deps.fetchBars ?? ((s: string) => fetchIndexBars(s));
  const isMarketOpen = deps.isMarketOpen ?? defaultIsMarketOpen;
  const now = deps.now ?? (() => Date.now() / 1000);
  const indexes = deps.indexes ?? INDEXES;

  let cache: { data: MarketDirection; at: number } | null = null;
  let inFlight: Promise<MarketDirection> | null = null;
  const lastGood = new Map<string, Reading>();

  async function build(): Promise<MarketDirection> {
    const t = now();
    const results: { idx: IndexConfig; reading: Reading; staleFromError: boolean }[] = [];

    // Sequential, like price-fetcher.ts, to avoid Yahoo rate limits.
    for (const idx of indexes) {
      try {
        const bars = await fetchBars(idx.symbol);
        const reading = computeDirection({ ...bars, now: t, fullScale: idx.fullScale });
        if (reading.status === "ok") lastGood.set(idx.symbol, reading);
        results.push({ idx, reading, staleFromError: false });
      } catch (err) {
        console.warn(`[market-direction] ${idx.symbol} failed:`, (err as Error).message);
        const prev = lastGood.get(idx.symbol);
        results.push(prev
          ? { idx, reading: prev, staleFromError: true }
          : { idx, reading: unavailableFetch(), staleFromError: false });
      }
    }

    let clockOpen = false;
    try { clockOpen = await isMarketOpen(); } catch { clockOpen = false; }
    const today = nyDate(t);
    const open = clockOpen && results.some(({ reading: r }) =>
      r.sessionDate === today && r.sessionEnd != null && t < r.sessionEnd);
    const marketState = open ? "open" : "closed";

    return {
      marketState,
      fetchedAt: t,
      indexes: results.map(({ idx, reading, staleFromError }) => ({
        ...reading,
        symbol: idx.symbol,
        label: idx.label,
        dataQuality: quality(reading, idx, t, open),
        staleFromError,
      })),
    };
  }

  async function get(): Promise<MarketDirection> {
    if (cache && now() - cache.at < CACHE_TTL_SEC) return cache.data;
    if (inFlight) return inFlight;
    inFlight = build()
      .then(data => { cache = { data, at: now() }; return data; })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return { get };
}

function unavailableFetch(): Reading {
  return {
    status: "unavailable", reason: "fetch-failed",
    score: null, distancePct: null, sameSidePct: null, baseline: null,
    price: null, asOf: null, minute: 0, coverage: null,
    sessionDate: null, sessionEnd: null,
  };
}

function quality(r: Reading, idx: IndexConfig, t: number, open: boolean): DataQuality {
  if (r.status !== "ok") return "unavailable";
  if (open && r.asOf != null && t - r.asOf > idx.lagThresholdSec) return "delayed";
  if (r.coverage != null && r.coverage < 1) return "incomplete";
  return "ok";
}

const defaultService = createMarketDirectionService();
export const getMarketDirection = () => defaultService.get();
