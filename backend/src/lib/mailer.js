import nodemailer from "nodemailer";

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null; // email alerts are opt-in via env vars
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

export async function sendAlertEmail({ to, subject, text }) {
  const t = getTransporter();
  if (!t || !to) return { sent: false, reason: !t ? "SMTP not configured" : "no recipient" };
  try {
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return { sent: true };
  } catch (err) {
    console.error("Failed to send alert email:", err.message);
    return { sent: false, reason: err.message };
  }
}
