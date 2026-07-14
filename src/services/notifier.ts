import { isEmailConfigured, isSmsConfigured } from "../config.js";
import { sendEmailAlert } from "./email-sender.js";
import { sendSmsAlert } from "./sms-sender.js";
import { updateLastNotified, markTriggered } from "../db.js";
import type { TriggeredAlert } from "../types.js";

export interface NotifyResult {
  symbol: string;
  direction: string;
  emailStatus: "sent" | "skipped" | "failed";
  emailError?: string;
  smsStatus: "sent" | "skipped" | "failed";
  smsError?: string;
}

export async function notify(triggered: TriggeredAlert[]): Promise<NotifyResult[]> {
  const emailEnabled = isEmailConfigured();
  const smsEnabled = isSmsConfigured();
  const results: NotifyResult[] = [];

  for (const t of triggered) {
    const { alert, currentPrice, direction, threshold, message } = t;

    if (message) {
      console.log(`[ALERT] ${message}`);
    } else {
      const arrow = direction === "above" ? "above" : "below";
      console.log(
        `[ALERT] ${alert.symbol} ($${currentPrice.toFixed(2)}) is ${arrow} $${threshold}`
      );
    }

    const result: NotifyResult = {
      symbol: alert.symbol,
      direction: direction ?? alert.alertType ?? "unknown",
      emailStatus: emailEnabled ? "failed" : "skipped",
      smsStatus: smsEnabled ? "failed" : "skipped",
    };

    let anySucceeded = false;

    if (emailEnabled) {
      try {
        await sendEmailAlert(t);
        console.log(`  -> Email sent to configured address`);
        result.emailStatus = "sent";
        anySucceeded = true;
      } catch (err) {
        result.emailError = (err as Error).message;
        console.error(`  -> Email failed:`, result.emailError);
      }
    }

    if (smsEnabled) {
      try {
        await sendSmsAlert(t);
        console.log(`  -> SMS sent to configured number`);
        result.smsStatus = "sent";
        anySucceeded = true;
      } catch (err) {
        result.smsError = (err as Error).message;
        console.error(`  -> SMS failed:`, result.smsError);
      }
    }

    if (anySucceeded) {
      if (direction) {
        await updateLastNotified(alert.id, direction);
      } else {
        await markTriggered(alert.id);
      }
    }

    results.push(result);
  }

  return results;
}
