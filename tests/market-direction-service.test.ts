import { describe, it, expect, vi } from "vitest";
import {
  createMarketDirectionService, fetchIndexBars, type ChartBars, type IndexConfig,
} from "../src/services/market-direction-service.js";

// Fri 2026-10-02, 9:30–16:00 ET.
const START = Date.UTC(2026, 9, 2, 13, 30) / 1000;
const END = START + 390 * 60;

const INDEXES: IndexConfig[] = [
  { symbol: "A", label: "Alpha", fullScale: 0.005, lagThresholdSec: 300 },
  { symbol: "B", label: "Bravo", fullScale: 0.005, lagThresholdSec: 300 },
  { symbol: "C", label: "Charlie", fullScale: 0.005, lagThresholdSec: 300 },
  { symbol: "D", label: "Delta", fullScale: 0.005, lagThresholdSec: 300 },
];

/** `minutes` bars rising +0.01%/min from a prior close of 100. */
function bars(minutes: number): ChartBars {
  return {
    timestamps: Array.from({ length: minutes }, (_, i) => START + i * 60),
    closes: Array.from({ length: minutes }, (_, i) => 100 * (1 + 0.0001 * (i + 1))),
    priorClose: 100,
    sessionStart: START,
    sessionEnd: END,
  };
}

function setup(opts: {
  fetchBars?: (s: string) => Promise<ChartBars>;
  open?: boolean;
  nowSec?: number;
} = {}) {
  let t = opts.nowSec ?? START + 120 * 60;
  const fetchBars = vi.fn(opts.fetchBars ?? (async () => bars(120)));
  const service = createMarketDirectionService({
    fetchBars,
    isMarketOpen: async () => opts.open ?? true,
    now: () => t,
    indexes: INDEXES,
  });
  return { service, fetchBars, advance: (sec: number) => { t += sec; } };
}

describe("market direction service", () => {
  it("returns one ok reading per index during an open session", async () => {
    const { service } = setup();
    const md = await service.get();
    expect(md.marketState).toBe("open");
    expect(md.indexes.map(r => r.symbol)).toEqual(["A", "B", "C", "D"]);
    expect(md.indexes.every(r => r.status === "ok" && r.dataQuality === "ok")).toBe(true);
  });

  it("one failing symbol leaves the other three usable", async () => {
    const { service } = setup({
      fetchBars: async (s) => { if (s === "C") throw new Error("boom"); return bars(120); },
    });
    const md = await service.get();
    const c = md.indexes.find(r => r.symbol === "C")!;
    expect(c.status).toBe("unavailable");
    expect(c.reason).toBe("fetch-failed");
    expect(c.dataQuality).toBe("unavailable");
    expect(c.score).toBeNull();
    expect(md.indexes.filter(r => r.status === "ok")).toHaveLength(3);
  });

  it("simultaneous calls share one fetch batch", async () => {
    const { service, fetchBars } = setup();
    const [a, b] = await Promise.all([service.get(), service.get()]);
    expect(a).toBe(b);
    expect(fetchBars).toHaveBeenCalledTimes(4);
  });

  it("serves the cache for 60 s, then refetches", async () => {
    const { service, fetchBars, advance } = setup();
    await service.get();
    advance(59);
    await service.get();
    expect(fetchBars).toHaveBeenCalledTimes(4);
    advance(2);
    await service.get();
    expect(fetchBars).toHaveBeenCalledTimes(8);
  });

  it("keeps the last good reading, flagged, when a later fetch fails", async () => {
    let fail = false;
    const { service, advance } = setup({
      fetchBars: async (s) => { if (fail && s === "A") throw new Error("down"); return bars(120); },
    });
    const first = (await service.get()).indexes[0];
    fail = true;
    advance(61);
    const second = (await service.get()).indexes[0];
    expect(second.staleFromError).toBe(true);
    expect(second.status).toBe("ok");
    expect(second.score).toBe(first.score);
    expect(second.asOf).toBe(first.asOf);
  });

  it("marks a reading delayed when its bars lag beyond the threshold while open", async () => {
    // Bars end at minute 100, but it is minute 110 → 600 s behind (> 300).
    const { service } = setup({ fetchBars: async () => bars(100), nowSec: START + 110 * 60 });
    const md = await service.get();
    expect(md.marketState).toBe("open");
    expect(md.indexes[0].dataQuality).toBe("delayed");
  });

  it("is closed when the clock says open but the bars are from an earlier session", async () => {
    const { service } = setup({ open: true, nowSec: Date.UTC(2026, 9, 5, 14) / 1000 });
    const md = await service.get();
    expect(md.marketState).toBe("closed");
    expect(md.indexes[0].sessionDate).toBe("2026-10-02");
    expect(md.indexes[0].dataQuality).toBe("ok");   // lag is expected when closed
  });

  it("shows Unavailable, not a neutral arrow, when open but no bars have arrived", async () => {
    const { service } = setup({ fetchBars: async () => bars(0), nowSec: START + 120 });
    const r = (await service.get()).indexes[0];
    expect(r.status).toBe("unavailable");
    expect(r.reason).toBe("pre-first-bar");
    expect(r.score).toBeNull();
    expect(r.dataQuality).toBe("unavailable");
  });

  it("reports incomplete coverage while closed", async () => {
    const b = bars(390);
    b.closes[350] = null;                     // minute 351, inside the last 90
    const { service } = setup({ fetchBars: async () => b, open: false, nowSec: END + 600 });
    const md = await service.get();
    expect(md.marketState).toBe("closed");
    expect(md.indexes[0].dataQuality).toBe("incomplete");
  });
});

describe("fetchIndexBars", () => {
  const body = {
    chart: { result: [{
      meta: {
        chartPreviousClose: 7666.45,
        currentTradingPeriod: { regular: { start: START, end: END } },
      },
      timestamp: [START, START + 60],
      indicators: { quote: [{ close: [7670.1, null] }] },
    }] },
  };

  it("parses bars, prior close and session bounds", async () => {
    const fetchImpl = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status: 200 }));
    const b = await fetchIndexBars("^GSPC", { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(b).toEqual({
      timestamps: [START, START + 60], closes: [7670.1, null],
      priorClose: 7666.45, sessionStart: START, sessionEnd: END,
    });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("%5EGSPC?interval=1m&range=1d");
  });

  it("throws on a non-OK status", async () => {
    const fetchImpl = async () => new Response("nope", { status: 429 });
    await expect(fetchIndexBars("^RUT", { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow("429");
  });

  it("throws when session data is missing", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ chart: { result: [{ meta: {} }] } }));
    await expect(fetchIndexBars("^DJI", { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toThrow("missing session data");
  });

  it("aborts a request that exceeds the timeout", async () => {
    const hang = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    });
    await expect(fetchIndexBars("^IXIC", { timeoutMs: 20, fetchImpl: hang as unknown as typeof fetch }))
      .rejects.toThrow();
  });
});
