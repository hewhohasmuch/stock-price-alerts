import YahooFinance from "yahoo-finance2";
import type { PriceResult } from "../types.js";

const yf = new YahooFinance({
  queue: { concurrency: 1, timeout: 60 },
});

// Cache to avoid redundant fetches within a short window
let cache: { data: PriceResult[]; symbols: string; ts: number } | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds

async function fetchWithRetry(symbols: string[], retries = 2): Promise<PriceResult[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const quotes = await yf.quote(symbols);
      const quoteArray = Array.isArray(quotes) ? quotes : [quotes];
      const results: PriceResult[] = [];
      for (const q of quoteArray) {
        if (q && q.regularMarketPrice != null) {
          results.push({
            symbol: q.symbol,
            price: q.regularMarketPrice,
            name: q.shortName || q.longName || q.symbol,
          });
        }
      }
      return results;
    } catch (err) {
      const msg = (err as Error).message || "";
      if (msg.includes("429") && attempt < retries) {
        const delay = (attempt + 1) * 2000;
        console.warn(`  Yahoo Finance 429 — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${retries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  return [];
}

export async function fetchPrices(symbols: string[]): Promise<PriceResult[]> {
  if (symbols.length === 0) return [];

  const key = [...symbols].sort().join(",");
  if (cache && cache.symbols === key && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.data;
  }

  const results = await fetchWithRetry(symbols);
  cache = { data: results, symbols: key, ts: Date.now() };
  return results;
}

export async function fetchSinglePrice(symbol: string): Promise<PriceResult | null> {
  const results = await fetchPrices([symbol]);
  return results[0] ?? null;
}
