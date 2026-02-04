import { isEmailConfigured, isSmsConfigured } from "../config.js";
import { sendEmailAlert } from "./email-sender.js";
import { sendSmsAlert } from "./sms-sender.js";
import { updateLastNotified } from "../db.js";
import type { TriggeredAlert } from "../types.js";

export async function notify(triggered: TriggeredAlert[]): Promise<void> {
  const emailEnabled = isEmailConfigured();
  const smsEnabled = isSmsConfigured();

  for (const t of triggered) {
    const { alert, currentPrice, direction, threshold } = t;
    const arrow = direction === "above" ? "above" : "below";

    console.log(
      `[ALERT] ${alert.symbol} ($${currentPrice.toFixed(2)}) is ${arrow} $${threshold}`
    );

    if (emailEnabled) {
      try {
        await sendEmailAlert(t);
        console.log(`  -> Email sent to configured address`);
      } catch (err) {
        console.error(`  -> Email failed:`, (err as Error).message);
      }
    }

    if (smsEnabled) {
      try {
        await sendSmsAlert(t);
        console.log(`  -> SMS sent to configured number`);
      } catch (err) {
        console.error(`  -> SMS failed:`, (err as Error).message);
      }
    }

    await updateLastNotified(alert.id);
  }
}
