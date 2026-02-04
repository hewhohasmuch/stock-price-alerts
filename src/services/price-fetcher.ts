import YahooFinance from "yahoo-finance2";
import type { PriceResult } from "../types.js";

const yf = new YahooFinance();

export async function fetchPrices(symbols: string[]): Promise<PriceResult[]> {
  if (symbols.length === 0) return [];

  const results: PriceResult[] = [];

  const quotes = await yf.quote(symbols);
  const quoteArray = Array.isArray(quotes) ? quotes : [quotes];

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
}

export async function fetchSinglePrice(symbol: string): Promise<PriceResult | null> {
  const results = await fetchPrices([symbol]);
  return results[0] ?? null;
}
