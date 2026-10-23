// Transactional email through Wynmail (Wyntek's own email service), via its
// POST /v1/emails endpoint. Wynmail sends from the workspace's approved
// sending domain and sender settings, so Pulse only supplies recipient,
// subject and body. One plain fetch, same approach as lib/telegram.js and
// lib/webhook.js.
//
// Env: WYNMAIL_API_KEY (wm_..., from the API page of Pulse's workspace in
// Wynmail) and optionally WYNMAIL_URL (defaults to the hosted backend).
// Wynmail's backend can be asleep on a free Render plan, so the timeout is
// generous enough to ride out a cold start.

const DEFAULT_URL = "https://wynmail.onrender.com";
const REQUEST_TIMEOUT_MS = 30000;

// Wynmail merges {{token}} placeholders in every body it receives and blanks
// unknown ones. Monitor names and URLs are user-controlled, so break any
// literal "{{" before sending.
const defuse = (value) => String(value).replace(/\{\{/g, "{ {");

export async function sendAlertEmail({ to, subject, text, actionUrl, actionLabel }) {
  const apiKey = process.env.WYNMAIL_API_KEY;
  if (!apiKey) return { sent: false, reason: "Wynmail not configured" };
  if (!to) return { sent: false, reason: "no recipient" };

  const payload = { to, subject: defuse(subject), text: defuse(text) };
  // Only the actionable emails (invites, confirmation, reset) carry a
  // button; the plain-text version always spells the URL out as fallback.
  if (actionUrl) {
    payload.html = defuse(`<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1f1c;max-width:480px">
      <p>${escapeHtml(text)}</p>
      <p style="margin:24px 0;text-align:center">
        <a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#3ddc84;color:#0a0f0d;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:6px">${escapeHtml(actionLabel || "Open Pulse")}</a>
      </p>
      <p style="color:#8b96a3;font-size:12.5px">If the button doesn't work, copy this link: ${escapeHtml(actionUrl)}</p>
    </div>`);
  }

  const root = (process.env.WYNMAIL_URL || DEFAULT_URL).replace(/\/+$/, "");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`${root}/v1/emails`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`Failed to send alert email: Wynmail returned ${response.status} ${body.slice(0, 200)}`);
      return { sent: false, reason: `Wynmail returned ${response.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("Failed to send alert email:", err.message);
    return { sent: false, reason: err.message };
  }
}

function escapeHtml(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
}
