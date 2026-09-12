// Brevo's transactional email HTTP API, not SMTP - this app used to send
// mail over nodemailer/SMTP, but that stopped working the moment it was
// deployed to a free Render web service: Render blocks all outbound
// traffic on SMTP ports (25, 465, 587) on free instances (as of Sept
// 2025) to fight spam abuse, so nodemailer's connection attempt just
// hung until it timed out - completely independent of whether the SMTP
// credentials themselves were right. Every request over this API is a
// plain HTTPS POST on port 443, which isn't part of that block, so it
// works on a free instance exactly as well as a paid one.
//
// Same reasoning as lib/telegram.js and lib/webhook.js: one plain
// fetch rather than a provider SDK, since a POST and a JSON body is
// the entire integration surface here.

const API_ROOT = "https://api.brevo.com/v3/smtp/email";
const REQUEST_TIMEOUT_MS = 10000;

export async function sendAlertEmail({ to, subject, text }) {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.EMAIL_FROM;
  if (!apiKey || !fromEmail) return { sent: false, reason: "Brevo not configured" };
  if (!to) return { sent: false, reason: "no recipient" };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(API_ROOT, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
      body: JSON.stringify({
        sender: { email: fromEmail, name: process.env.EMAIL_FROM_NAME || "Pulse" },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`Failed to send alert email: Brevo returned ${response.status} ${body.slice(0, 200)}`);
      return { sent: false, reason: `Brevo returned ${response.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("Failed to send alert email:", err.message);
    return { sent: false, reason: err.message };
  }
}
