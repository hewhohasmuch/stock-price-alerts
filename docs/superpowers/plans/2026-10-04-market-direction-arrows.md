# Market Direction Arrows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strip above the dashboard tabs with one arrow per index (S&P 500, Dow, Nasdaq Composite, Russell 2000). Each arrow's angle and color show the strength and persistence of movement against a trailing 90-minute baseline.

**Architecture:** The work splits into three units:
- **Scoring** (`src/services/market-direction.ts`): a pure function that turns one index's 1-minute bars into a `Reading`.
- **Service** (`src/services/market-direction-service.ts`): fetches Yahoo bars, isolates per-symbol failures, keeps last-good readings, shares in-flight requests and caches for 60s.
- **Endpoint and dashboard**: an auth-protected `GET /api/market-direction` endpoint, and a framework-free strip in `public/index.html`.

There are no database changes.

**Tech Stack:** TypeScript (ES2022 modules, `.js` import suffixes), Express 4, Vitest 4, Node 22 global `fetch` and `AbortSignal.timeout`, plain HTML/CSS/JS with CSS `color-mix(in oklab, …)`.

**Spec:** `docs/superpowers/specs/2026-10-04-market-direction-arrows-design.md`. Read it before starting. Where the spec and this plan differ, the spec wins.

**Branch:** `feat/market-direction` (already exists; the spec is committed there).

## Global Constraints

- Indexes and initial fullScale: `^GSPC` S&P 500 0.50% · `^DJI` Dow 0.45% · `^IXIC` Nasdaq (Composite) 0.65% · `^RUT` Russell 2000 0.90%.
- No ETF substitution. A failed symbol shows **Unavailable**, never a neutral arrow.
- Window 90 minutes; fill at most **3 consecutive** missing minutes; minimum window coverage **90%**.
- `s = clamp(distance / fullScale, −1, 1) × f`, clamping **before** multiplying.
- Angle = `s × 90°`, continuous. Color stops: −1 `#8B0000`, −⅓ `#E67E00`, +⅓ `#D4A800`, +1 `#006400`, blended in OKLab.
- The percentage label always reads **"vs. baseline"** and is never shown bare.
- `asOf` = end of the latest included minute, never the fetch time.
- `marketState` and `dataQuality` are separate fields; default lag threshold is 300s.
- Per-symbol fetch timeout 8s; result cache 60s; symbols are fetched one at a time.
- No new npm dependencies.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Early-close days (1 PM ET):** bars and readings must stop at Yahoo's `regular.end`, and the strip must show Closed after it, not Delayed. *Test: Task 1 "honors an early close".*
2. **Open session, but Yahoo hasn't delivered the first bars:** the tile must show Unavailable ("Waiting for first minute"), never a flat amber arrow. *Test: Task 2 "shows Unavailable, not a neutral arrow, when open but no bars have arrived".*
3. **Pre-open on a weekday:** the strip should show the previous session as Closed with that session's date. *Test: Task 1 "a finished session read days later keeps its own session date", plus a live check in Task 6.*
4. **Dark theme:** the dark-red and dark-green arrows must stay visible on the dark surface `#16213e`. *Check: Task 4, Step 6 (dark theme toggle).*
5. **Expired login during auto-refresh:** a 401 from `/api/market-direction` must not blank a populated strip or throw. *Check: Task 4, Step 6 (log out in another tab, wait 60s).*

---

### Task 1: Pure scoring function

**Files:**
- Create: `src/services/market-direction.ts`
- Create: `tests/market-direction.test.ts`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `computeDirection(input: DirectionInput): Reading`
  - `nyDate(unixSec: number): string`
  - types `DirectionInput`, `Reading`, `UnavailableReason`
  - constants `WINDOW_MINUTES = 90`, `MAX_FILL_MINUTES = 3`, `MIN_COVERAGE = 0.9`

  All times are **unix seconds**; `fullScale` is a **fraction** (0.005 = 0.5%). `Reading` carries `sessionDate` and `sessionEnd`, which Task 2 uses to decide `marketState`.

- [ ] **Step 1: Write the failing tests**

Create `tests/market-direction.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeDirection, type DirectionInput } from "../src/services/market-direction.js";

// Fri 2026-10-02, 9:30–16:00 ET (EDT = UTC−4).
const START = Date.UTC(2026, 9, 2, 13, 30) / 1000;
const END = START + 390 * 60;
const P = 100;

/** closes[0] is minute 1 (the 9:30 bar). `now` defaults to the end of the last bar. */
function input(closes: (number | null)[], overrides: Partial<DirectionInput> = {}): DirectionInput {
  return {
    timestamps: closes.map((_, i) => START + i * 60),
    closes,
    priorClose: P,
    sessionStart: START,
    sessionEnd: END,
    now: START + closes.length * 60,
    fullScale: 0.005,
    ...overrides,
  };
}

/** c_k = P × (1 + 0.0001k), k = 1..n */
function linearRise(n: number): number[] {
  return Array.from({ length: n }, (_, i) => P * (1 + 0.0001 * (i + 1)));
}

describe("computeDirection — scoring", () => {
  it("linear rise of +0.01%/min over 120 min: f = 1, s = d", () => {
    // B_120 = mean(c_31..c_120) = 100.755; price 101.2; d = (0.445/100.755)/0.005
    const r = computeDirection(input(linearRise(120)));
    expect(r.status).toBe("ok");
    expect(r.minute).toBe(120);
    expect(r.baseline).toBeCloseTo(100.755, 9);
    expect(r.sameSidePct).toBeCloseTo(100, 9);
    expect(r.score).toBeCloseTo(0.4450 / 100.755 / 0.005, 9); // ≈ 0.883331
  });

  it("clamps distance before applying f: saturated d with f = 0.4 gives 0.4", () => {
    // 54 minutes at 99 (below), then 36 at 102 (above). B_90 = 100.2, distance 1.8% ≫ 0.5%.
    const closes = [...Array(54).fill(99), ...Array(36).fill(102)];
    const r = computeDirection(input(closes));
    expect(r.baseline).toBeCloseTo(100.2, 9);
    expect(r.sameSidePct).toBeCloseTo(40, 9);
    expect(r.score).toBeCloseTo(0.4, 9);
  });

  it("alternating ±0.05% around 100: f = 0.5, d = −0.1, s = −0.05", () => {
    const closes = Array.from({ length: 90 }, (_, i) => (i % 2 === 0 ? 100.05 : 99.95));
    const r = computeDirection(input(closes));
    expect(r.price).toBe(99.95);
    expect(r.baseline).toBeCloseTo(100, 9);
    expect(r.sameSidePct).toBeCloseTo(50, 9);
    expect(r.score).toBeCloseTo(-0.05, 6);
  });

  it("baseline formula switches cleanly at minutes 89 / 90 / 91", () => {
    const series = Array.from({ length: 91 }, (_, i) => P + 0.01 * (i + 1)); // c_k = 100 + 0.01k
    expect(computeDirection(input(series.slice(0, 89))).baseline).toBeCloseTo(100.445, 9); // (100 + Σc_1..89)/90
    expect(computeDirection(input(series.slice(0, 90))).baseline).toBeCloseTo(100.455, 9); // Σc_1..90 / 90
    expect(computeDirection(input(series.slice(0, 91))).baseline).toBeCloseTo(100.465, 9); // Σc_2..91 / 90
  });

  it("minute 0: baseline equals prior close and there is no score", () => {
    const r = computeDirection(input([], { now: START + 30 }));
    expect(r.status).toBe("unavailable");
    expect(r.reason).toBe("pre-first-bar");
    expect(r.baseline).toBe(P);
    expect(r.score).toBeNull();
    expect(r.sessionDate).toBe("2026-10-02");
  });

  it("gap-up held flat at 102 decays as the prior close fades out", () => {
    const at = (n: number) => computeDirection(input(Array(n).fill(102))).score;
    expect(at(10)).toBe(1);                         // B = 100.222, distance 1.77% → clamped
    expect(at(80)).toBeCloseTo(2 / 916 / 0.005, 9);  // B = 916/9, ≈ 0.436681
    expect(at(89)).toBeCloseTo(2 / 9178 / 0.005, 9); // B = 9178/90, ≈ 0.043582
    expect(at(90)).toBe(0);                         // B = 102 exactly → tie
  });

  it("price exactly on the baseline scores 0", () => {
    const r = computeDirection(input(Array(120).fill(P)));
    expect(r.status).toBe("ok");
    expect(r.score).toBe(0);
    expect(r.sameSidePct).toBe(0);
  });

  it("tied historical minutes count toward neither side but stay in the denominator", () => {
    // 89 ties at 100, then 101 at minute 90: B_90 = 9001/90, distance ≈ 0.989% → d = 1, f = 1/90
    const r = computeDirection(input([...Array(89).fill(P), 101]));
    expect(r.sameSidePct).toBeCloseTo(100 / 90, 9);
    expect(r.score).toBeCloseTo(1 / 90, 9);
  });
});

describe("computeDirection — data hygiene", () => {
  const expected = computeDirection(input(linearRise(120))).score!;

  it("sorts out-of-order bars and lets the later duplicate win", () => {
    const base = input(linearRise(120));
    const pairs = base.timestamps.map((t, i) => [t, base.closes[i]] as const).reverse();
    const timestamps = [START + 49 * 60, ...pairs.map(p => p[0])];   // bogus minute-50 bar first
    const closes = [999, ...pairs.map(p => p[1])];
    const r = computeDirection({ ...base, timestamps, closes });
    expect(r.score).toBeCloseTo(expected, 12);
  });

  it("fills a single null close and reports coverage", () => {
    const closes: (number | null)[] = linearRise(120);
    closes[59] = null;                                               // minute 60
    const r = computeDirection(input(closes));
    expect(r.status).toBe("ok");
    expect(r.coverage).toBeCloseTo(89 / 90, 12);
  });

  it("fills a 3-minute gap", () => {
    const closes: (number | null)[] = linearRise(120);
    closes[59] = closes[60] = closes[61] = null;
    const r = computeDirection(input(closes));
    expect(r.status).toBe("ok");
    expect(r.coverage).toBeCloseTo(87 / 90, 12);
  });

  it("a 4-minute gap makes the reading unavailable", () => {
    const closes: (number | null)[] = linearRise(120);
    closes[59] = closes[60] = closes[61] = closes[62] = null;
    const r = computeDirection(input(closes));
    expect(r.status).toBe("unavailable");
    expect(r.reason).toBe("insufficient-data");
  });

  it("window coverage under 90% makes the reading unavailable", () => {
    const closes: (number | null)[] = linearRise(120);
    for (const start of [39, 49, 59, 69]) closes[start] = closes[start + 1] = closes[start + 2] = null;
    const r = computeDirection(input(closes));
    expect(r.status).toBe("unavailable");
    expect(r.reason).toBe("insufficient-data");
    expect(r.coverage).toBeCloseTo(78 / 90, 12);
  });

  it("drops the bar that is still forming", () => {
    const r = computeDirection(input(linearRise(120), { now: START + 120 * 60 - 30 }));
    expect(r.minute).toBe(119);
    expect(r.asOf).toBe(START + 119 * 60);
  });

  it("excludes the 16:00 closing-print bar", () => {
    const closes = Array(390).fill(P);
    const base = input(closes, { now: END + 3600 });
    const r = computeDirection({ ...base, timestamps: [...base.timestamps, END], closes: [...closes, 150] });
    expect(r.minute).toBe(390);
    expect(r.price).toBe(P);
    expect(r.asOf).toBe(END);
  });

  it("honors an early close: bars after a 1 p.m. session end are ignored", () => {
    const earlyEnd = START + 210 * 60;                               // 13:00 ET
    const r = computeDirection(input(Array(390).fill(P), { sessionEnd: earlyEnd, now: END }));
    expect(r.minute).toBe(210);
    expect(r.asOf).toBe(earlyEnd);
    expect(r.sessionEnd).toBe(earlyEnd);
  });

  it("no bars at all is pre-first-bar", () => {
    expect(computeDirection(input([], { now: START + 600 })).reason).toBe("pre-first-bar");
  });

  it.each([
    ["priorClose 0", { priorClose: 0 }],
    ["priorClose NaN", { priorClose: NaN }],
    ["fullScale 0", { fullScale: 0 }],
    ["start ≥ end", { sessionEnd: START }],
    ["mismatched arrays", { closes: [P] }],
  ])("invalid input (%s) is unavailable, not a throw", (_label, overrides) => {
    const r = computeDirection(input(linearRise(10), overrides as Partial<DirectionInput>));
    expect(r.status).toBe("unavailable");
    expect(r.reason).toBe("invalid-input");
  });

  it("a finished session read days later keeps its own session date", () => {
    const r = computeDirection(input(Array(390).fill(P), { now: Date.UTC(2026, 9, 5, 16) / 1000 }));
    expect(r.status).toBe("ok");
    expect(r.minute).toBe(390);
    expect(r.sessionDate).toBe("2026-10-02");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/market-direction.test.ts`
Expected: FAIL; the module `../src/services/market-direction.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

Create `src/services/market-direction.ts`:

```ts
// Pure market-direction scoring. No network or clock access — `now` is an input.
// Spec: docs/superpowers/specs/2026-10-04-market-direction-arrows-design.md

export const WINDOW_MINUTES = 90;
export const MAX_FILL_MINUTES = 3;
export const MIN_COVERAGE = 0.9;
// Relative tolerance for "exactly on the baseline" (guards float noise in sums).
const TIE_EPSILON = 1e-9;

export interface DirectionInput {
  timestamps: number[];          // unix seconds, bar START times
  closes: (number | null)[];
  priorClose: number;
  sessionStart: number;          // unix seconds, regular session start
  sessionEnd: number;            // unix seconds, regular session end (exclusive)
  now: number;                   // unix seconds
  fullScale: number;             // fraction, e.g. 0.005 for 0.5%
}

export type UnavailableReason =
  | "invalid-input" | "pre-first-bar" | "insufficient-data" | "fetch-failed";

export interface Reading {
  status: "ok" | "unavailable";
  reason?: UnavailableReason;
  score: number | null;          // −1..1
  distancePct: number | null;    // (price − baseline) / baseline × 100
  sameSidePct: number | null;    // f × 100
  baseline: number | null;
  price: number | null;
  asOf: number | null;           // unix seconds, end of the latest included minute
  minute: number;                // n of the latest included bar (0 = none)
  coverage: number | null;       // real bars in window / window size
  sessionDate: string | null;    // YYYY-MM-DD, America/New_York
  sessionEnd: number | null;     // unix seconds
}

export function nyDate(unixSec: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" })
    .format(new Date(unixSec * 1000));
}

function unavailable(
  reason: UnavailableReason,
  extra: Partial<Reading> = {},
): Reading {
  return {
    status: "unavailable", reason,
    score: null, distancePct: null, sameSidePct: null, baseline: null,
    price: null, asOf: null, minute: 0, coverage: null,
    sessionDate: null, sessionEnd: null,
    ...extra,
  };
}

function side(value: number, baseline: number): -1 | 0 | 1 {
  const diff = value - baseline;
  if (Math.abs(diff) <= Math.abs(baseline) * TIE_EPSILON) return 0;
  return diff > 0 ? 1 : -1;
}

export function computeDirection(input: DirectionInput): Reading {
  const { timestamps, closes, priorClose, sessionStart, sessionEnd, now, fullScale } = input;

  const validInput =
    Array.isArray(timestamps) && Array.isArray(closes) &&
    timestamps.length === closes.length &&
    Number.isFinite(priorClose) && priorClose > 0 &&
    Number.isFinite(fullScale) && fullScale > 0 &&
    Number.isFinite(sessionStart) && Number.isFinite(sessionEnd) &&
    sessionStart < sessionEnd && Number.isFinite(now);
  if (!validInput) return unavailable("invalid-input");

  const session = { sessionDate: nyDate(sessionStart), sessionEnd };

  // Collect completed regular-session bars, keyed by minute number.
  // Duplicates: the later occurrence in input order wins.
  const bars = new Map<number, { ts: number; close: number }>();
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const close = closes[i];
    if (!Number.isFinite(ts) || typeof close !== "number" || !Number.isFinite(close) || close <= 0) continue;
    if (ts < sessionStart || ts >= sessionEnd) continue;   // excludes the 16:00 print
    if (ts + 60 > now) continue;                            // still forming
    const minute = Math.floor((ts - sessionStart) / 60) + 1;
    bars.set(minute, { ts, close });
  }

  if (bars.size === 0) {
    return unavailable("pre-first-bar", { ...session, baseline: priorClose });
  }

  const n = Math.max(...bars.keys());

  // Filled series c[1..n]; real[k] marks provider bars.
  const c = new Array<number>(n + 1);
  const real = new Array<boolean>(n + 1).fill(false);
  let prev = priorClose;
  let run = 0;
  for (let k = 1; k <= n; k++) {
    const bar = bars.get(k);
    if (bar) {
      c[k] = bar.close;
      real[k] = true;
      run = 0;
    } else {
      run++;
      if (run > MAX_FILL_MINUTES) {
        return unavailable("insufficient-data", { ...session, minute: n });
      }
      c[k] = prev;
    }
    prev = c[k];
  }

  // Baseline for every minute (needed before trimming the persistence window).
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let k = 1; k <= n; k++) prefix[k] = prefix[k - 1] + c[k];
  const B = new Array<number>(n + 1);
  for (let k = 1; k <= n; k++) {
    B[k] = k < WINDOW_MINUTES
      ? ((WINDOW_MINUTES - k) * priorClose + prefix[k]) / WINDOW_MINUTES
      : (prefix[k] - prefix[k - WINDOW_MINUTES]) / WINDOW_MINUTES;
  }

  const first = Math.max(1, n - WINDOW_MINUTES + 1);
  const windowSize = n - first + 1;
  let realCount = 0;
  for (let i = first; i <= n; i++) if (real[i]) realCount++;
  const coverage = realCount / windowSize;
  if (realCount === 0 || coverage < MIN_COVERAGE) {
    return unavailable("insufficient-data", { ...session, minute: n, coverage });
  }

  const price = c[n];
  const baseline = B[n];
  const sideNow = side(price, baseline);

  let sameSide = 0;
  if (sideNow !== 0) {
    for (let i = first; i <= n; i++) {
      if (real[i] && side(c[i], B[i]) === sideNow) sameSide++;
    }
  }
  const f = sameSide / realCount;

  const distance = (price - baseline) / baseline;
  const d = Math.max(-1, Math.min(1, distance / fullScale));   // clamp BEFORE × f
  const raw = sideNow === 0 ? 0 : d * f;
  const score = raw === 0 ? 0 : raw;                           // normalize −0

  return {
    status: "ok",
    score,
    distancePct: distance * 100,
    sameSidePct: f * 100,
    baseline,
    price,
    asOf: bars.get(n)!.ts + 60,
    minute: n,
    coverage,
    ...session,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/market-direction.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Add the file to the default suite**

In `package.json`, change the `test` script to:

```json
    "test": "vitest run tests/alert-evaluator.test.ts tests/market-direction.test.ts",
```

Run: `npm test && npm run build`
Expected: both suites pass; `tsc --noEmit` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/services/market-direction.ts tests/market-direction.test.ts package.json
git commit -m "Add market direction scoring function

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Fetch and orchestration service

**Files:**
- Create: `src/services/market-direction-service.ts`
- Create: `tests/market-direction-service.test.ts`
- Modify: `package.json` (the `test` script)

**Interfaces:**
- Consumes (from Task 1): `computeDirection`, `nyDate`, `Reading`. Also `isMarketOpen(): Promise<boolean>` from `src/utils/market-hours.ts`.
- Produces:
  - `getMarketDirection(): Promise<MarketDirection>`, used by Task 3.
  - `createMarketDirectionService(deps?: ServiceDeps)` → `{ get }`, used by the tests.
  - `fetchIndexBars(symbol, opts?)`
  - `INDEXES: IndexConfig[]`
  - types `MarketDirection` (`{ marketState: "open" | "closed"; fetchedAt; indexes: IndexReading[] }`) and `IndexReading` (`Reading` + `symbol`, `label`, `dataQuality`, `staleFromError`). Task 4's front end reads exactly these field names.

- [ ] **Step 1: Write the failing tests**

Create `tests/market-direction-service.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/market-direction-service.test.ts`
Expected: FAIL; the module `../src/services/market-direction-service.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

Create `src/services/market-direction-service.ts`:

```ts
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
  return {
    timestamps: result.timestamp ?? [],
    closes: result.indicators?.quote?.[0]?.close ?? [],
    priorClose,
    sessionStart: regular.start,
    sessionEnd: regular.end,
  };
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
```

Notes for the implementer:
- `getMarketDirection` is a module-level singleton, so its cache and last-good map survive across requests within a warm serverless instance. A cold start begins empty. That's acceptable: a failure with no previous reading shows Unavailable.
- Fetching stays sequential on purpose, matching `fetchPrices` in `src/services/price-fetcher.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/market-direction-service.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Add the file to the default suite**

In `package.json`, change the `test` script to:

```json
    "test": "vitest run tests/alert-evaluator.test.ts tests/market-direction.test.ts tests/market-direction-service.test.ts",
```

Run: `npm test && npm run build`
Expected: all three files pass; `tsc` is clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/market-direction-service.ts tests/market-direction-service.test.ts package.json
git commit -m "Add market direction fetch service with per-symbol failure isolation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: API endpoint

**Files:**
- Modify: `src/server.ts`: add an import near line 18 and a route after `GET /api/price/:symbol` (~line 574)

**Interfaces:**
- Consumes (from Task 2): `getMarketDirection(): Promise<MarketDirection>`.
- Produces: `GET /api/market-direction`. It requires a session and returns the `MarketDirection` JSON (HTTP 200), 401 when not logged in, or 500 `{ error }` on an unexpected failure.

This repo has no reliable server test harness (`tests/server.test.ts` expects an already-running server; see CLAUDE.md), so this task is verified with the type check plus a live request.

- [ ] **Step 1: Add the import**

In `src/server.ts`, below `import { fetchSinglePrice, fetchPrices } from "./services/price-fetcher.js";` add:

```ts
import { getMarketDirection } from "./services/market-direction-service.js";
```

- [ ] **Step 2: Add the route**

Directly after the `app.get("/api/price/:symbol", …)` handler, before the `// ── Cron endpoint` comment, add:

```ts
app.get("/api/market-direction", requireAuth, async (_req, res) => {
  try {
    res.json(await getMarketDirection());
  } catch (err) {
    console.error("GET /api/market-direction error:", (err as Error).message);
    res.status(500).json({ error: "Failed to load market direction" });
  }
});
```

- [ ] **Step 3: Type-check and run the suite**

Run: `npm run build && npm test`
Expected: clean `tsc`; all tests pass.

- [ ] **Step 4: Live check**

Run `npm run web` in one terminal. In another:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/market-direction
```

Expected: `401`, which confirms the route exists behind `requireAuth`. Then log in at http://localhost:3000 in a browser and open http://localhost:3000/api/market-direction. Expected: JSON with `marketState` and 4 `indexes`, each with `status`, `score`, `distancePct`, `asOf`, `sessionDate` and `dataQuality`. On a weekend or after hours: `marketState: "closed"`, the last session's date, and `status: "ok"`. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "Add GET /api/market-direction endpoint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Dashboard strip

**Files:**
- Modify: `public/index.html`:
  - CSS: insert before the `@media (max-width: 640px)` block (~line 209)
  - markup: inside `#dashboard`, directly above `<div class="tab-bar container" …>` (~line 358)
  - JS: helpers inserted directly after the `esc()` function (~line 834)
  - a hook in `showDashboard()` (~line 567)
  - a hook in the 60s `setInterval` (~line 1268)

**Interfaces:**
- Consumes (from Tasks 2–3): `GET /api/market-direction` → `{ marketState, indexes: [{ symbol, label, status, reason, score, distancePct, sameSidePct, baseline, price, asOf, minute, coverage, sessionDate, dataQuality, staleFromError }] }`. Also the existing `esc(str)` helper and CSS tokens (`--surface`, `--border`, `--text*`, `--badge-off-*`, `--card-shadow`).
- Produces: `loadMarketDirection()`, `renderMarketStrip(md)`, `toggleMdPop(i)` and `mdColor(s)` (globals in the inline script).

There is no front-end test harness (the dashboard is a single static file), so verification is manual in Step 6.

- [ ] **Step 1: Add the CSS**

Insert before `@media (max-width: 640px) {`:

```css
    /* ── Market direction strip ── */
    .md-strip {
      position: relative; display: grid; gap: 8px; margin: 12px auto 0;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    }
    .md-tile {
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      background: var(--surface); color: var(--text); border: 1px solid var(--border);
      border-radius: 8px; padding: 8px 6px; font: inherit; text-align: center; cursor: pointer;
    }
    .md-tile.closed .md-arrow { opacity: 0.55; }
    .md-label { font-weight: 600; font-size: 13px; }
    .md-arrow { width: 36px; height: 36px; display: block; }
    [data-theme="dark"] .md-arrow { filter: drop-shadow(0 0 1.5px rgba(255,255,255,0.7)); }
    .md-dash { font-size: 24px; line-height: 36px; color: var(--text-faint); }
    .md-dist, .md-asof { font-size: 12px; color: var(--text-secondary); }
    .md-badge {
      font-size: 11px; padding: 1px 6px; border-radius: 10px;
      background: var(--badge-off-bg); color: var(--badge-off-color);
    }
    .md-pop {
      display: none; position: absolute; left: 16px; right: 16px; top: 100%; z-index: 20;
      margin-top: 6px; padding: 8px 10px; text-align: left; font-size: 12px; line-height: 1.5;
      background: var(--surface); color: var(--text); border: 1px solid var(--border);
      border-radius: 6px; box-shadow: 0 2px 8px var(--card-shadow);
    }
    .md-tile:hover .md-pop, .md-tile:focus-visible .md-pop,
    .md-tile[aria-expanded="true"] .md-pop { display: block; }
    .md-strip-msg { grid-column: 1 / -1; font-size: 12px; color: var(--text-muted); }
```

`.md-pop` is positioned against `.md-strip` (the tiles aren't positioned), so it spans the strip's width below the tiles. That way it never overflows the side of a 320px screen.

- [ ] **Step 2: Add the markup**

Directly above `<div class="tab-bar container" style="margin:12px auto 0;">` inside `<div id="dashboard" class="hidden">`:

```html
    <div id="marketStrip" class="md-strip container" aria-label="Market direction"></div>
```

- [ ] **Step 3: Add the JS helpers**

Insert directly after the closing `}` of `function esc(str) { … }`:

```js
    // ── Market direction strip ────────────────────────────────────────────
    const MD_STOPS = [[-1, "#8B0000"], [-1 / 3, "#E67E00"], [1 / 3, "#D4A800"], [1, "#006400"]];
    const MD_BADGE = { delayed: "Delayed", incomplete: "Incomplete", unavailable: "Unavailable" };
    const MD_REASON = {
      "pre-first-bar": "Waiting for first minute",
      "insufficient-data": "Not enough data",
      "fetch-failed": "Data source unavailable",
      "invalid-input": "Bad data from source",
    };
    const MD_EXPLAIN = "Up means price is above its recent 90-minute baseline and has mostly stayed there. " +
      "It can still point up during a short pullback.";
    let mdOpenIndex = -1;

    function mdColor(s) {
      let i = 0;
      while (i < MD_STOPS.length - 2 && s > MD_STOPS[i + 1][0]) i++;
      const [a, colA] = MD_STOPS[i], [b, colB] = MD_STOPS[i + 1];
      const p = Math.min(1, Math.max(0, (s - a) / (b - a)));
      return `color-mix(in oklab, ${colB} ${(p * 100).toFixed(1)}%, ${colA})`;
    }

    function mdTime(sec, withDate) {
      const opts = { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" };
      if (withDate) Object.assign(opts, { weekday: "short", month: "short", day: "numeric" });
      return new Date(sec * 1000).toLocaleString("en-US", opts) + " ET";
    }

    function renderMarketStrip(md) {
      const closed = md.marketState === "closed";
      document.getElementById("marketStrip").innerHTML = md.indexes.map((r, i) => {
        const ok = r.status === "ok";
        const arrow = ok
          ? `<svg class="md-arrow" viewBox="0 0 24 24" aria-hidden="true"
               style="transform:rotate(${(-r.score * 90).toFixed(1)}deg);color:${mdColor(r.score)}">
               <path d="M3 10.5h12V6l7 6-7 6v-4.5H3z" fill="currentColor"/></svg>`
          : `<span class="md-dash" aria-hidden="true">–</span>`;
        const dist = ok
          ? `${r.distancePct >= 0 ? "+" : ""}${r.distancePct.toFixed(2)}% vs. baseline`
          : (MD_REASON[r.reason] || "Unavailable");
        const asOf = r.asOf ? (closed ? "Closed · " : "as of ") + mdTime(r.asOf, closed) : "";
        const badges = [
          r.dataQuality !== "ok" ? MD_BADGE[r.dataQuality] : null,
          r.staleFromError ? "Last good reading" : null,
        ].filter(Boolean).map(b => `<span class="md-badge">${esc(b)}</span>`).join("");
        const details = ok
          ? `Baseline ${r.baseline.toFixed(2)} · price ${r.price.toFixed(2)}<br>` +
            `On the same side ${r.sameSidePct.toFixed(0)}% of the last ${Math.min(r.minute, 90)} min<br>` +
            `Score ${r.score.toFixed(2)} · data coverage ${(r.coverage * 100).toFixed(0)}%<br>`
          : "";
        const label = `${r.label}: ${ok ? `score ${r.score.toFixed(2)}, ${dist}` : dist}`;
        return `<button type="button" class="md-tile${closed ? " closed" : ""}"
            aria-label="${esc(label)}" aria-describedby="mdPop${i}"
            aria-expanded="${i === mdOpenIndex}" onclick="toggleMdPop(${i})">
          <span class="md-label">${esc(r.label)}</span>${arrow}
          <span class="md-dist">${esc(dist)}</span>
          <span class="md-asof">${esc(asOf)}</span>${badges}
          <span class="md-pop" id="mdPop${i}" role="tooltip">${details}${esc(MD_EXPLAIN)}</span>
        </button>`;
      }).join("");
    }

    function toggleMdPop(i) {
      mdOpenIndex = mdOpenIndex === i ? -1 : i;
      document.querySelectorAll(".md-tile").forEach((b, j) =>
        b.setAttribute("aria-expanded", String(j === mdOpenIndex)));
    }

    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && mdOpenIndex !== -1) toggleMdPop(mdOpenIndex);
    });

    async function loadMarketDirection() {
      const strip = document.getElementById("marketStrip");
      try {
        const res = await fetch("/api/market-direction");
        if (!res.ok) throw new Error(String(res.status));
        renderMarketStrip(await res.json());
      } catch {
        // Keep a populated strip (its "as of" times stay honest); only fill an empty one.
        if (!strip.children.length) {
          strip.innerHTML = `<div class="md-strip-msg">Market direction unavailable</div>`;
        }
      }
    }
```

- [ ] **Step 4: Hook up loading and refresh**

In `showDashboard()`, after `loadAlerts();` add:

```js
      loadMarketDirection();
```

In the boot `setInterval`, change the body to:

```js
      if (!dashboard.classList.contains("hidden")) {
        loadPrices();
        loadMarketDirection();
      }
```

- [ ] **Step 5: Confirm nothing else broke**

Run: `npm run build && npm test`
Expected: clean; all tests pass. The HTML isn't type-checked, so this only guards the server.

- [ ] **Step 6: Manual verification**

Run `npm run web`, log in at http://localhost:3000, and check each item (Chrome DevTools device toolbar for widths):
1. Four tiles appear above the Watchlist/Shortlist tabs and stay visible on both tabs.
2. Each tile shows its label, an arrow, "±x.xx% vs. baseline" and "as of …"/"Closed · Fri Oct 2, 4:00 PM ET".
3. The arrows are rotated and colored consistently: a positive `score` points above horizontal and leans green/gold; a negative one points below and leans orange/red. Compare against `/api/market-direction`.
4. Hover a tile: the popover appears below the strip. Tab to a tile: it appears on keyboard focus. Click/tap a tile: it stays open; tap again or press Escape: it closes.
5. At 320px width: tiles wrap to 2×2 or narrower; there's no horizontal page scroll; the popover stays inside the screen.
6. Chrome Settings → Appearance → Font size "Very large" (or 200% zoom): text is still readable and tiles wrap rather than overlap.
7. Toggle the dark theme: dark-red and dark-green arrows are still clearly visible (Review Focus 4).
8. Temporarily change `INDEXES[2].symbol` in `src/services/market-direction-service.ts` to `"^BOGUS"`, restart and reload. Nasdaq shows a dash, "Data source unavailable" and an "Unavailable" badge; the other three render. **Revert the change.**
9. Log out in a second tab, then wait more than 60s on the first: the strip keeps its last render and nothing throws in the console (Review Focus 5).

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "Add market direction strip to dashboard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none.

- [ ] **Step 1: Update the Commands block**

Replace the `npm test` line with:

```
npm test           # vitest run — alert-evaluator + market-direction suites (no CI or pre-commit hook)
```

- [ ] **Step 2: Add a section after "### Alert types (strategy pattern, …)"**

```markdown
### Market direction strip (`src/services/market-direction*.ts`)

The dashboard shows one arrow for each of `^GSPC ^DJI ^IXIC ^RUT`, served by `GET /api/market-direction` (requires login). It's independent of alerts and the scheduler, and stores nothing in the database.

- **`market-direction.ts`** is the pure scoring. It takes Yahoo 1-minute bars (`interval=1m&range=1d`) and:
  - keeps completed regular-session bars only (Yahoo's `currentTradingPeriod.regular`, which excludes the 16:00 print)
  - fills up to 3 consecutive missing minutes and needs ≥90% coverage in the window
  - uses a 90-minute baseline, with the prior close filling the pre-open part of the window
  - scores `s = clamp(distance/fullScale) × f`, where f is the share of window minutes on the current side of their own baseline
- **`market-direction-service.ts`** handles I/O:
  - fetches symbols one at a time with an 8s timeout each
  - uses a shared in-flight promise and a 60s cache
  - isolates failures per symbol, keeping the last good reading (lost on a serverless cold start)
  - sets `marketState` and `dataQuality` as separate fields

  `marketState` is open only if `isMarketOpen()` is true **and** the bars are from today's session. That guards against the `isNyseHours()` fallback in `src/utils/market-hours.ts`, which ignores holidays and early closes.
- Per-index `fullScale` and `lagThresholdSec` live in `INDEXES`. They're set from a live measurement; see the spec `docs/superpowers/specs/2026-10-04-market-direction-arrows-design.md`.
```

- [ ] **Step 3: Update the Frontend section**

At the end of the "### Frontend" section, add:

```markdown
A market-direction strip (`#marketStrip`, `loadMarketDirection()`) sits above the tab buttons and refreshes in the same 60s interval as prices. Arrow angle = `score × 90°`; color = `color-mix(in oklab, …)` between four stops (`mdColor()`).
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Document market direction strip in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Live calibration (must run on a weekday, 9:30 AM–4:00 PM ET)

This is the spec's remaining live check. Its script is **throwaway**: keep it in the session scratchpad, not the repo. Only the resulting constants and the notes are committed.

**Files:**
- Modify: `src/services/market-direction-service.ts` (`INDEXES` values only)
- Modify: `docs/superpowers/specs/2026-10-04-market-direction-arrows-design.md` ("Data source" section)

**Interfaces:** none new.

- [ ] **Step 1: Write the probe script** (scratchpad, e.g. `probe.mjs`)

```js
const SYMBOLS = ["^GSPC", "^DJI", "^IXIC", "^RUT"];
async function snap(sym) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`,
    { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
  const r = (await res.json()).chart.result[0];
  const ts = r.timestamp ?? [], c = r.indicators.quote[0].close ?? [];
  const now = Date.now() / 1000, last = ts[ts.length - 1];
  const expected = Math.floor((Math.min(now, r.meta.currentTradingPeriod.regular.end) - r.meta.currentTradingPeriod.regular.start) / 60);
  return { sym, lagSec: Math.round(now - (last + 60)), lastClose: c[c.length - 1], bars: ts.length,
           expectedMinutes: expected, nulls: c.filter(x => x == null).length,
           chartPreviousClose: r.meta.chartPreviousClose, regular: r.meta.currentTradingPeriod.regular };
}
for (let round = 0; round < 10; round++) {
  console.log(new Date().toISOString(), JSON.stringify(await Promise.all(SYMBOLS.map(snap))));
  await new Promise(r => setTimeout(r, 30_000));
}
```

- [ ] **Step 2: Run it during market hours, and once before 9:30 AM ET if possible**

Run: `node probe.mjs > probe-$(date +%H%M).log`
Record for each symbol:
- typical and maximum `lagSec`
- whether `lastClose` of the same `last` timestamp changes between rounds (a bar still forming)
- `bars` vs `expectedMinutes` (missing minutes) and `nulls`
- whether `chartPreviousClose` equals the prior session's official close

Before 9:30 (pre-open), record which session `regular` refers to and whether any bars come back.

- [ ] **Step 3: Set the constants**

In `INDEXES`, set each `lagThresholdSec` to max(300, observed max lag + 120). If a bar was seen still forming even though `ts + 60 ≤ now`, report it to the user before changing any logic. If `fullScale` looks badly off from a day of readings (an index pinned at ±1 most of the day, or never above ±0.2), propose new values to the user rather than changing them silently.

Run: `npm test && npm run build`
Expected: pass/clean. The tests use their own `IndexConfig`, so the constants don't affect them.

- [ ] **Step 4: Record the findings in the spec**

In the spec's "Data source" section, replace the "Still to verify during a live session" list with the measured results (date, lag per symbol, forming-bar behavior, pre-open behavior).

- [ ] **Step 5: Commit**

```bash
git add src/services/market-direction-service.ts docs/superpowers/specs/2026-10-04-market-direction-arrows-design.md
git commit -m "Calibrate market direction lag thresholds from live data

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:**
  - Bars, gaps and coverage rules: Task 1.
  - Baseline and persistence: Task 1.
  - Score, clamp order and ties: Task 1.
  - Invalid input: Task 1.
  - States, delay vs failure, timeouts, in-flight sharing, last-good readings: Task 2.
  - Endpoint: Task 3.
  - Angle, color, labels, popover, 2×2 layout and the Unavailable dash: Task 4.
  - CLAUDE.md note: Task 5.
  - Live verification list: Task 6.
- **Departure from the spec:** the spec puts everything in one `market-direction.ts`. This plan splits I/O into `market-direction-service.ts` so the pure function stays network-free and the service can be tested with injected dependencies.
