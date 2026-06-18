import { config } from "../config.js";

const CLOCK_URL = "https://paper-api.alpaca.markets/v2/clock";

export async function isMarketOpen(): Promise<boolean> {
  if (!config.alpacaApiKey || !config.alpacaSecretKey) {
    console.warn("[market-hours] ALPACA_API_KEY/ALPACA_SECRET_KEY not set — assuming market CLOSED.");
    return false;
  }
  try {
    const res = await fetch(CLOCK_URL, {
      headers: {
        "APCA-API-KEY-ID": config.alpacaApiKey,
        "APCA-API-SECRET-KEY": config.alpacaSecretKey,
      },
    });
    if (!res.ok) {
      console.warn(`[market-hours] Alpaca clock returned ${res.status} — falling back to schedule.`);
      return isNyseHours();
    }
    const { is_open } = await res.json() as { is_open: boolean };
    return is_open;
  } catch (err) {
    console.warn("[market-hours] Alpaca clock unreachable — falling back to schedule.", (err as Error).message);
    return isNyseHours();
  }
}

// NYSE hours: Mon–Fri, 9:30 AM – 4:00 PM US Eastern (DST-aware).
function isNyseHours(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find(p => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find(p => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find(p => p.type === "minute")?.value ?? 0);
  const totalMinutes = hour * 60 + minute;
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  return isWeekday && totalMinutes >= 9 * 60 + 30 && totalMinutes < 16 * 60;
}
