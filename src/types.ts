export interface StockAlert {
  id: string;
  symbol: string;
  name: string;
  abovePrice?: number;
  belowPrice?: number;
  notes?: string;
  enabled: boolean;
  lastNotifiedAt?: string;
  createdAt: string;
}

export interface Settings {
  checkIntervalCron: string;
  cooldownMinutes: number;
  notifyEmail: boolean;
  notifySms: boolean;
}

export interface DbSchema {
  alerts: StockAlert[];
  settings: Settings;
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
