import { config } from "../config.js";

const CLOCK_URL = "https://paper-api.alpaca.markets/v2/clock";

export async function isMarketOpen(): Promise<boolean> {
  if (!config.alpacaApiKey || !config.alpacaSecretKey) {
    console.warn("[market-hours] ALPACA_API_KEY/ALPACA_SECRET_KEY not set — assuming market open.");
    return true;
  }
  try {
    const res = await fetch(CLOCK_URL, {
      headers: {
        "APCA-API-KEY-ID": config.alpacaApiKey,
        "APCA-API-SECRET-KEY": config.alpacaSecretKey,
      },
    });
    if (!res.ok) {
      console.warn(`[market-hours] Alpaca clock returned ${res.status} — assuming market open.`);
      return true;
    }
    const { is_open } = await res.json() as { is_open: boolean };
    return is_open;
  } catch (err) {
    console.warn("[market-hours] Alpaca clock unreachable — assuming market open.", (err as Error).message);
    return true;
  }
}
