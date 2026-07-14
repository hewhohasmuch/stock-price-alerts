export interface User {
  id: string;
  username: string;
  passwordHash: string;
  notificationEmail?: string;
  createdAt: string;
}

export type AlertType = "absolute-threshold" | "percent-change" | "trailing-high";

export interface PercentChangeParams {
  percent: number;
  direction: "up" | "down" | "either";
}

export interface TrailingHighParams {
  percent: number;
}

export type AlertParams = PercentChangeParams | TrailingHighParams;

export interface TrailingHighState {
  highWaterMark: number;
  highSetUtc: string;
  /** Set once the current drawdown episode has notified; cleared when a new high re-arms the alert. */
  triggeredAtMark?: boolean;
}

export interface StockAlert {
  id: string;
  userId: string;
  symbol: string;
  name: string;
  abovePrice?: number;
  belowPrice?: number;
  notes?: string;
  enabled: boolean;
  lastNotifiedAt?: string;
  lastNotifiedAboveAt?: string;
  lastNotifiedBelowAt?: string;
  createdAt: string;
  userEmail?: string;
  /** Undefined/null for legacy above/below alerts. */
  alertType?: AlertType;
  params?: AlertParams;
  state?: TrailingHighState;
  lastTriggeredAt?: string;
}

export interface Settings {
  checkIntervalCron: string;
  cooldownMinutes: number;
  notifyEmail: boolean;
  notifySms: boolean;
}

export interface PriceResult {
  symbol: string;
  price: number;
  name: string;
  previousClose?: number;
}

export interface TriggeredAlert {
  alert: StockAlert;
  currentPrice: number;
  /** Present for absolute-threshold alerts only. */
  direction?: "above" | "below";
  threshold?: number;
  /** Pre-built notification text for typed (non-absolute) alerts. */
  message?: string;
}
