import { pool } from "../db.js";
import { runHttpCheck, CONTENT_HASH_VERSION } from "./httpCheck.js";
import { runSyntheticCheck } from "./syntheticCheck.js";
import { runTcpCheck } from "./tcpCheck.js";
import { getSslExpiry, getDomainExpiry, hostnameFromUrl } from "./certCheck.js";
import { sendPushToUser } from "./webPush.js";
import { sendAlertEmail } from "./mailer.js";
import { sendTelegramMessage, resolveChatId } from "./telegram.js";
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
  // Dispatch by type: a synthetic monitor's "check" is an ordered
  // sequence of requests (syntheticCheck.js), a tcp monitor is a raw
  // socket connect (tcpCheck.js), neither is the single request/response
  // httpCheck.js handles. All three return the same { status, statusCode,
  // responseMs, errorMessage, contentHash } shape, so everything below
  // this line - logging, alerting, thresholds - is identical regardless
  // of which kind ran.
  const result =
    monitor.monitor_type === "synthetic" ? await runSyntheticCheck(monitor)
    : monitor.monitor_type === "tcp" ? await runTcpCheck(monitor)
    : await runHttpCheck(monitor);

  // The raw per-check result is always logged as-is, threshold or no -
  // the checks table (and the uptime chart/heatmap built on it) should
  // reflect what actually happened on the wire, not the alerting state.
  await pool.query(
    `INSERT INTO checks (monitor_id, status, status_code, response_ms, error_message)
     VALUES ($1, $2, $3, $4, $5)`,
    [monitor.id, result.status, result.statusCode, result.responseMs, result.errorMessage]
  );

  const wasAlertingDown = monitor.current_status === "down";
  const threshold = monitor.alert_after_failures || 1;
  let alerted = false;

  if (result.status === "down") {
    const failureCount = (monitor.consecutive_failures || 0) + 1;
    const thresholdReached = failureCount >= threshold;
    // Below threshold: log the failure and bump the streak, but don't
    // touch current_status yet - a monitor with alert_after_failures > 1
    // is meant to ride out exactly this kind of blip without flipping to
    // "down" (and alerting) on every single one.
    const newStatus = thresholdReached ? "down" : monitor.current_status;

    await pool.query(
      `UPDATE monitors SET current_status = $2, consecutive_failures = $3, last_checked_at = now(), last_status_code = $4, last_response_ms = $5, updated_at = now()
       WHERE id = $1`,
      [monitor.id, newStatus, failureCount, result.statusCode, result.responseMs]
    );

    if (thresholdReached && !wasAlertingDown) {
      const { rows: incidentRows } = await pool.query(
        `INSERT INTO incidents (monitor_id, error_message, last_notified_at) VALUES ($1, $2, now()) RETURNING id`,
        [monitor.id, result.errorMessage]
      );
      await alertDown(monitor, result, incidentRows[0].id);
      alerted = true;
    } else if (thresholdReached && wasAlertingDown) {
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
    }
    // Below threshold: no incident, no alert - just the streak counter
    // ticking up, already persisted above.
  } else {
    // Degraded state: a passing check that's slower than the monitor's
    // own degraded_threshold_ms counts toward a separate slow-streak,
    // independent of the down/up streak above. NULL threshold means the
    // feature's off for this monitor, same opt-in shape as content-diff.
    const wasDegraded = monitor.current_status === "degraded";
    let newStatus = "up";
    let slowStreak = 0;

    if (monitor.degraded_threshold_ms && result.responseMs != null && result.responseMs > monitor.degraded_threshold_ms) {
      slowStreak = (monitor.consecutive_slow || 0) + 1;
      const slowThreshold = monitor.alert_after_slow || 3;
      if (slowStreak >= slowThreshold) newStatus = "degraded";
    }
    // Any check that's either fast enough or has the feature off resets
    // the streak to 0 and clears degraded back to up - "slow" only means
    // something while it's actually still happening.

    await pool.query(
      `UPDATE monitors SET current_status = $2, consecutive_failures = 0, consecutive_slow = $3, last_checked_at = now(), last_status_code = $4, last_response_ms = $5, updated_at = now()
       WHERE id = $1`,
      [monitor.id, newStatus, slowStreak, result.statusCode, result.responseMs]
    );

    if (wasAlertingDown) {
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
    } else if (newStatus === "degraded" && !wasDegraded) {
      // Fresh transition into degraded only - like alertDown, this fires
      // once on the way in, not on every subsequent slow check, since
      // this is meant to be a lighter nudge than a down alert.
      await alertDegraded(monitor, result);
      alerted = true;
    } else if (wasDegraded && newStatus === "up") {
      await alertNoLongerDegraded(monitor);
      alerted = true;
    }

    // Content-diff monitoring: only meaningful on a passing check with a
    // hash to compare (http-type monitors with content_diff_enabled -
    // synthetic checks never produce one, see syntheticCheck.js). No
    // stored hash yet means this is the first check since the toggle was
    // turned on, so it just becomes the baseline silently - there's
    // nothing to have "changed" relative to yet.
    if (monitor.content_diff_enabled && result.contentHash) {
      if (!monitor.content_hash || monitor.content_hash_version !== CONTENT_HASH_VERSION) {
        // No baseline yet, or the baseline was computed with an older
        // hashing scheme (see CONTENT_HASH_VERSION / extractVisibleText
        // in httpCheck.js). Either way there's nothing meaningful to
        // compare the new hash against, so it just becomes the new
        // baseline silently - a scheme upgrade shouldn't cost the user
        // a false "content changed" alert for a page that never
        // actually changed.
        await pool.query(
          `UPDATE monitors SET content_hash = $2, content_hash_version = $3 WHERE id = $1`,
          [monitor.id, result.contentHash, CONTENT_HASH_VERSION]
        );
      } else if (monitor.content_hash !== result.contentHash) {
        // The new hash becomes the baseline immediately, not after some
        // separate "acknowledge" step - so a legitimate deploy earns
        // exactly one alert, not a repeat on every check until someone
        // manually resets it.
        await pool.query(
          `UPDATE monitors SET content_hash = $2, content_changed_at = now() WHERE id = $1`,
          [monitor.id, result.contentHash]
        );
        await alertContentChanged(monitor);
        alerted = true;
      }
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
    // scanSite does plain HTTP requests (headers, exposed paths) - not
    // meaningful (and not even reachable, fetch() has no tcp: scheme)
    // for a tcp-type monitor.
    `monitor_type != 'tcp'`,
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
  await sendTelegramMessage({ chatId: resolveChatId(user), text: `🔴 ${title}\n${body}\n\n${monitor.url}` });
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
  await sendTelegramMessage({ chatId: resolveChatId(user), text: `🔴 ${title}\n${body}\n\n${monitor.url}` });
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
  await sendTelegramMessage({ chatId: resolveChatId(user), text: `🟢 ${title}\n${body}` });
}

async function alertContentChanged(monitor) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const title = `${monitor.name} content changed`;
  const body = "The page's content changed since the last check. If this was an expected deploy, no action needed - the new content is now the baseline for future comparisons.";
  await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: `${body}\n\nURL: ${monitor.url}` });
  await sendTelegramMessage({ chatId: resolveChatId(user), text: `📝 ${title}\n${body}\n\n${monitor.url}` });
}

// Lighter than alertDown: no incident row, no repeat "still degraded"
// nag every tick - just one nudge on the way in and one on the way out,
// since a 200 that's merely slow isn't the same class of problem as an
// actual outage.
async function alertDegraded(monitor, result) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const title = `${monitor.name} is responding slowly`;
  const body = `Response time is ${result.responseMs}ms, above the ${monitor.degraded_threshold_ms}ms threshold for ${monitor.alert_after_slow || 3} checks in a row. Still returning a valid response - not down.`;
  await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: `${body}\n\nURL: ${monitor.url}` });
  await sendTelegramMessage({ chatId: resolveChatId(user), text: `🟡 ${title}\n${body}\n\n${monitor.url}` });
}

async function alertNoLongerDegraded(monitor) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const title = `${monitor.name} is back to normal speed`;
  await sendPushToUser(monitor.user_id, { title, body: "Response time is back under the slow threshold.", url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: "Response time is back under the slow threshold." });
  await sendTelegramMessage({ chatId: resolveChatId(user), text: `🟢 ${title}` });
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
  await sendTelegramMessage({ chatId: resolveChatId(user), text: `⚠️ ${title}\n${body}` });
}
