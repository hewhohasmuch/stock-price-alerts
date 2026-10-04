import nodemailer from "nodemailer";
import { config, isEmailConfigured } from "../config.js";
import type { TriggeredAlert } from "../types.js";
import type { Mailer } from "./account-recovery.js";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });
  }
  return transporter;
}

export async function sendEmailAlert(triggered: TriggeredAlert): Promise<void> {
  const { alert, currentPrice, direction, threshold, message } = triggered;

  if (!alert.userEmail) {
    throw new Error("No notification email configured for this user");
  }

  let subject: string;
  let text: string;

  if (message) {
    subject = `Stock Alert: ${alert.symbol}`;
    text = [`${alert.symbol} (${alert.name})`, ``, message].join("\n");
  } else {
    const arrow = direction === "above" ? "above" : "below";
    subject = `Stock Alert: ${alert.symbol} is ${arrow} $${threshold}`;
    text = [
      `${alert.symbol} (${alert.name})`,
      `Current price: $${currentPrice.toFixed(2)}`,
      `Threshold: ${direction} $${threshold}`,
      ``,
      `This alert was triggered because the stock price moved ${arrow} your configured threshold.`,
    ].join("\n");
  }

  await getTransporter().sendMail({
    from: config.smtp.user,
    to: alert.userEmail,
    subject,
    text,
  });
}

// ── Account emails (password reset, verification, notices) ──────────────

async function sendAccountEmail(to: string, subject: string, lines: string[]): Promise<void> {
  const text = lines.join("\n");
  if (config.devLogEmailLinks) {
    console.log(`[dev email] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  if (!isEmailConfigured()) throw new Error("SMTP is not configured");
  await getTransporter().sendMail({ from: config.smtp.user, to, subject, text });
}

export function createSmtpMailer(): Mailer {
  return {
    sendResetLink: (to, username, link) => sendAccountEmail(to, "Reset your Price Alert password", [
      `Someone asked to reset the password for "${username}" on Price Alert.`,
      ``,
      `To choose a new password, open this link within 30 minutes:`,
      link,
      ``,
      `The link works once. If you didn't ask for this, ignore this email; your password stays the same.`,
    ]),
    sendVerifyLink: (to, username, link) => sendAccountEmail(to, "Confirm your email for Price Alert", [
      `Please confirm that this address belongs to the Price Alert account "${username}".`,
      ``,
      `Open this link within 24 hours:`,
      link,
      ``,
      `Until you confirm, alert emails and password resets won't be sent here.`,
      `If you didn't sign up, ignore this email.`,
    ]),
    sendPasswordChanged: (to, username) => sendAccountEmail(to, "Your Price Alert password was changed", [
      `The password for "${username}" on Price Alert was just changed, and other devices were logged out.`,
      ``,
      `If this wasn't you, use "Forgot password?" on the login page right away.`,
    ]),
    sendEmailChanged: (to, username, newEmail) => sendAccountEmail(to, "Your Price Alert email was changed", [
      `The email address for "${username}" on Price Alert was changed to ${newEmail}.`,
      `Alerts and password resets now go to that address.`,
      ``,
      `If this wasn't you, contact the site owner.`,
    ]),
  };
}
