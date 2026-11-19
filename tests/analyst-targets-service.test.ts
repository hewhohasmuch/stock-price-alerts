import { describe, it, expect, beforeEach } from "vitest";
import {
  createAnalystTargetService, TTL_MS, MAX_SYMBOLS, type ServiceDeps,
} from "../src/services/analyst-targets-service.js";
import type { Quote } from "../src/services/analyst-targets.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const targetsBody = (low = 80, mean = 100, high = 130, count = 20, median = 98) => json({
  quoteSummary: {
    result: [{
      financialData: {
        targetLowPrice: { raw: low }, targetMeanPrice: { raw: mean }, targetMedianPrice: { raw: median }, targetHighPrice: { raw: high },
        numberOfAnalystOpinions: { raw: count }, currentPrice: { raw: 95 }, financialCurrency: "USD",
      },
    }],
    error: null,
  },
});

type SummaryHandler = (symbol: string, crumb: string | null, init?: RequestInit) => Response | Promise<Response>;

let clock: number;
let calls: { cookie: number; crumb: number; summary: string[] };

function service(summary: SummaryHandler, overrides: Partial<ServiceDeps> = {}) {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://fc.yahoo.com")) {
      calls.cookie++;
      return new Response(null, { status: 404, headers: { "set-cookie": `A3=c${calls.cookie}; Path=/` } });
    }
    if (url.includes("/v1/test/getcrumb")) {
      calls.crumb++;
      return new Response(`crumb${calls.crumb}`, { status: 200 });
    }
    const symbol = decodeURIComponent(url.split("/quoteSummary/")[1].split("?")[0]);
    calls.summary.push(symbol);
    return summary(symbol, new URL(url).searchParams.get("crumb"), init);
  }) as typeof fetch;

  const getQuotes = async (symbols: string[]) =>
    Object.fromEntries(symbols.map(s => [s, { price: 95, currency: "USD", quoteTime: 1_700_000_000 } as Quote]));

  return createAnalystTargetService({
    fetchImpl, getQuotes, now: () => clock, log: () => {}, concurrency: 1, ...overrides,
  });
}

beforeEach(() => {
  clock = 1_000_000_000;
  calls = { cookie: 0, crumb: 0, summary: [] };
});

describe("analyst target service", () => {
  it("returns a classified row built from one quote snapshot, without internal reasons", async () => {
    const rows = await service(() => targetsBody()).get(["GOOGL"]);
    expect(rows.GOOGL).toMatchObject({
      state: "ok", low: 80, mean: 100, median: 98, basis: "median", high: 130, count: 20, price: 95, currency: "USD",
      quoteTime: 1_700_000_000, status: "below-mid", targetsRetrievedAt: Math.floor(clock / 1000),
    });
    expect(rows.GOOGL).not.toHaveProperty("reason");
    expect(calls.cookie).toBe(1);
  });

  it("treats Yahoo's 404 'No fundamentals data' (ETFs) as genuine no coverage", async () => {
    const svc = service(() => json({ quoteSummary: { result: null, error: { code: "Not Found", description: "No fundamentals data found for symbol: SPY" } } }, 404));
    expect((await svc.get(["SPY"])).SPY).toMatchObject({ state: "no-targets" });
  });

  it("keeps the range and reports price unavailable when the quote is missing", async () => {
    const svc = service(() => targetsBody(), {
      getQuotes: async () => ({ GOOGL: { price: null, currency: "USD" } }),
    });
    expect((await svc.get(["GOOGL"])).GOOGL).toMatchObject({ state: "price-unavailable", low: 80, high: 130 });
  });

  it("caches each state for its own TTL", async () => {
    const svc = service(sym =>
      sym === "OK" ? targetsBody()
      : sym === "BAD" ? targetsBody(130, 100, 80)            // out of order -> invalid
      : json({}, 503));                                       // temporary failure
    await svc.get(["OK", "BAD", "TMP"]);
    expect(calls.summary).toEqual(["OK", "BAD", "TMP"]);

    clock += TTL_MS.temporary + 1;
    await svc.get(["OK", "BAD", "TMP"]);
    expect(calls.summary.slice(3)).toEqual(["TMP"]);

    clock += TTL_MS.invalid;
    await svc.get(["OK", "BAD", "TMP"]);
    expect(calls.summary.slice(4)).toEqual(["BAD", "TMP"]);

    clock += TTL_MS.targets;
    await svc.get(["OK", "BAD", "TMP"]);
    expect(calls.summary.slice(6)).toEqual(["OK", "BAD", "TMP"]);
  });

  it("serves the last good targets (with their old retrieval time) after a temporary failure", async () => {
    let fail = false;
    const svc = service(() => (fail ? json({}, 503) : targetsBody()));
    const first = (await svc.get(["GOOGL"])).GOOGL;
    fail = true;
    clock += TTL_MS.targets + 1;
    const second = (await svc.get(["GOOGL"])).GOOGL;
    expect(second.state).toBe("ok");
    expect(second.targetsRetrievedAt).toBe(first.targetsRetrievedAt);
  });

  it("shares one fetch and one session between concurrent callers", async () => {
    const svc = service(() => targetsBody(), { concurrency: 3 });
    await Promise.all([svc.get(["A", "B", "C"]), svc.get(["A", "B", "C"]), svc.get(["C"])]);
    expect(calls.summary.sort()).toEqual(["A", "B", "C"]);
    expect(calls.cookie).toBe(1);
    expect(calls.crumb).toBe(1);
  });

  it("refreshes cookie and crumb together exactly once after a 401", async () => {
    const svc = service((_s, crumb) => (crumb === "crumb1" ? json({ finance: { error: { description: "Invalid Crumb" } } }, 401) : targetsBody()));
    expect((await svc.get(["GOOGL"])).GOOGL.state).toBe("ok");
    expect(calls.cookie).toBe(2);
    expect(calls.crumb).toBe(2);
    expect(calls.summary).toEqual(["GOOGL", "GOOGL"]);
  });

  it("opens the breaker on repeated auth failure instead of retrying every symbol", async () => {
    const svc = service(() => json({}, 401));
    const rows = await svc.get(["A", "B", "C", "D"]);
    expect(Object.values(rows).every(r => r.state === "temporarily-unavailable")).toBe(true);
    expect(calls.summary).toEqual(["A", "A"]);    // first attempt + one retry, then paused

    clock += TTL_MS.temporary + 1;                // breaker (2 min) and cache both expired
    await svc.get(["A"]);
    expect(calls.summary).toHaveLength(4);        // tried again, failed again -> backoff now 4 min

    clock += TTL_MS.temporary + 1;
    await svc.get(["A"]);
    expect(calls.summary).toHaveLength(4);        // still paused
  });

  it("backs off provider-wide on 429", async () => {
    const svc = service(() => json({}, 429));
    await svc.get(["A", "B", "C"]);
    expect(calls.summary).toEqual(["A"]);
  });

  it("marks symbols unfinished at the overall deadline as temporarily unavailable", async () => {
    const hang: SummaryHandler = (_s, _c, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
    const started = Date.now();
    const rows = await service(hang, { deadlineMs: 60, perSymbolTimeoutMs: 5_000 }).get(["A", "B", "C"]);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(Object.values(rows).map(r => r.state)).toEqual(Array(3).fill("temporarily-unavailable"));
  });

  it("dedupes and normalises symbols, and enforces the cap", async () => {
    const svc = service(() => targetsBody());
    expect(Object.keys(await svc.get(["aapl", "AAPL", " aapl "]))).toEqual(["AAPL"]);
    const tooMany = Array.from({ length: MAX_SYMBOLS + 1 }, (_, i) => `S${i}`);
    await expect(svc.get(tooMany)).rejects.toThrow(RangeError);
  });
});
