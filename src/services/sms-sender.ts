import twilio from "twilio";
import { config } from "../config.js";
import type { TriggeredAlert } from "../types.js";

let client: ReturnType<typeof twilio> | null = null;

function getClient() {
  if (!client) {
    client = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return client;
}

export async function sendSmsAlert(triggered: TriggeredAlert): Promise<void> {
  const { alert, currentPrice, direction, threshold } = triggered;
  const arrow = direction === "above" ? "above" : "below";

  const body = `Stock Alert: ${alert.symbol} ($${currentPrice.toFixed(2)}) is ${arrow} $${threshold}`;

  await getClient().messages.create({
    body,
    from: config.twilio.fromNumber,
    to: config.notifySms!,
  });
}
