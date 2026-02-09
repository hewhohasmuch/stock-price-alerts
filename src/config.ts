import "dotenv/config";

export const config = {
  databaseUrl: process.env.DATABASE_URL || "postgresql://localhost:5432/stock_alerts",
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
  notifyEmail: process.env.NOTIFY_EMAIL,
  notifySms: process.env.NOTIFY_SMS,
  checkIntervalCron: process.env.CHECK_INTERVAL_CRON || "*/5 * * * *",
  cooldownMinutes: Number(process.env.COOLDOWN_MINUTES || 60),
};

export function isEmailConfigured(): boolean {
  return !!(config.smtp.host && config.smtp.user && config.smtp.pass && config.notifyEmail);
}

export function isSmsConfigured(): boolean {
  return !!(config.twilio.accountSid && config.twilio.authToken && config.twilio.fromNumber && config.notifySms);
}
