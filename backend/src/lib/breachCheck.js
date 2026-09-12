// HaveIBeenPwned breach monitoring, checked against the account's own
// alert email. Requires an API key (HIBP_API_KEY) - HIBP gated this
// endpoint behind a paid subscription in 2019, so unlike crt.sh or Safe
// Browsing there's no free/keyless path here at all. Opt-in per user
// (breach_monitoring_enabled) and off by default: unlike every other
// check in this app, the thing being queried is a person's email
// address at a third party, not infrastructure they operate themselves.
//
// Not stored in security_events - that table is keyed to a monitor_id,
// and a breach isn't about any one monitor. The account-level cadence
// clock and last-known-result live directly on the users row instead
// (breach_checked_at / breach_last_result), same shape as
// digest_sent_at.

import { pool } from "../db.js";
import { sendPushToUser } from "./webPush.js";
import { sendAlertEmail } from "./mailer.js";
import { sendTelegramMessage, resolveChatId } from "./telegram.js";
import { sendWebhookAlert } from "./webhook.js";
import { wantsNotification } from "./notificationPrefs.js";

const BREACH_CHECK_INTERVAL_DAYS = 7;
// HIBP's key tiers are rate-limited per-request (roughly one request
// every couple seconds on the cheapest tier), so this caps how many a
// single cron tick can burn through the same way MAX_DIGESTS_PER_RUN
// caps the digest sweep - just smaller, since a slow provider here would
// eat into the tick's own request budget rather than just this app's.
const MAX_BREACH_CHECKS_PER_RUN = 10;

const API_ROOT = "https://haveibeenpwned.com/api/v3/breachedaccount";
const REQUEST_TIMEOUT_MS = 10000;

export function breachCheckConfigured() {
  return !!process.env.HIBP_API_KEY;
}

export async function checkBreaches(email) {
  const apiKey = process.env.HIBP_API_KEY;
  if (!apiKey) return { checked: false, breaches: [], reason: "HaveIBeenPwned not configured" };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`${API_ROOT}/${encodeURIComponent(email)}?truncateResponse=true`, {
      headers: { "hibp-api-key": apiKey, "user-agent": "Pulse-uptime-monitor" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    // 404 from this endpoint means "no breaches found" - it's not an
    // error, just the shape HIBP uses for a clean result.
    if (response.status === 404) return { checked: true, breaches: [] };
    if (!response.ok) {
      console.error(`HaveIBeenPwned returned ${response.status}`);
      return { checked: false, breaches: [], reason: `API returned ${response.status}` };
    }
    const data = await response.json();
    return { checked: true, breaches: (data || []).map((b) => b.Name) };
  } catch (err) {
    console.error("HaveIBeenPwned lookup failed:", err.message);
    return { checked: false, breaches: [], reason: err.message };
  }
}

async function notifyNewBreaches(user, newBreaches) {
  const email = user.alert_email || user.email;
  const title = `New data breach${newBreaches.length === 1 ? "" : "es"} found for your email`;
  const body = `${newBreaches.join(", ")} - if you reuse this password anywhere, change it there. Full report: https://haveibeenpwned.com/account/${encodeURIComponent(email)}`;

  if (wantsNotification(user, "push", "security")) {
    await sendPushToUser(user.id, { title, body: body.slice(0, 240), url: "/settings" });
  }
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: body });
  if (wantsNotification(user, "telegram", "security")) {
    await sendTelegramMessage({ chatId: resolveChatId(user), text: `🚨 ${title}\n${body}` });
  }
  if (wantsNotification(user, "webhook", "security")) {
    await sendWebhookAlert(user.webhook_url, { event: "breach", severity: "critical", title, body });
  }
}

// Cron-tick-driven sweep, same shape as runDigestSweep(): every user
// with breach_monitoring_enabled and a cadence clock that's due gets
// checked, then the clock resets - even on a failed lookup, so a bad key
// or an HIBP outage goes quiet instead of retrying every single tick.
export async function runBreachSweep() {
  if (!breachCheckConfigured()) return 0;

  const { rows: due } = await pool.query(
    `SELECT * FROM users
     WHERE breach_monitoring_enabled = true
       AND (breach_checked_at IS NULL OR breach_checked_at <= now() - interval '${BREACH_CHECK_INTERVAL_DAYS} days')
     LIMIT $1`,
    [MAX_BREACH_CHECKS_PER_RUN]
  );

  let checked = 0;
  for (const user of due) {
    // The very first check ever establishes the baseline without
    // alerting - same reasoning as CT logs' first sweep and
    // content_hash's first value: a pre-existing breach found the
    // moment someone turns this on is a gap in their own prior
    // awareness, not a new event worth an urgent notification.
    const isFirstCheck = user.breach_checked_at === null;
    try {
      const email = user.alert_email || user.email;
      const result = await checkBreaches(email);
      if (result.checked) {
        const previousBreaches = user.breach_last_result?.breaches || [];
        const newBreaches = result.breaches.filter((name) => !previousBreaches.includes(name));
        if (newBreaches.length > 0 && !isFirstCheck) {
          await notifyNewBreaches(user, newBreaches);
        }
        await pool.query(`UPDATE users SET breach_last_result = $2 WHERE id = $1`, [
          user.id,
          JSON.stringify({ breaches: result.breaches }),
        ]);
      }
    } catch (err) {
      console.error(`breach check failed for user ${user.id}:`, err.message);
    }
    await pool.query(`UPDATE users SET breach_checked_at = now() WHERE id = $1`, [user.id]);
    checked += 1;
  }
  return checked;
}
