// Breach monitoring for the account's own alert email. Free by
// default: XposedOrNot's public API needs no key. If HIBP_API_KEY is
// also set, HaveIBeenPwned is queried as a second source and the two
// results are merged, which widens coverage (neither corpus is a
// superset of the other). Opt-in per user (breach_monitoring_enabled)
// and off by default: unlike every other check in this app, the thing
// being queried is a person's email address at a third party, not
// infrastructure they operate themselves.
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
const BREACH_RETRY_HOURS = 6;
// Kept small: the sweep runs inside a cron tick with a hard request
// budget, and each lookup is a call to a third party.
const MAX_BREACH_CHECKS_PER_RUN = 5;
// Pause between users so a burst never trips the free API's rate limit.
const DELAY_BETWEEN_USERS_MS = 750;

const XON_API_ROOT = "https://api.xposedornot.com/v1/check-email";
const HIBP_API_ROOT = "https://haveibeenpwned.com/api/v3/breachedaccount";
const REQUEST_TIMEOUT_MS = 8000;
const USER_AGENT = "Pulse-uptime-monitor";

// The free path needs no key, so the feature is always available.
export function breachCheckConfigured() {
  return true;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// XposedOrNot free endpoint. A clean email is a 404, not an error. The
// breaches field is a nested array (e.g. [["Name1","Name2"]]), so it is
// flattened defensively.
async function checkXposedOrNot(email) {
  try {
    const response = await fetchWithTimeout(`${XON_API_ROOT}/${encodeURIComponent(email)}`, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
    if (response.status === 404) return { checked: true, breaches: [] };
    if (!response.ok) {
      console.error(`XposedOrNot returned ${response.status}`);
      return { checked: false, breaches: [], reason: `XposedOrNot returned ${response.status}` };
    }
    const data = await response.json();
    const names = [data?.breaches].flat(Infinity).filter((name) => typeof name === "string" && name.trim());
    return { checked: true, breaches: names };
  } catch (err) {
    console.error("XposedOrNot lookup failed:", err.message);
    return { checked: false, breaches: [], reason: err.message };
  }
}

// Optional second source, only used when a paid key is configured.
async function checkHibp(email) {
  const apiKey = process.env.HIBP_API_KEY;
  if (!apiKey) return { checked: false, breaches: [], reason: "HIBP not configured" };
  try {
    const response = await fetchWithTimeout(`${HIBP_API_ROOT}/${encodeURIComponent(email)}?truncateResponse=true`, {
      headers: { "hibp-api-key": apiKey, "user-agent": USER_AGENT },
    });
    if (response.status === 404) return { checked: true, breaches: [] };
    if (!response.ok) {
      console.error(`HaveIBeenPwned returned ${response.status}`);
      return { checked: false, breaches: [], reason: `HIBP returned ${response.status}` };
    }
    const data = await response.json();
    return { checked: true, breaches: (data || []).map((b) => b.Name) };
  } catch (err) {
    console.error("HaveIBeenPwned lookup failed:", err.message);
    return { checked: false, breaches: [], reason: err.message };
  }
}

// Two sources name the same breach slightly differently ("Adobe" vs
// "adobe", "Linked-In" vs "LinkedIn"), so compare on a normalised key.
const breachKey = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "");

function mergeBreachNames(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const name of list) {
      const key = breachKey(name);
      if (key && !seen.has(key)) seen.set(key, name);
    }
  }
  return [...seen.values()];
}

export async function checkBreaches(email) {
  const hibpEnabled = !!process.env.HIBP_API_KEY;
  const [xon, hibp] = await Promise.all([
    checkXposedOrNot(email),
    hibpEnabled ? checkHibp(email) : Promise.resolve({ checked: false, breaches: [] }),
  ]);
  const checked = xon.checked || hibp.checked;
  if (!checked) return { checked: false, breaches: [], reason: xon.reason || hibp.reason };
  return { checked: true, breaches: mergeBreachNames(xon.breaches, hibp.breaches), hibpUsed: hibp.checked };
}

async function notifyNewBreaches(user, newBreaches) {
  const email = user.alert_email || user.email;
  const title = `New data breach${newBreaches.length === 1 ? "" : "es"} found for your email`;
  const body = `${newBreaches.join(", ")} - if you reuse this password anywhere, change it there. Check your email yourself: https://xposedornot.com/`;

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
// or a provider outage goes quiet instead of retrying every single tick.
export async function runBreachSweep() {
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
    // Keyed off the stored result, not the timestamp, so a first check
    // that fails (rate limit, timeout) and is retried is still treated
    // as the baseline run instead of alerting on old breaches.
    const isFirstCheck = !user.breach_last_result;
    let succeeded = false;
    try {
      const email = user.alert_email || user.email;
      const result = await checkBreaches(email);
      if (result.checked) {
        succeeded = true;
        const previousBreaches = user.breach_last_result?.breaches || [];
        const previousKeys = new Set(previousBreaches.map(breachKey));
        const newBreaches = result.breaches.filter((name) => !previousKeys.has(breachKey(name)));
        if (newBreaches.length > 0 && !isFirstCheck) {
          await notifyNewBreaches(user, newBreaches);
        }
        await pool.query(`UPDATE users SET breach_last_result = $2 WHERE id = $1`, [
          user.id,
          // Union with what was known before, never a shrink: if one
          // source is down on a later week, its breaches must not drop
          // out of the baseline and re-alert as "new" when it recovers.
          JSON.stringify({ breaches: mergeBreachNames(previousBreaches, result.breaches) }),
        ]);
      }
    } catch (err) {
      console.error(`breach check failed for user ${user.id}:`, err.message);
    }
    // A failed lookup (429, timeout, provider down) must not silence
    // the user for a full week. Back-date the stamp so it is retried in
    // BREACH_RETRY_HOURS instead.
    if (succeeded) {
      await pool.query(`UPDATE users SET breach_checked_at = now() WHERE id = $1`, [user.id]);
    } else {
      await pool.query(
        `UPDATE users SET breach_checked_at = now() - interval '${BREACH_CHECK_INTERVAL_DAYS} days' + interval '${BREACH_RETRY_HOURS} hours' WHERE id = $1`,
        [user.id]
      );
    }
    checked += 1;
    await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_USERS_MS));
  }
  return checked;
}
