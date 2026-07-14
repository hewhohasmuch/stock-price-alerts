import type {
  StockAlert,
  PriceResult,
  TriggeredAlert,
  AlertType,
  PercentChangeParams,
  TrailingHighParams,
  TrailingHighState,
} from "../types.js";

export interface EvaluationOutcome {
  triggered: TriggeredAlert[];
  /**
   * Alerts whose in-memory `state` was modified during evaluation (e.g. the
   * trailing high-water mark ratcheted up). The scheduler must persist these
   * even when nothing triggered.
   */
  stateUpdates: StockAlert[];
}

interface EvaluationResult {
  triggered: TriggeredAlert[];
  stateChanged?: boolean;
}

interface AlertEvaluator {
  evaluate(alert: StockAlert, price: PriceResult): EvaluationResult;
}

// ── absolute-threshold (legacy above/below columns) ─────────────────────

const absoluteThresholdEvaluator: AlertEvaluator = {
  evaluate(alert, price) {
    const triggered: TriggeredAlert[] = [];

    if (alert.abovePrice != null && price.price >= alert.abovePrice &&
        !hasBreachedToday(alert, "above")) {
      triggered.push({
        alert,
        currentPrice: price.price,
        direction: "above",
        threshold: alert.abovePrice,
      });
    }

    if (alert.belowPrice != null && price.price <= alert.belowPrice &&
        !hasBreachedToday(alert, "below")) {
      triggered.push({
        alert,
        currentPrice: price.price,
        direction: "below",
        threshold: alert.belowPrice,
      });
    }

    return { triggered };
  },
};

function hasBreachedToday(alert: StockAlert, direction: "above" | "below"): boolean {
  const ts = direction === "above" ? alert.lastNotifiedAboveAt : alert.lastNotifiedBelowAt;
  return isToday(ts);
}

// ── percent-change vs previous close ─────────────────────────────────────

const percentChangeEvaluator: AlertEvaluator = {
  evaluate(alert, price) {
    const params = alert.params as PercentChangeParams | undefined;
    if (!params || !(params.percent > 0)) return { triggered: [] };

    // Defensive: bad/missing previous close data
    if (price.previousClose == null || price.previousClose <= 0) return { triggered: [] };

    // Once per calendar day
    if (isToday(alert.lastTriggeredAt)) return { triggered: [] };

    const changePct = (price.price - price.previousClose) / price.previousClose * 100;

    let crossed: boolean;
    switch (params.direction) {
      case "up":     crossed = changePct >= params.percent; break;
      case "down":   crossed = changePct <= -params.percent; break;
      case "either": crossed = Math.abs(changePct) >= params.percent; break;
      default:       crossed = false;
    }
    if (!crossed) return { triggered: [] };

    const moveWord = changePct >= 0 ? "up" : "down";
    const message =
      `${price.symbol} is ${moveWord} ${Math.abs(changePct).toFixed(1)}% today ` +
      `($${price.previousClose.toFixed(2)} → $${price.price.toFixed(2)}).`;

    return { triggered: [{ alert, currentPrice: price.price, message }] };
  },
};

// ── trailing-high drawdown ───────────────────────────────────────────────
//
// Stateful: the high-water mark ratchets up each run and the alert fires
// when price falls `percent` below it. The mark is sampled at the scheduler
// interval during market hours, so it tracks observed prices, not the true
// intraday high. Fires once per drawdown episode; a new high re-arms it.

const trailingHighEvaluator: AlertEvaluator = {
  evaluate(alert, price) {
    const params = alert.params as TrailingHighParams | undefined;
    if (!params || !(params.percent > 0)) return { triggered: [] };

    let state = alert.state as TrailingHighState | undefined;
    let stateChanged = false;

    if (!state || !(state.highWaterMark > 0)) {
      state = { highWaterMark: price.price, highSetUtc: new Date().toISOString() };
      alert.state = state;
      stateChanged = true;
    }

    if (price.price > state.highWaterMark) {
      state.highWaterMark = price.price;
      state.highSetUtc = new Date().toISOString();
      if (state.triggeredAtMark) delete state.triggeredAtMark;
      stateChanged = true;
    }

    const drawdownPct = (state.highWaterMark - price.price) / state.highWaterMark * 100;

    if (drawdownPct < params.percent || state.triggeredAtMark) {
      return { triggered: [], stateChanged };
    }

    state.triggeredAtMark = true;
    stateChanged = true;

    const highDate = new Date(state.highSetUtc);
    const message =
      `${price.symbol} is down ${drawdownPct.toFixed(1)}% from its recent high ` +
      `of $${state.highWaterMark.toFixed(2)} (set ${highDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}). ` +
      `Current price: $${price.price.toFixed(2)}.`;

    return {
      triggered: [{ alert, currentPrice: price.price, message }],
      stateChanged,
    };
  },
};

// ── Dispatch ─────────────────────────────────────────────────────────────

const evaluators: Record<AlertType, AlertEvaluator> = {
  "absolute-threshold": absoluteThresholdEvaluator,
  "percent-change": percentChangeEvaluator,
  "trailing-high": trailingHighEvaluator,
};

export function evaluateAlerts(
  alerts: StockAlert[],
  prices: PriceResult[],
): EvaluationOutcome {
  const priceMap = new Map(prices.map((p) => [p.symbol, p]));
  const triggered: TriggeredAlert[] = [];
  const stateUpdates: StockAlert[] = [];

  for (const alert of alerts) {
    const priceData = priceMap.get(alert.symbol);
    if (!priceData) continue;

    const evaluator = evaluators[alert.alertType ?? "absolute-threshold"];
    if (!evaluator) {
      console.warn(`  Unknown alert type "${alert.alertType}" for alert ${alert.id} — skipping.`);
      continue;
    }

    const result = evaluator.evaluate(alert, priceData);
    triggered.push(...result.triggered);
    if (result.stateChanged) stateUpdates.push(alert);
  }

  return { triggered, stateUpdates };
}

function isToday(isoTs: string | undefined): boolean {
  if (!isoTs) return false;
  return new Date(isoTs).toDateString() === new Date().toDateString();
}
