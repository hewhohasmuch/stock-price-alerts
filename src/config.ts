import dns from "node:dns";
import "dotenv/config";

// Prefer IPv4 to avoid ENETUNREACH on hosts without IPv6 (e.g. Render)
dns.setDefaultResultOrder("ipv4first");

export const config = {
  // Prefer unpooled connection on Neon/Vercel (pooled connection blocks startup params)
  databaseUrl: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "postgresql://localhost:5432/stock_alerts",
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER,
  },
  notifySms: process.env.NOTIFY_SMS,
  checkIntervalCron: process.env.CHECK_INTERVAL_CRON || "*/5 * * * *",
  cooldownMinutes: Number(process.env.COOLDOWN_MINUTES || 60),
  alpacaApiKey: process.env.ALPACA_API_KEY,
  alpacaSecretKey: process.env.ALPACA_SECRET_KEY,
};

export function isEmailConfigured(): boolean {
  return !!(config.smtp.host && config.smtp.user && config.smtp.pass);
}

export function isSmsConfigured(): boolean {
  return !!(config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber && config.notifySms);
}
