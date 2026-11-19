// I/O for the Analyst Targets view: Yahoo quoteSummary (financialData) behind a cookie+crumb
// session, per-state caching, a circuit breaker, bounded concurrency and an overall deadline.
// Pure validation/classification lives in analyst-targets.ts.
//
// Spike findings (2026-11-17): fc.yahoo.com answers 404 but sets the session cookie; getcrumb
// then returns the crumb; a bad crumb gives 401 "Invalid Crumb"; ETFs give 404 "No fundamentals
// data found" (a real no-coverage answer, not a failure); there is no target-date field.

import { fetchPrices } from "./price-fetcher.js";
import {
  buildRow, parseYahooFinancialData,
  type ParsedTargets, type Quote, type TargetRow,
} from "./analyst-targets.js";

const COOKIE_URL = "https://fc.yahoo.com/";
const CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb";
const SUMMARY_URL = "https://query2.finance.yahoo.com/v10/finance/quoteSummary/";
const UA = "Mozilla/5.0";

const MIN = 60_000;
export const TTL_MS = {
  targets: 360 * MIN,     // analyst targets change rarely
  noTargets: 360 * MIN,
  invalid: 60 * MIN,
  temporary: 2 * MIN,     // retry failures soon instead of caching them as facts
};
/** A previous good result is still served (with its retrieval time) after a temporary failure, up to this age. */
const STALE_LIMIT_MS = 24 * 60 * MIN;
export const BACKOFF_MIN_MS = 2 * MIN;
export const BACKOFF_MAX_MS = 15 * MIN;
export const MAX_SYMBOLS = 60;

type Fetched =
  | { kind: "data"; data: ParsedTargets }
  | { kind: "temporary"; reason: string };

interface CacheEntry {
  data: ParsedTargets | null;   // null = no usable data (temporary failure, nothing older to fall back on)
  retrievedAt: number;          // ms, when `data` was fetched
  expires: number;              // ms
}

interface Session { cookie: string; crumb: string }

export type TargetsResponseRow = Omit<TargetRow, "reason"> & { targetsRetrievedAt?: number };

export interface ServiceDeps {
  fetchImpl?: typeof fetch;
  getQuotes?: (symbols: string[]) => Promise<Record<string, Quote>>;
  now?: () => number;            // ms; drives cache expiry and the breaker
  concurrency?: number;
  perSymbolTimeoutMs?: number;
  deadlineMs?: number;           // overall budget for one get() call (real time)
  log?: (msg: string) => void;
}

async function defaultGetQuotes(symbols: string[]): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  for (const r of await fetchPrices(symbols)) {
    out[r.symbol] = { price: r.price, currency: r.currency, quoteTime: r.quoteTime };
  }
  return out;
}

/** Resolve `p`, or `fallback` once `ms` elapses. */
function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), Math.max(0, ms)); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export function createAnalystTargetService(deps: ServiceDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getQuotes = deps.getQuotes ?? defaultGetQuotes;
  const now = deps.now ?? Date.now;
  const concurrency = deps.concurrency ?? 3;
  const perSymbolTimeoutMs = deps.perSymbolTimeoutMs ?? 6_000;
  const deadlineMs = deps.deadlineMs ?? 15_000;
  const log = deps.log ?? ((m: string) => console.warn(`[analyst-targets] ${m}`));

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<CacheEntry>>();
  const loggedReasons = new Set<string>();

  // ── Session: cookie and crumb always travel and refresh together ──
  let session: Session | null = null;
  let sessionPromise: Promise<Session> | null = null;

  async function createSession(timeoutMs: number): Promise<Session> {
    const res = await fetchImpl(COOKIE_URL, {
      headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
    const cookie = (res.headers.getSetCookie?.() ?? []).map(c => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error(`no session cookie (HTTP ${res.status})`);
    const crumbRes = await fetchImpl(CRUMB_URL, {
      headers: { "User-Agent": UA, Cookie: cookie }, signal: AbortSignal.timeout(timeoutMs),
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumbRes.ok || !crumb || crumb.length > 64 || /[\s<]/.test(crumb)) {
      throw new Error(`no crumb (HTTP ${crumbRes.status})`);
    }
    return { cookie, crumb };
  }

  /** One shared refresh, however many callers need a session at once. */
  function getSession(timeoutMs: number): Promise<Session> {
    if (session) return Promise.resolve(session);
    if (!sessionPromise) {
      sessionPromise = createSession(timeoutMs)
        .then(s => { session = s; return s; })
        .finally(() => { sessionPromise = null; });
    }
    return sessionPromise;
  }

  /** Drop a session only if it's still the current one (a concurrent refresh may have replaced it). */
  function invalidate(s: Session) {
    if (session === s) session = null;
  }

  // ── Circuit breaker: provider-wide failures stop all requests for a while ──
  let breakerUntil = 0;
  let backoffMs = BACKOFF_MIN_MS;

  function openBreaker(reason: string) {
    if (now() < breakerUntil) return;   // already open; don't compound the backoff per symbol
    breakerUntil = now() + backoffMs;
    log(`provider paused for ${Math.round(backoffMs / 1000)}s: ${reason}`);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  }

  function markHealthy() {
    backoffMs = BACKOFF_MIN_MS;
  }

  async function fetchTargets(symbol: string, deadline: number): Promise<Fetched> {
    const temporary = (reason: string): Fetched => ({ kind: "temporary", reason });
    const timeout = () => Math.max(1, Math.min(perSymbolTimeoutMs, deadline - Date.now()));
    if (now() < breakerUntil) return temporary("provider paused");
    if (deadline - Date.now() <= 0) return temporary("deadline reached");

    const request = (s: Session) => fetchImpl(
      `${SUMMARY_URL}${encodeURIComponent(symbol)}?modules=financialData&crumb=${encodeURIComponent(s.crumb)}`,
      {
        headers: { "User-Agent": UA, "Accept": "application/json", Cookie: s.cookie },
        signal: AbortSignal.timeout(timeout()),
      },
    );

    try {
      let s: Session;
      try {
        s = await getSession(timeout());
      } catch (err) {
        openBreaker(`session failed: ${(err as Error).message}`);
        return temporary("session failed");
      }

      let res = await request(s);
      if (res.status === 401) {
        invalidate(s);
        try {
          s = await getSession(timeout());
        } catch (err) {
          openBreaker(`session refresh failed: ${(err as Error).message}`);
          return temporary("session refresh failed");
        }
        res = await request(s);
        if (res.status === 401) {
          invalidate(s);
          openBreaker("auth rejected after a fresh session");
          return temporary("auth rejected");
        }
      }
      if (res.status === 429) {
        openBreaker("rate limited (429)");
        return temporary("rate limited");
      }

      const json = await res.json().catch(() => null);
      if (res.status === 404) {
        const desc: string = json?.quoteSummary?.error?.description ?? json?.finance?.error?.description ?? "";
        if (/no fundamentals data|not found/i.test(desc)) {
          markHealthy();
          return { kind: "data", data: parseYahooFinancialData(null) };   // genuine no coverage
        }
        return temporary("HTTP 404");
      }
      if (!res.ok) return temporary(`HTTP ${res.status}`);

      markHealthy();
      return { kind: "data", data: parseYahooFinancialData(json?.quoteSummary?.result?.[0]?.financialData ?? null) };
    } catch (err) {
      return temporary(`request failed: ${(err as Error).message}`);
    }
  }

  function ttlFor(data: ParsedTargets): number {
    if (data.parsed.kind === "invalid") return TTL_MS.invalid;
    return data.parsed.kind === "ok" ? TTL_MS.targets : TTL_MS.noTargets;
  }

  async function refresh(symbol: string, deadline: number): Promise<CacheEntry> {
    const fetched = await fetchTargets(symbol, deadline);
    const t = now();
    let entry: CacheEntry;
    if (fetched.kind === "data") {
      entry = { data: fetched.data, retrievedAt: t, expires: t + ttlFor(fetched.data) };
    } else {
      log(`${symbol}: temporarily unavailable (${fetched.reason})`);
      const prev = cache.get(symbol);
      entry = prev?.data && t - prev.retrievedAt < STALE_LIMIT_MS
        ? { ...prev, expires: t + TTL_MS.temporary }            // keep serving older data, retry soon
        : { data: null, retrievedAt: t, expires: t + TTL_MS.temporary };
    }
    cache.set(symbol, entry);
    return entry;
  }

  function load(symbol: string, deadline: number): Promise<CacheEntry> {
    const cached = cache.get(symbol);
    if (cached && now() < cached.expires) return Promise.resolve(cached);
    const pending = inFlight.get(symbol);
    if (pending) return pending;
    const p = refresh(symbol, deadline).finally(() => inFlight.delete(symbol));
    inFlight.set(symbol, p);
    return p;
  }

  async function loadAll(symbols: string[], deadline: number): Promise<Map<string, CacheEntry>> {
    const out = new Map<string, CacheEntry>();
    const queue = [...symbols];
    const worker = async () => {
      for (let sym = queue.shift(); sym !== undefined; sym = queue.shift()) {
        out.set(sym, await load(sym, deadline));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
    return out;
  }

  function toResponseRow(symbol: string, entry: CacheEntry, quote: Quote | null): TargetsResponseRow {
    if (!entry.data) return { state: "temporarily-unavailable" };
    const { reason, ...row } = buildRow(entry.data.parsed, entry.data.meta, quote);
    if (reason && !loggedReasons.has(`${symbol}:${reason}`)) {
      loggedReasons.add(`${symbol}:${reason}`);
      log(`${symbol}: ${row.state} (${reason})`);
    }
    return { ...row, targetsRetrievedAt: Math.floor(entry.retrievedAt / 1000) };
  }

  async function get(rawSymbols: string[]): Promise<Record<string, TargetsResponseRow>> {
    const symbols = [...new Set(rawSymbols.map(s => s.trim().toUpperCase()).filter(Boolean))];
    if (symbols.length > MAX_SYMBOLS) throw new RangeError(`at most ${MAX_SYMBOLS} symbols`);
    const deadline = Date.now() + deadlineMs;

    const quotesPromise = getQuotes(symbols).catch(err => {
      log(`quotes failed: ${(err as Error).message}`);
      return {} as Record<string, Quote>;
    });
    const entries = await loadAll(symbols, deadline);
    const quotes = await withDeadline(quotesPromise, deadline - Date.now(), {} as Record<string, Quote>);

    const rows: Record<string, TargetsResponseRow> = {};
    for (const sym of symbols) {
      rows[sym] = toResponseRow(sym, entries.get(sym)!, quotes[sym] ?? null);
    }
    return rows;
  }

  return { get };
}

const defaultService = createAnalystTargetService();
export const getAnalystTargets = (symbols: string[]) => defaultService.get(symbols);
