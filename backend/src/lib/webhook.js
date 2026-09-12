// Generic outbound webhook alert - Slack, Discord, PagerDuty (via its
// Events API v2 custom integration), Opsgenie, or any URL that accepts a
// JSON POST. Deliberately one plain fetch rather than a per-provider
// SDK, same reasoning as lib/telegram.js: a small amount of obvious
// code, and the providers' real SDKs mostly exist for features (OAuth,
// rich interactive blocks) this doesn't need.
//
// The payload is a flat, provider-agnostic shape rather than, say,
// Slack's specific `blocks` format. Most receiving services (Slack
// included) will happily accept a plain JSON body with a `text` field
// even without speaking their native format, and anyone who wants
// richer formatting for their specific provider can transform this on
// their own receiving end (a Zapier/Make step, a tiny relay function)
// without Pulse needing to know about every provider individually.

const REQUEST_TIMEOUT_MS = 8000;

export async function sendWebhookAlert(url, { event, severity = null, title, body = "", monitor = null }) {
  if (!url) return { sent: false, reason: "no webhook url configured" };

  const payload = {
    event,
    severity,
    title,
    text: body ? `${title}\n${body}` : title,
    monitor: monitor ? { id: monitor.id, name: monitor.name, url: monitor.url } : null,
    sent_at: new Date().toISOString(),
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      console.error(`Webhook for "${event}" returned ${response.status}`);
      return { sent: false, reason: `webhook returned ${response.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("Failed to send webhook:", err.message);
    return { sent: false, reason: err.message };
  }
}
