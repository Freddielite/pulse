import { pool } from "../db.js";
import { runHttpCheck } from "./httpCheck.js";
import { getSslExpiry, getDomainExpiry, hostnameFromUrl } from "./certCheck.js";
import { sendPushToUser } from "./webPush.js";
import { sendAlertEmail } from "./mailer.js";
import { scanSite } from "./scanner.js";

// How often the (best-effort, rate-limited) cert/domain check runs per
// monitor. Far coarser than the uptime check: a handshake + WHOIS lookup
// is much heavier than a plain HTTP ping, and an expiry date only moves
// once a day at most, so re-checking every tick would be pure waste.
const CERT_CHECK_INTERVAL_HOURS = 24;
// Ceiling on how many cert/domain lookups happen in a single run, so one
// big backlog (e.g. right after adding a batch of monitors) can't turn a
// single run into a multi-minute WHOIS marathon.
const MAX_CERT_CHECKS_PER_RUN = 5;
// Same reasoning as the cert sweep above: a header/exposed-path scan is
// several requests per monitor, so it runs on the same daily cadence and
// same per-run cap rather than every cron tick.
const SECURITY_SCAN_INTERVAL_HOURS = 24;
const MAX_SECURITY_SCANS_PER_RUN = 5;
// How often a monitor that's still down gets another alert, instead of
// staying silent after the initial one. An hour balances "you'd actually
// want to know it's still broken" against not turning a multi-hour outage
// into a stream of identical notifications.
const REPEAT_ALERT_INTERVAL_MS = 60 * 60 * 1000;

// Runs the uptime check for exactly the monitor rows it's given. Callers
// decide *which* monitors qualify: the cron tick asks for whatever is due
// on schedule, the "Check now" button asks for everything owned by one
// user regardless of schedule. Everything past that point, recording the
// check, opening/closing incidents, sending alerts, is identical either
// way, so it lives here once instead of twice.
//
// Monitors are checked in parallel, not sequentially. Each individual
// check can take up to runHttpCheck's own timeout (15s), so a sequential
// loop over N monitors has a worst case of N * 15s, easily blowing past
// any reasonable client-side request timeout once there's more than one
// monitor. Running them concurrently keeps the worst case pinned to a
// single check's timeout regardless of how many monitors there are.
export async function runUptimeChecks(monitorRows) {
  const outcomes = await Promise.all(monitorRows.map(checkOneMonitor));

  const results = { checked: 0, up: 0, down: 0, alertsSent: 0 };
  for (const outcome of outcomes) {
    results.checked += 1;
    results[outcome.status] += 1;
    if (outcome.alerted) results.alertsSent += 1;
  }
  return results;
}

async function checkOneMonitor(monitor) {
  const result = await runHttpCheck(monitor);

  await pool.query(
    `INSERT INTO checks (monitor_id, status, status_code, response_ms, error_message)
     VALUES ($1, $2, $3, $4, $5)`,
    [monitor.id, result.status, result.statusCode, result.responseMs, result.errorMessage]
  );

  const wasUp = monitor.current_status !== "down";
  await pool.query(
    `UPDATE monitors SET current_status = $2, last_checked_at = now(), last_status_code = $3, last_response_ms = $4, updated_at = now()
     WHERE id = $1`,
    [monitor.id, result.status, result.statusCode, result.responseMs]
  );

  let alerted = false;
  if (result.status === "down" && wasUp) {
    const { rows: incidentRows } = await pool.query(
      `INSERT INTO incidents (monitor_id, error_message, last_notified_at) VALUES ($1, $2, now()) RETURNING id`,
      [monitor.id, result.errorMessage]
    );
    await alertDown(monitor, result, incidentRows[0].id);
    alerted = true;
  } else if (result.status === "down" && !wasUp) {
    // Still down, not a fresh transition. Only worth a repeat alert if
    // it's actually been a while since the last one - most ticks in
    // between should stay silent.
    const { rows: openRows } = await pool.query(
      `SELECT id, started_at, last_notified_at FROM incidents WHERE monitor_id = $1 AND resolved_at IS NULL`,
      [monitor.id]
    );
    const incident = openRows[0];
    if (incident) {
      const sinceLastNotify = Date.now() - new Date(incident.last_notified_at || incident.started_at).getTime();
      if (sinceLastNotify >= REPEAT_ALERT_INTERVAL_MS) {
        await pool.query(`UPDATE incidents SET last_notified_at = now() WHERE id = $1`, [incident.id]);
        await alertStillDown(monitor, result, incident);
        alerted = true;
      }
    }
  } else if (result.status === "up" && !wasUp) {
    const { rows: resolvedRows } = await pool.query(
      `UPDATE incidents SET resolved_at = now()
       WHERE monitor_id = $1 AND resolved_at IS NULL
       RETURNING id, started_at`,
      [monitor.id]
    );
    if (resolvedRows[0]) {
      await alertRecovered(monitor, resolvedRows[0]);
      alerted = true;
    }
  }

  return { status: result.status, alerted };
}

// Same split as above: the cron tick sweeps whatever's due across every
// user, "Check now" only makes sense scoped to one user's own monitors.
export async function runCertSweep({ userId = null, limit = MAX_CERT_CHECKS_PER_RUN } = {}) {
  const conditions = [
    `active = true`,
    `url LIKE 'https://%'`,
    `(cert_checked_at IS NULL OR cert_checked_at <= now() - interval '${CERT_CHECK_INTERVAL_HOURS} hours')`,
  ];
  const params = [];
  if (userId) {
    params.push(userId);
    conditions.push(`user_id = $${params.length}`);
  }
  params.push(limit);

  const { rows: certDue } = await pool.query(
    `SELECT * FROM monitors WHERE ${conditions.join(" AND ")} LIMIT $${params.length}`,
    params
  );

  let certChecks = 0;
  for (const monitor of certDue) {
    const hostname = hostnameFromUrl(monitor.url);
    let sslExpiry = null;
    let domainExpiry = null;
    let error = null;

    if (hostname) {
      try {
        sslExpiry = await getSslExpiry(hostname);
      } catch (err) {
        error = `SSL: ${err.message}`;
      }
      try {
        domainExpiry = await getDomainExpiry(hostname);
      } catch (err) {
        error = error ? `${error}; Domain: ${err.message}` : `Domain: ${err.message}`;
      }
    }

    await pool.query(
      `UPDATE monitors SET ssl_expires_at = $2, domain_expires_at = $3, cert_checked_at = now(), cert_check_error = $4
       WHERE id = $1`,
      [monitor.id, sslExpiry, domainExpiry, error]
    );
    certChecks += 1;

    // A cert or domain expiring soon is worth a proactive nudge even
    // though nothing is "down" yet. This is the whole point of tracking
    // expiry instead of just finding out from the uptime check the day it
    // actually lapses.
    const soonThreshold = Date.now() + 14 * 24 * 60 * 60 * 1000;
    if (sslExpiry && sslExpiry.getTime() < soonThreshold) {
      await alertExpiringSoon(monitor, "SSL certificate", sslExpiry);
    }
    if (domainExpiry && domainExpiry.getTime() < soonThreshold) {
      await alertExpiringSoon(monitor, "Domain registration", domainExpiry);
    }
  }

  return certChecks;
}

// Same split and same rate-limiting shape as runCertSweep above: due
// monitors are whichever haven't been scanned in the last
// SECURITY_SCAN_INTERVAL_HOURS, capped per run so a big backlog can't turn
// one cron tick into a multi-minute scan marathon.
export async function runSecuritySweep({ userId = null, limit = MAX_SECURITY_SCANS_PER_RUN } = {}) {
  const conditions = [
    `active = true`,
    `(security_scanned_at IS NULL OR security_scanned_at <= now() - interval '${SECURITY_SCAN_INTERVAL_HOURS} hours')`,
  ];
  const params = [];
  if (userId) {
    params.push(userId);
    conditions.push(`user_id = $${params.length}`);
  }
  params.push(limit);

  const { rows: scanDue } = await pool.query(
    `SELECT * FROM monitors WHERE ${conditions.join(" AND ")} LIMIT $${params.length}`,
    params
  );

  let scansRun = 0;
  for (const monitor of scanDue) {
    const result = await scanSite(monitor.url);
    await pool.query(
      `INSERT INTO security_scans (monitor_id, score, findings) VALUES ($1, $2, $3)`,
      [monitor.id, result.score, JSON.stringify(result.findings)]
    );
    await pool.query(`UPDATE monitors SET security_scanned_at = now() WHERE id = $1`, [monitor.id]);
    scansRun += 1;
  }

  return scansRun;
}

async function alertDown(monitor, result, incidentId) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const title = `${monitor.name} is down`;
  const body = result.errorMessage || "Check failed.";
  await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse alert: ${title}`, text: `${body}\n\nURL: ${monitor.url}` });
}

async function alertStillDown(monitor, result, incident) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const downtimeMs = Date.now() - new Date(incident.started_at).getTime();
  const hours = Math.round(downtimeMs / 3600000);
  const title = `${monitor.name} is still down`;
  const body = `Down for about ${hours} hour${hours === 1 ? "" : "s"} now. Latest: ${result.errorMessage || "Check failed."}`;
  await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse alert: ${title}`, text: `${body}\n\nURL: ${monitor.url}` });
}

async function alertRecovered(monitor, incident) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const downtimeMs = Date.now() - new Date(incident.started_at).getTime();
  const minutes = Math.round(downtimeMs / 60000);
  const title = `${monitor.name} is back up`;
  const body = `Was down for about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: body });
}

// Throttled to one nudge per calendar day per monitor+kind, so a 14-day
// warning window doesn't turn into fourteen identical notifications.
const expiryAlertedToday = new Set();
async function alertExpiringSoon(monitor, kind, expiresAt) {
  const dayKey = new Date().toISOString().slice(0, 10);
  const cacheKey = `${monitor.id}:${kind}:${dayKey}`;
  if (expiryAlertedToday.has(cacheKey)) return;
  for (const key of expiryAlertedToday) {
    if (!key.endsWith(dayKey)) expiryAlertedToday.delete(key);
  }
  expiryAlertedToday.add(cacheKey);

  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const title = `${kind} expiring soon`;
  const body = `${monitor.name}'s ${kind.toLowerCase()} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${expiresAt.toDateString()}).`;
  await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: body });
}
