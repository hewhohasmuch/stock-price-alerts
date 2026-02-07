import type { PriceResult } from "../types.js";

const BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const CACHE_TTL_MS = 30_000; // 30 seconds
let cache: { data: PriceResult[]; symbols: string; ts: number } | null = null;

async function fetchChart(symbol: string): Promise<PriceResult | null> {
  const url = `${BASE_URL}${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Yahoo chart API ${res.status} for ${symbol}`);
  }
  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) return null;

  return {
    symbol: (meta.symbol || symbol).toUpperCase(),
    price: meta.regularMarketPrice,
    name: meta.shortName || meta.longName || meta.symbol || symbol,
  };
}

export async function fetchPrices(symbols: string[]): Promise<PriceResult[]> {
  if (symbols.length === 0) return [];

  const key = [...symbols].sort().join(",");
  if (cache && cache.symbols === key && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }

  const results: PriceResult[] = [];
  // Fetch sequentially to avoid rate limits
  for (const sym of symbols) {
    try {
      const result = await fetchChart(sym);
      if (result) results.push(result);
    } catch (err) {
      console.warn(`  Failed to fetch ${sym}:`, (err as Error).message);
    }
  }

  cache = { data: results, symbols: key, ts: Date.now() };
  return results;
}

export async function fetchSinglePrice(symbol: string): Promise<PriceResult | null> {
  const results = await fetchPrices([symbol]);
  return results[0] ?? null;
}
