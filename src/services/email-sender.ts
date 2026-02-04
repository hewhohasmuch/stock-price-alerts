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
  const { alert, currentPrice, direction, threshold } = triggered;
  const arrow = direction === "above" ? "above" : "below";

  const subject = `Stock Alert: ${alert.symbol} is ${arrow} $${threshold}`;
  const text = [
    `${alert.symbol} (${alert.name})`,
    `Current price: $${currentPrice.toFixed(2)}`,
    `Threshold: ${direction} $${threshold}`,
    ``,
    `This alert was triggered because the stock price moved ${arrow} your configured threshold.`,
  ].join("\n");

  await getTransporter().sendMail({
    from: config.smtp.user,
    to: config.notifyEmail,
    subject,
    text,
  });
}
