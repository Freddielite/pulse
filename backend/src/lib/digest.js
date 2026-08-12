import { pool } from "../db.js";
import { sendAlertEmail } from "./mailer.js";
import { sendPushToUser } from "./webPush.js";
import { sendTelegramMessage, resolveChatId } from "./telegram.js";

const DIGEST_INTERVAL_DAYS = 7;
// Same reasoning as MAX_CERT_CHECKS_PER_RUN/MAX_SECURITY_SCANS_PER_RUN in
// checkRunner.js: a per-user digest is several queries plus three sends,
// so cap how many go out in one cron tick even though a weekly cadence
// makes a real pileup unlikely in practice.
const MAX_DIGESTS_PER_RUN = 20;
// Expiry section reuses the same 14-day "worth mentioning" window
// checkRunner.js's alertExpiringSoon already uses, so a monitor that
// would page you between digests also shows up in the digest itself
// rather than the two having their own separate ideas of "soon".
const EXPIRY_SOON_DAYS = 14;

// Builds the digest content for one user, or null if they have nothing
// worth summarizing (no active monitors) - callers treat null as
// "nothing to send" rather than sending an empty digest.
async function buildDigest(user) {
  const { rows: monitors } = await pool.query(
    `SELECT * FROM monitors WHERE user_id = $1 AND active = true ORDER BY name ASC`,
    [user.id]
  );
  if (monitors.length === 0) return null;

  const lines = [];
  let totalIncidents = 0;

  for (const monitor of monitors) {
    const { rows: uptimeRows } = await pool.query(
      `SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'up') / NULLIF(COUNT(*), 0), 2) AS pct
       FROM checks WHERE monitor_id = $1 AND checked_at >= now() - interval '${DIGEST_INTERVAL_DAYS} days'`,
      [monitor.id]
    );
    const { rows: incidentRows } = await pool.query(
      `SELECT COUNT(*) AS n FROM incidents WHERE monitor_id = $1 AND started_at >= now() - interval '${DIGEST_INTERVAL_DAYS} days'`,
      [monitor.id]
    );
    const uptimePct = uptimeRows[0].pct;
    const incidentCount = Number(incidentRows[0].n);
    totalIncidents += incidentCount;

    const expiryNotes = [];
    for (const [label, field] of [["SSL", "ssl_expires_at"], ["domain", "domain_expires_at"]]) {
      if (!monitor[field]) continue;
      const daysLeft = Math.ceil((new Date(monitor[field]).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      if (daysLeft < EXPIRY_SOON_DAYS) expiryNotes.push(`${label} in ${daysLeft}d`);
    }

    const statusNote = uptimePct == null ? "no checks yet" : `${uptimePct}% uptime`;
    const incidentNote = incidentCount ? `, ${incidentCount} incident${incidentCount === 1 ? "" : "s"}` : "";
    const expiryNote = expiryNotes.length ? ` [expiring: ${expiryNotes.join(", ")}]` : "";
    lines.push(`- ${monitor.name}: ${statusNote}${incidentNote}${expiryNote}`);
  }

  const headline = totalIncidents === 0
    ? `All ${monitors.length} monitor${monitors.length === 1 ? "" : "s"} had a clean week.`
    : `${totalIncidents} incident${totalIncidents === 1 ? "" : "s"} across ${monitors.length} monitor${monitors.length === 1 ? "" : "s"} this week.`;

  return { headline, detail: lines.join("\n") };
}

// Sends one user's digest right now, independent of the cadence clock -
// used both by the sweep below and by the Settings "send test" button.
// Callers decide whether to touch digest_sent_at; a test send never does,
// same reasoning as the push/Telegram test buttons not affecting their
// own alert state.
export async function sendDigest(user) {
  const digest = await buildDigest(user);
  if (!digest) return { sent: false, reason: "no active monitors" };

  const subject = `Pulse weekly digest: ${digest.headline}`;
  const text = `${digest.headline}\n\n${digest.detail}`;
  await sendPushToUser(user.id, { title: "Pulse weekly digest", body: digest.headline, url: "/" });
  await sendAlertEmail({ to: user.alert_email, subject, text });
  await sendTelegramMessage({ chatId: resolveChatId(user), text: `📊 ${subject}\n\n${digest.detail}` });
  return { sent: true };
}

// Cron-tick-driven sweep: every user with digest_enabled and a cadence
// clock that's due gets one sent, then the clock resets. Unscoped to a
// single user for the same reason runCertSweep/runSecuritySweep are -
// the cron tick is the only place this ever runs at all.
export async function runDigestSweep() {
  const { rows: due } = await pool.query(
    `SELECT * FROM users
     WHERE digest_enabled = true
       AND (digest_sent_at IS NULL OR digest_sent_at <= now() - interval '${DIGEST_INTERVAL_DAYS} days')
     LIMIT $1`,
    [MAX_DIGESTS_PER_RUN]
  );

  let sent = 0;
  for (const user of due) {
    try {
      await sendDigest(user);
    } catch (err) {
      console.error(`digest send failed for user ${user.id}:`, err.message);
    }
    // Clock resets even on a send failure (missing SMTP config, etc.) -
    // otherwise a user with no working alert channel at all would get
    // retried every single cron tick forever instead of just going quiet,
    // same as a permanently-broken monitor doesn't get checked any more
    // often than a healthy one.
    await pool.query(`UPDATE users SET digest_sent_at = now() WHERE id = $1`, [user.id]);
    sent += 1;
  }
  return sent;
}
