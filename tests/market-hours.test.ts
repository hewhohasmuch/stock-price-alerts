import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cfg = vi.hoisted(() => ({
  config: { alpacaApiKey: undefined as string | undefined, alpacaSecretKey: undefined as string | undefined },
}));
vi.mock("../src/config.js", () => cfg);

const { isMarketOpen } = await import("../src/utils/market-hours.js");

describe("isMarketOpen", () => {
  beforeEach(() => {
    cfg.config.alpacaApiKey = undefined;
    cfg.config.alpacaSecretKey = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls back to the schedule when the Alpaca clock hangs past the timeout", async () => {
    cfg.config.alpacaApiKey = "key";
    cfg.config.alpacaSecretKey = "secret";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    const result = await isMarketOpen({ timeoutMs: 20 });
    expect(typeof result).toBe("boolean");
  }, 1000);

  it("warns about missing Alpaca keys only once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await isMarketOpen()).toBe(false);
    expect(await isMarketOpen()).toBe(false);
    expect(warn.mock.calls.filter(c => String(c[0]).includes("ALPACA_API_KEY"))).toHaveLength(1);
  });
});
