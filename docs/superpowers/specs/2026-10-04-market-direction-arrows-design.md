# Market Direction Arrows — Design

**Date:** 2026-10-04
**Status:** Draft, awaiting user review

## Purpose

A compact strip above the dashboard tabs shows one arrow for each of four US indexes. The arrow summarizes how the market has moved over the trailing ~90 minutes. Its **angle** and **color** reflect both how far price sits from a recent baseline and how persistently it has stayed on that side.

The strip is a backward-looking mood gauge, not a forecast. Known limitations are listed at the end.

## Indexes

| Label | Yahoo symbol | fullScale (initial) |
|---|---|---|
| S&P 500 | `^GSPC` | 0.50% |
| Dow | `^DJI` | 0.45% |
| Nasdaq | `^IXIC` (Composite) | 0.65% |
| Russell 2000 | `^RUT` | 0.90% |

`fullScale` is the distance from the baseline that counts as full strength for that index, to make up for indexes moving different amounts. These values are constants, to be revisited after the live data check.

There is **no ETF substitution.** QQQ tracks the Nasdaq-100, not the Composite, so swapping it in would change what's measured. A failed symbol shows **Unavailable**. If an index proves consistently unusable, any proxy must be labeled explicitly (e.g. "Nasdaq-100 · QQQ proxy") and use its own bars, prior close and fullScale throughout.

## Data source

`GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1m&range=1d`, with the same headers as `fetchChart` in `src/services/price-fetcher.ts`.

Observed on 2026-10-04 (weekend), for all four symbols:
- Returns the most recent session (Fri 10/2): 391 bars, 9:30 … 15:59 plus a 16:00 bar, no null closes, `exchangeTimezoneName = America/New_York`.
- Bar timestamps are **minute starts** (9:30 = the 9:30–9:31 bar).
- `meta.chartPreviousClose` equals `meta.previousClose`, the prior session's close.
- `meta.currentTradingPeriod.regular {start, end}` gives the session bounds, so early closes appear here.
- `meta.regularMarketTime` keeps updating after the close, so it can't measure delay. Only bar timestamps can.

**Still to verify during a live session** (spike, before implementation):
- Lag per symbol (`now − last bar end`), especially `^RUT`, which Yahoo labels as delayed.
- Whether the latest bar is still being formed (its close changes on a re-fetch).
- Null or missing bars intraday.
- The pre-open (before 9:30 ET) response.
- An early-close day, if one occurs before shipping; otherwise trust `regular.end`.

## Calculation

All of this lives in a pure function. It has no network or clock access; `now` is an input.

### Bars
1. Pair the timestamps with closes and drop entries with non-finite closes.
2. Sort by timestamp and remove duplicates (last occurrence wins).
3. Keep bars with `regular.start ≤ ts < regular.end`. This excludes the 16:00 print.
4. While the session is still running (`now < regular.end`), drop the latest bar if `ts + 60s > now` (still being formed).
5. The bar at `ts` is **minute n = (ts − start)/60 + 1**.

**Elapsed time** = n of the latest included bar, never the wall clock.
**price** = that bar's close.
**asOf** = `ts + 60s` of that bar. It's never the fetch time.

### Missing minutes
- A missing minute is filled with the previous close (or `priorClose` before the first bar), for at most **3 consecutive** minutes.
- A longer gap anywhere in the session up to minute n, or window coverage below 90% real bars, makes the reading **unavailable** (`reason: "insufficient-data"`).
- `coverage` = real bars in the window W / |W|, and is reported with every reading.

### Baseline (plumb line)
For minute k over the filled series `c_1 … c_k`, with P = priorClose:
- k < 90: `B_k = ((90 − k)·P + Σ_{i=1..k} c_i) / 90`
- k ≥ 90: `B_k = mean(c_{k−89} … c_k)`

The prior close fills the part of the 90-minute window from before the open and fades out linearly, so there's no jump at minute 90.

Minute 0 (no completed bar yet): the baseline is P, there's **no score**, and the reading is unavailable with `reason: "pre-first-bar"` ("Waiting for first minute").

### Persistence f
1. Compute `B_i` for **every** session minute first, then trim to the window **W = the last min(n, 90) minutes**. Persistence over 90 minutes can draw on up to ~180 minutes of prices; the full-session fetch provides them.
2. `side_i = sign(c_i − B_i)`; `side_now = sign(price − B_n)`. A tie (0) counts toward neither side.
3. `f = |{i ∈ W, real bar : side_i === side_now ≠ 0}| / |{i ∈ W : real bar}|`. Filled minutes are excluded from f.
4. If W has no real bars, the reading is unavailable.

### Score
```
d = clamp(((price − B_n) / B_n) / fullScale, −1, 1)
s = d × f              // clamp first, then multiply
```
- If `side_now === 0`, then s = 0.
- With d saturated and f = 0.4, s = 0.4.
- s is continuous across baseline crossings, because d → 0 there.

### Invalid input
If priorClose isn't finite and > 0, fullScale isn't finite and > 0, or start ≥ end, the reading is unavailable with a reason. The function never throws.

## Presentation

**Angle:** s × 90°, continuous. +90° points straight up, 0° straight right (flat), −90° straight down.

**Color:** blended in OKLab (`color-mix(in oklab, …)`) between these stops:

| s | Color |
|---|---|
| −1 | `#8B0000` dark red |
| −⅓ | `#E67E00` orange |
| +⅓ | `#D4A800` gold |
| +1 | `#006400` dark green |

Flat (s = 0) reads as amber.

**Unavailable:** no arrow. The tile shows a grey dash and "Unavailable". It never shows a neutral arrow.

**Tile contents:**
- The label.
- The arrow.
- **"+0.42% vs. baseline"**. It is never shown as a bare percentage, so it can't be mistaken for the day's change.
- "as of HH:MM ET", plus the session date when closed.
- A quality badge (Delayed / Incomplete / Unavailable).

**Details popover:** each tile is a focusable `<button>`. Hover, keyboard focus or tap opens a popover with:
- the baseline, % of time on the same side, the score and coverage
- the explanation: *"Up means price is above its recent 90-minute baseline and has mostly stayed there. It can still point up during a short pullback."*

**Layout:** a strip above the tab buttons, visible on both tabs. It uses CSS grid `repeat(auto-fit, minmax(…))`, which falls back to 2×2 when four across won't fit. It must stay readable at 320px width and at 200% text size.

**Refresh:** the dashboard loads it at startup and inside the existing 60s `setInterval`.

## States

Market state and data quality are **separate fields**, and any combination is allowed.

- **`marketState: open | closed`**. Open requires all three:
  - `isMarketOpen()` is true (the Alpaca clock, which knows holidays and early closes)
  - the bars' session date is today in America/New_York
  - `now < regular.end`

  The date check protects against the `isNyseHours()` fallback (`src/utils/market-hours.ts`), which knows weekdays and clock times only, reporting a holiday as open.
- **`dataQuality`**, set for each index:
  - `ok`
  - `delayed`: `now − asOf` > that symbol's `lagThresholdSec`. The default is 300s, to be set per symbol from the live data check.
  - `incomplete`: coverage < 100% but the reading is usable.
  - `unavailable`
- **Closed readings** show their session date ("Closed · Fri Oct 2, 4:00 PM ET"). They're always rebuilt from that session's Yahoo bars, so they stay tied to the right session after a server restart.

## Architecture

**`src/services/market-direction.ts`** (new):
- `computeDirection(input) → Reading`, the pure function above. `Reading` fields:
  - `status: "ok" | "unavailable"`, `reason?`
  - `score`, `distancePct`, `sameSidePct`, `baseline`, `price`
  - `asOf`, `minute`, `coverage`, `sessionDate`
- `fetchIndexBars(symbol)`: one Yahoo request with an 8s `AbortSignal.timeout`.
- `getMarketDirection()`:
  - fetches the symbols one at a time
  - uses a **shared in-flight promise**, so simultaneous callers await one batch
  - keeps a 60s result cache
  - handles errors per symbol: a failure keeps that symbol's last good reading, flagged `stale-from-error`, or shows Unavailable if there was none. The other symbols are unaffected.
- `INDEXES` config: `{ symbol, label, fullScale, lagThresholdSec }`.

**`src/server.ts`:** `GET /api/market-direction` with `requireAuth`, returning `{ marketState, indexes: Reading[] }`.

**`public/index.html`:** the strip markup, styles and `loadMarketDirection()`.

**No database changes.**

## Testing

`tests/market-direction.test.ts` gets added to `npm test`. It uses exact series with hand-computed expectations (`toBeCloseTo`, with the tolerance stated in each test).

**Scoring**
- **Linear rise:** +0.01%/min from P over 120 minutes, fullScale 0.5%. Expected d, f = 1 and s.
- **Clamp order:** saturated d with f = 0.4 gives s = 0.4.
- **Alternating ±0.05% around a flat level:** exact expected f and s.
- **Boundaries at n = 89 / 90 / 91:** the baseline formula changes over correctly; at minute 0, B = P and there's no score.
- **Gap-up held flat:** s decays along a hand-computed curve.
- **Ties:** price exactly equal to the baseline gives s = 0; historical tie minutes count toward neither side.

**Data hygiene**
- out-of-order and duplicate timestamps
- a null close
- a 3-minute gap (filled, coverage < 1)
- a 4-minute gap (unavailable)
- a last bar still forming (dropped)
- the 16:00 bar excluded

**Invalid input:** priorClose ≤ 0, NaN, or start ≥ end gives unavailable with a reason.

**Session rollover:** bars from a previous date with `now` on a new day give a closed reading carrying that session's date.

**Orchestration** (mocked fetcher)
- one symbol throws while three succeed
- one symbol times out
- two simultaneous calls trigger one batch
- a failure after a success keeps the last good reading, flagged

## Out of scope

- Alerts triggered by readings.
- A history chart.
- VIX.
- ETF proxies.
- Fixing the holiday and early-close handling in `isNyseHours()` (recorded in CLAUDE.md instead).

## Known limitations (for users)

- **It looks backward.** It describes the last ~90 minutes and has no proven power to predict the next one.
- **It confirms new directions late.** By design, a fresh reversal reads weak until it persists.
- **Choppy markets.** Readings near flat carry little information.
- **Cap weighting.** The S&P 500 and Nasdaq are dominated by their largest members, and the Dow is weighted by share price; none of them reflects a particular portfolio.
- **Time of day.** Readings at the open and at midday aren't directly comparable, because of volatility and volume differences.
- **Provider risk.** Yahoo's endpoint is undocumented. Delays and failures are shown as such, never hidden behind a neutral arrow.

## Changes since this spec (shipped in PRs #27, #29, #30)

This document records the original design. What shipped differs in these ways; CLAUDE.md describes the current behavior.

- **Compact tiles.** The strip is always one row of four tiles. Each tile shows only the label, the arrow and a warning badge; "% vs. baseline", the as-of/Closed time and the score details moved into the tap/click popover. The Russell 2000 label is "Russell 2K", and the "last good reading" badge is "Stale".
- **Popover behaviour.** Tap or click a tile to open it, and tap the same tile again to close it. Hover-to-preview only applies with a real mouse (`@media (hover: hover) and (pointer: fine)`), because touch browsers keep a tapped tile in `:hover`.
- **Dark theme.** There is no backdrop behind the arrow. The arrow is a heavier shape, and in dark theme it has a thin light outline.
- **Gap rule.** A gap longer than 3 minutes only makes a reading unavailable if it is recent enough to affect the scored window (minute ≥ n − 178). The spec said "anywhere in the session".
- **Pre-open.** If Yahoo's `currentTradingPeriod` has already rolled to the next day while the bars are still the previous day's, the session is anchored to the bars' own date.
- **Staleness and failures:**
  - A last good reading from an older session than freshly fetched data is dropped.
  - A reading from an earlier session is marked Delayed when the Alpaca clock says the market is open.
  - A Yahoo response whose timestamp and close arrays differ in length is treated as a fetch failure.
  - The Alpaca clock check times out after 5 s, and its missing-keys warning is logged once per process.
- **Still open.** Live calibration of `lagThresholdSec` and `fullScale` (Task 6 of the plan) has not run yet.
