export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
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
}

export interface TriggeredAlert {
  alert: StockAlert;
  currentPrice: number;
  direction: "above" | "below";
  threshold: number;
}
