// One bot for the whole app, configured server-wide via TELEGRAM_BOT_TOKEN
// (same shape as SMTP_* for email: one set of send credentials, a
// per-user destination on top - here that's users.telegram_chat_id
// instead of alert_email). A user gets their chat ID by messaging their
// own instance's bot and reading it back off getUpdates once; see
// HANDOVER.md / the Settings page copy for the exact steps.
const API_ROOT = "https://api.telegram.org";

export function telegramConfigured() {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

export async function sendTelegramMessage({ chatId, text }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { sent: false, reason: "Telegram bot not configured" };
  if (!chatId) return { sent: false, reason: "no chat id" };

  try {
    const response = await fetch(`${API_ROOT}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const reason = body?.description || `Telegram API returned ${response.status}`;
      console.error("Failed to send Telegram message:", reason);
      return { sent: false, reason };
    }
    return { sent: true };
  } catch (err) {
    console.error("Failed to send Telegram message:", err.message);
    return { sent: false, reason: err.message };
  }
}
