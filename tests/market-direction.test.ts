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

  it("ignores a long gap too old to affect any baseline in the window", () => {
    // Window at n = 300 is minutes 211..300; its baselines reach back to minute 122.
    const closes: (number | null)[] = Array(300).fill(P);
    for (let i = 0; i < 6; i++) closes[i] = null;                    // minutes 1–6 missing (late open)
    closes[50] = closes[51] = closes[52] = closes[53] = null;        // minutes 51–54 missing
    const r = computeDirection(input(closes));
    expect(r.status).toBe("ok");
    expect(r.coverage).toBe(1);
  });

  it("still rejects a long gap that feeds a baseline in the window", () => {
    // Minutes 130–133 lie within n − 179 = 121, so they feed B_i for i in the window.
    const closes: (number | null)[] = Array(300).fill(P);
    closes[129] = closes[130] = closes[131] = closes[132] = null;
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
