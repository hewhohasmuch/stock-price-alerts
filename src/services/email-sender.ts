import nodemailer from "nodemailer";
import { config } from "../config.js";
import type { TriggeredAlert } from "../types.js";

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
