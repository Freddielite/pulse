// One place where a security detection becomes a stored event and,
// when it's worth it, a notification.
//
// Every detector added here (scan regressions, certificate fingerprint
// changes, DNS drift, new certificates in the CT logs, an endpoint that
// stopped requiring auth) would otherwise need its own copy of "write a
// row, look up the user, send push, send email, send Telegram." That's
// the shape checkRunner.js's six near-identical alert functions already
// drifted into, and adding five more of them would have made the pattern
// permanent.
//
// It also puts the throttling in one place, which matters more than the
// deduplication of code: a DNS change detected on a five-minute sweep
// would otherwise notify on every single sweep until someone changed it
// back.

import { pool } from "../db.js";
import { sendPushToUser } from "./webPush.js";
import { sendAlertEmail } from "./mailer.js";
import { sendTelegramMessage, resolveChatId } from "./telegram.js";
import { sendWebhookAlert } from "./webhook.js";
import { wantsNotification } from "./notificationPrefs.js";
import { getNotifiableUsers } from "./orgAccess.js";

// Severities at or above this actually notify. Everything else is
// recorded to the timeline and shows up in the UI, but doesn't interrupt
// anyone - a missing Permissions-Policy header is worth knowing about
// and is never worth a phone buzzing at 2am.
const NOTIFY_AT_OR_ABOVE = ["critical", "high", "medium"];

const SEVERITY_ICON = {
  critical: "🚨",
  high: "🔴",
  medium: "🟠",
  low: "🟡",
  info: "ℹ️",
};

// Same-event throttle. Keyed by monitor + kind + a caller-supplied
// dedupe key, so "the A record changed to 1.2.3.4" notifies once rather
// than every sweep for as long as it stays changed, while a *different*
// subsequent change still gets through.
const THROTTLE_HOURS = 12;

export async function recordSecurityEvent(monitor, event) {
  const { kind, severity, title, detail = null, data = null, dedupeKey = null, notify = true } = event;

  // Suppress an identical event that's already been recorded recently.
  // The check is on the events table itself rather than an in-process
  // cache, because Render restarts the process often enough that an
  // in-memory throttle would leak notifications on every redeploy.
  if (dedupeKey) {
    const { rows } = await pool.query(
      `SELECT id FROM security_events
       WHERE monitor_id = $1 AND kind = $2 AND data->>'dedupeKey' = $3
         AND created_at > now() - ($4 || ' hours')::interval
       LIMIT 1`,
      [monitor.id, kind, dedupeKey, THROTTLE_HOURS]
    );
    if (rows.length > 0) return null;
  }

  const payload = dedupeKey ? { ...(data || {}), dedupeKey } : data;

  const { rows } = await pool.query(
    `INSERT INTO security_events (monitor_id, kind, severity, title, detail, data)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [monitor.id, kind, severity, title, detail, payload ? JSON.stringify(payload) : null]
  );
  const stored = rows[0];

  if (notify && NOTIFY_AT_OR_ABOVE.includes(severity)) {
    await notifySecurityEvent(monitor, stored);
  }
  return stored;
}

async function notifySecurityEvent(monitor, event) {
  const notifiable = await getNotifiableUsers(monitor);

  const icon = SEVERITY_ICON[event.severity] || "⚠️";
  const title = `${monitor.name}: ${event.title}`;
  const body = event.detail || "";

  // Same three channels, same order, same failure tolerance as every
  // other alert in this app - a misconfigured SMTP server shouldn't stop
  // the push notification that already went out from counting. Looped
  // over every notifiable user rather than just monitor.user_id, so an
  // org-owned monitor pages the whole team, not just whoever created it.
  for (const user of notifiable) {
    if (wantsNotification(user, "push", "security")) {
      await sendPushToUser(user.id, { title, body: body.slice(0, 240), url: `/monitors/${monitor.id}` });
    }
    await sendAlertEmail({
      to: user.alert_email,
      subject: `Pulse security: ${title}`,
      text: `${body}\n\nMonitor: ${monitor.name}\nURL: ${monitor.url}`,
    });
    if (wantsNotification(user, "telegram", "security")) {
      await sendTelegramMessage({ chatId: resolveChatId(user), text: `${icon} ${title}\n${body}\n\n${monitor.url}` });
    }
    if (wantsNotification(user, "webhook", "security")) {
      await sendWebhookAlert(user.webhook_url, { event: "security", severity: event.severity, title, body, monitor });
    }
  }
}

// Compares two scan results and reports what actually moved.
//
// This is the difference between a scanner and a monitor, and it's the
// reason security_scans keeps history instead of overwriting. A one-off
// scan answers "how is this configured"; a diff answers "what changed
// since Friday", which is the question that catches a deploy quietly
// dropping a header nobody remembers adding.
export function diffScans(previousFindings, currentFindings) {
  if (!Array.isArray(previousFindings) || previousFindings.length === 0) return { regressions: [], improvements: [] };

  const previousByCheck = new Map(previousFindings.map((finding) => [finding.check, finding]));
  const regressions = [];
  const improvements = [];

  for (const finding of currentFindings) {
    const before = previousByCheck.get(finding.check);
    // A check that didn't exist in the previous scan isn't a regression -
    // it's a check that was added to Pulse since then, and reporting a
    // scanner upgrade as "your site got worse" would destroy trust in
    // the alert the first time it happened.
    if (!before) continue;
    if (before.pass && !finding.pass) regressions.push(finding);
    if (!before.pass && finding.pass) improvements.push(finding);
  }

  return { regressions, improvements };
}
