import { pool } from "../db.js";
import { runHttpCheck, CONTENT_HASH_VERSION } from "./httpCheck.js";
import { runSyntheticCheck } from "./syntheticCheck.js";
import { runTcpCheck } from "./tcpCheck.js";
import { getTlsPosture, getDomainExpiry, hostnameFromUrl } from "./certCheck.js";
import { sendPushToUser } from "./webPush.js";
import { sendAlertEmail } from "./mailer.js";
import { sendTelegramMessage, resolveChatId } from "./telegram.js";
import { sendWebhookAlert } from "./webhook.js";
import { scanSite } from "./scanner.js";
import { runAuthProbe } from "./authProbe.js";
import { snapshotDns, diffSnapshots, checkDanglingCname, registrableRoot } from "./dnsCheck.js";
import { fetchCtCertificates, recentlyIssued, normalizeIssuer } from "./ctLogs.js";
import { checkBlacklist, blacklistCheckConfigured } from "./blacklistCheck.js";
import { recordSecurityEvent, diffScans } from "./securityEvents.js";
import { wantsNotification } from "./notificationPrefs.js";

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
// DNS is cheap (a handful of UDP lookups, no HTTP), so it runs far more
// often than the scan sweep - drift is the one signal here where the gap
// between "it changed" and "you found out" is the whole value.
const DNS_CHECK_INTERVAL_HOURS = 6;
const MAX_DNS_CHECKS_PER_RUN = 10;
// CT is the only sweep that queries a third party (crt.sh), so it's the
// most conservative: once a day per monitor, few per run.
const CT_CHECK_INTERVAL_HOURS = 24;
const MAX_CT_CHECKS_PER_RUN = 3;
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

    // Auth-negative assertion. Runs on the passing branch only, and only
    // for monitors that opted in: if the endpoint is already down, "does
    // it still refuse anonymous callers" is both unanswerable and beside
    // the point.
    //
    // Deliberately on the normal check cadence rather than the daily
    // security sweep. An endpoint that lost its authentication is the
    // single most expensive thing this app can detect, and finding out
    // up to 24 hours later is not meaningfully better than not finding
    // out - so it gets the same latency as a downtime check, at the cost
    // of one extra request per interval for the monitors that want it.
    if (monitor.auth_probe_enabled && monitor.monitor_type === "http") {
      const probe = await runAuthProbe(monitor);
      const previous = monitor.auth_probe_status;

      await pool.query(
        `UPDATE monitors SET auth_probe_status = $2, auth_probe_checked_at = now() WHERE id = $1`,
        [monitor.id, probe.verdict]
      );

      // Only a transition notifies, and an inconclusive result (network
      // failure during the probe) never does - it isn't evidence either
      // way, and treating it as a failure would page someone every time
      // their wifi dropped.
      if (probe.verdict === "fail" && previous !== "fail") {
        await recordSecurityEvent(monitor, {
          kind: "auth_probe_failed",
          severity: "critical",
          title: "endpoint no longer requires authentication",
          detail: probe.detail,
          data: { statusCode: probe.statusCode, expected: monitor.auth_probe_expect },
        });
        alerted = true;
      } else if (probe.verdict === "pass" && previous === "fail") {
        await recordSecurityEvent(monitor, {
          kind: "auth_probe_recovered",
          severity: "info",
          title: "endpoint requires authentication again",
          detail: probe.detail,
        });
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
    let posture = null;
    let error = null;

    if (hostname) {
      try {
        // One handshake now yields the whole picture (protocol, cipher,
        // chain, SANs, fingerprint), not just the expiry date - see
        // getTlsPosture in certCheck.js.
        posture = await getTlsPosture(hostname);
        sslExpiry = posture.expiresAt;
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
      `UPDATE monitors SET ssl_expires_at = $2, domain_expires_at = $3, cert_checked_at = now(), cert_check_error = $4,
                           tls_posture = $5, tls_fingerprint = COALESCE($6, tls_fingerprint)
       WHERE id = $1`,
      [monitor.id, sslExpiry, domainExpiry, error, posture ? JSON.stringify(posture) : null, posture?.fingerprint256 ?? null]
    );
    certChecks += 1;

    // Certificate fingerprint change detection.
    //
    // Same baseline-then-compare shape as content-diff monitoring: the
    // first fingerprint seen is just the baseline, never an alert. After
    // that, a change means the certificate this hostname presents is not
    // the one it presented before - which is a routine renewal most of
    // the time, and a hijacked DNS record, a compromised CDN account, or
    // a mis-issued certificate the rest of the time. Pulse can't tell
    // those apart from the outside, and shouldn't pretend to: it reports
    // what changed and lets the person who knows their own renewal
    // schedule make the call.
    if (posture?.fingerprint256 && monitor.tls_fingerprint && monitor.tls_fingerprint !== posture.fingerprint256) {
      const previousIssuer = monitor.tls_posture?.issuer;
      const sameIssuer = previousIssuer && posture.issuer && normalizeIssuer(previousIssuer) === normalizeIssuer(posture.issuer);
      await recordSecurityEvent(monitor, {
        kind: "tls_fingerprint_changed",
        severity: sameIssuer ? "medium" : "high",
        title: sameIssuer ? "TLS certificate was replaced" : "TLS certificate was replaced by a different issuer",
        detail: sameIssuer
          ? `The certificate changed but was issued by the same CA (${posture.issuer}), which is what a normal renewal looks like. Valid until ${posture.expiresAt.toDateString()}.`
          : `The certificate changed and the issuer changed too: it was ${previousIssuer || "unknown"}, now ${posture.issuer || "unknown"}. If you didn't move CAs or change hosting provider, this is worth checking immediately - it's what a hijacked DNS record or a compromised CDN account looks like from the outside.`,
        data: {
          previousFingerprint: monitor.tls_fingerprint,
          fingerprint: posture.fingerprint256,
          previousIssuer,
          issuer: posture.issuer,
          validFrom: posture.validFrom,
          validTo: posture.expiresAt,
        },
        dedupeKey: posture.fingerprint256,
      });
    }

    // Posture problems that aren't about expiry at all: a name mismatch,
    // an untrusted chain, a deprecated protocol version.
    if (posture) {
      if (!posture.hostnameMatches) {
        await recordSecurityEvent(monitor, {
          kind: "tls_posture",
          severity: "critical",
          title: "TLS certificate doesn't cover this hostname",
          detail: `The certificate served for ${hostname} is issued to ${posture.subject || "an unknown subject"} (SANs: ${posture.altNames.slice(0, 5).join(", ") || "none"}). Browsers will show a name-mismatch warning.`,
          dedupeKey: `hostname-mismatch:${posture.fingerprint256}`,
        });
      }
      if (posture.protocol && /TLSv1(\.[01])?$/.test(posture.protocol)) {
        await recordSecurityEvent(monitor, {
          kind: "tls_posture",
          severity: "high",
          title: `server negotiated ${posture.protocol}`,
          detail: `${posture.protocol} is deprecated, rejected by current browsers, and fails PCI DSS. Enable TLS 1.2 and 1.3 and disable everything below.`,
          dedupeKey: `weak-protocol:${posture.protocol}`,
        });
      }
    }

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
    await scanAndRecord(monitor);
    scansRun += 1;
  }

  return scansRun;
}

// Runs one scan, stores it, and reports what changed relative to the
// previous one. Shared by the sweep above and the manual "Rescan now"
// route, so an on-demand scan produces exactly the same events an
// automatic one would - there's no second code path that quietly skips
// the diffing.
export async function scanAndRecord(monitor) {
  const { rows: previousRows } = await pool.query(
    `SELECT findings FROM security_scans WHERE monitor_id = $1 ORDER BY scanned_at DESC LIMIT 1`,
    [monitor.id]
  );
  const previousFindings = previousRows[0]?.findings || null;

  const result = await scanSite(monitor.url, {
    authHeaderName: monitor.auth_header_name,
    authHeaderValue: monitor.auth_header_value,
  });

  const { rows } = await pool.query(
    `INSERT INTO security_scans (monitor_id, score, grade, findings, summary, meta)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      monitor.id,
      result.score,
      result.grade,
      JSON.stringify(result.findings),
      JSON.stringify(result.summary),
      JSON.stringify(result.meta),
    ]
  );

  await pool.query(
    `UPDATE monitors SET security_scanned_at = now(), third_party_origins = $2 WHERE id = $1`,
    [monitor.id, JSON.stringify(result.meta?.thirdPartyOrigins || [])]
  );

  // --- Regressions ---
  const { regressions, improvements } = diffScans(previousFindings, result.findings);
  for (const regression of regressions) {
    await recordSecurityEvent(monitor, {
      kind: "scan_regression",
      severity: regression.severity,
      title: `${regression.check} went from passing to failing`,
      detail: regression.detail,
      data: { check: regression.check, category: regression.category, remediation: regression.remediation },
      dedupeKey: regression.check,
    });
  }
  // Improvements are recorded but never notify. Seeing that Friday's
  // deploy fixed three findings is genuinely useful in the timeline and
  // in a client report; it is not worth a notification.
  for (const improvement of improvements) {
    await recordSecurityEvent(monitor, {
      kind: "scan_improvement",
      severity: "info",
      title: `${improvement.check} now passes`,
      detail: improvement.detail,
      data: { check: improvement.check },
      dedupeKey: improvement.check,
      notify: false,
    });
  }

  // --- Blacklist / malware reputation ---
  //
  // Skipped entirely when no API key is configured (see
  // blacklistCheckConfigured), so a deployment without one just never
  // touches these columns rather than writing a false "clean".
  if (blacklistCheckConfigured()) {
    const previousStatus = monitor.blacklist_status;
    const blacklistResult = await checkBlacklist(monitor.url);
    await pool.query(
      `UPDATE monitors SET blacklist_status = $2, blacklist_threats = $3, blacklist_checked_at = now() WHERE id = $1`,
      [monitor.id, blacklistResult.status, JSON.stringify(blacklistResult.threats)]
    );
    if (blacklistResult.status === "flagged") {
      await recordSecurityEvent(monitor, {
        kind: "blacklist_flagged",
        severity: "critical",
        title: `flagged by Google Safe Browsing: ${blacklistResult.threats.join(", ")}`,
        detail: "This URL currently appears on Google's Safe Browsing list. Browsers may show visitors a warning page before they can reach the site. Worth treating as urgent - a flag like this can come from a compromise you don't know about yet, not just from content you intended to publish.",
        data: { threats: blacklistResult.threats },
        dedupeKey: blacklistResult.threats.slice().sort().join(","),
      });
    } else if (previousStatus === "flagged" && blacklistResult.status === "clean") {
      await recordSecurityEvent(monitor, {
        kind: "blacklist_cleared",
        severity: "info",
        title: "no longer flagged by Google Safe Browsing",
        detail: "The previous flag has cleared.",
        notify: false,
      });
    }
  }

  // --- New third-party origins ---
  //
  // A script origin appearing on a page that didn't have it before is
  // what a supply-chain compromise looks like from the outside. It's
  // also what adding a legitimate analytics tag looks like, so this is a
  // "confirm this was you" notification rather than an accusation.
  const previousOrigins = monitor.third_party_origins || [];
  const currentOrigins = result.meta?.thirdPartyOrigins || [];
  if (Array.isArray(previousOrigins) && previousOrigins.length > 0) {
    const added = currentOrigins.filter((origin) => !previousOrigins.includes(origin));
    if (added.length > 0) {
      await recordSecurityEvent(monitor, {
        kind: "third_party_origin_added",
        severity: "medium",
        title: `new third-party script origin${added.length === 1 ? "" : "s"} on the page`,
        detail: `${added.join(", ")} now serve${added.length === 1 ? "s" : ""} script, iframe or stylesheet content on this page and didn't at the last scan. If that was a deliberate change (a new analytics or support widget), nothing to do. If it wasn't, this is what an injected script looks like from the outside.`,
        data: { added, previous: previousOrigins, current: currentOrigins },
        dedupeKey: added.sort().join(","),
      });
    }
  }

  return rows[0];
}

// ---------------------------------------------------------------------
// DNS sweep
// ---------------------------------------------------------------------

// Cheap enough (a handful of UDP lookups, no HTTP) to run on a much
// tighter cadence than the scan sweep. Drift is the signal here where
// the delay between "it changed" and "you found out" is the entire
// value of the feature.
export async function runDnsSweep({ userId = null, limit = MAX_DNS_CHECKS_PER_RUN } = {}) {
  const conditions = [
    `active = true`,
    `monitor_type != 'tcp'`,
    `(dns_checked_at IS NULL OR dns_checked_at <= now() - interval '${DNS_CHECK_INTERVAL_HOURS} hours')`,
  ];
  const params = [];
  if (userId) {
    params.push(userId);
    conditions.push(`user_id = $${params.length}`);
  }
  params.push(limit);

  const { rows: due } = await pool.query(
    `SELECT * FROM monitors WHERE ${conditions.join(" AND ")} LIMIT $${params.length}`,
    params
  );

  let checked = 0;
  for (const monitor of due) {
    const hostname = hostnameFromUrl(monitor.url);
    if (!hostname) continue;

    let snapshot;
    try {
      snapshot = await snapshotDns(hostname);
    } catch {
      continue;
    }

    const previous = monitor.dns_snapshot || null;

    await pool.query(`UPDATE monitors SET dns_snapshot = $2, dns_checked_at = now() WHERE id = $1`, [
      monitor.id,
      JSON.stringify(snapshot),
    ]);
    await pool.query(`INSERT INTO dns_snapshots (monitor_id, records) VALUES ($1, $2)`, [monitor.id, JSON.stringify(snapshot)]);
    checked += 1;

    // First snapshot is a baseline, not a change - same rule as every
    // other before/after detector in this app.
    for (const change of diffSnapshots(previous, snapshot)) {
      await recordSecurityEvent(monitor, {
        kind: "dns_drift",
        severity: change.severity,
        title: `${change.label} record changed`,
        detail: `${change.summary}. If you didn't make this change, treat it seriously - DNS is how an attacker redirects a domain without ever touching the server.`,
        data: change,
        dedupeKey: `${change.record}:${[...change.added, ...change.removed].sort().join(",")}`,
      });
    }

    // Dangling CNAME / subdomain takeover.
    const dangling = await checkDanglingCname(hostname, snapshot);
    if (dangling) {
      await recordSecurityEvent(monitor, {
        kind: "dangling_cname",
        severity: "critical",
        title: `possible subdomain takeover (${dangling.platform})`,
        detail: dangling.detail,
        data: dangling,
        dedupeKey: `${dangling.platform}:${dangling.target}`,
      });
    }
  }

  return checked;
}

// ---------------------------------------------------------------------
// Certificate Transparency sweep
// ---------------------------------------------------------------------

export async function runCtSweep({ userId = null, limit = MAX_CT_CHECKS_PER_RUN } = {}) {
  const conditions = [
    `active = true`,
    `ct_enabled = true`,
    `url LIKE 'https://%'`,
    `(ct_checked_at IS NULL OR ct_checked_at <= now() - interval '${CT_CHECK_INTERVAL_HOURS} hours')`,
  ];
  const params = [];
  if (userId) {
    params.push(userId);
    conditions.push(`user_id = $${params.length}`);
  }
  params.push(limit);

  const { rows: due } = await pool.query(
    `SELECT * FROM monitors WHERE ${conditions.join(" AND ")} LIMIT $${params.length}`,
    params
  );

  let checked = 0;
  for (const monitor of due) {
    const hostname = hostnameFromUrl(monitor.url);
    if (!hostname) continue;
    const root = registrableRoot(hostname);

    let certificates;
    try {
      certificates = await fetchCtCertificates(root);
    } catch (err) {
      // crt.sh being slow or down is not an event worth telling anyone
      // about. Mark it checked so one unavailable third party can't jam
      // the sweep on the same monitor forever.
      console.error(`CT lookup failed for ${root}:`, err.message);
      await pool.query(`UPDATE monitors SET ct_checked_at = now() WHERE id = $1`, [monitor.id]);
      continue;
    }

    const { rows: knownRows } = await pool.query(`SELECT cert_id, issuer FROM ct_certificates WHERE monitor_id = $1`, [monitor.id]);
    const isFirstRun = knownRows.length === 0;
    const knownIds = new Set(knownRows.map((row) => row.cert_id));
    const knownIssuers = new Set(knownRows.map((row) => normalizeIssuer(row.issuer || "")));

    for (const cert of certificates) {
      await pool.query(
        `INSERT INTO ct_certificates (monitor_id, cert_id, common_name, names, issuer, not_before, not_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (monitor_id, cert_id) DO NOTHING`,
        [monitor.id, cert.id, cert.commonName, JSON.stringify(cert.names), cert.issuer, cert.notBefore || null, cert.notAfter || null]
      );
    }

    await pool.query(`UPDATE monitors SET ct_checked_at = now() WHERE id = $1`, [monitor.id]);
    checked += 1;

    // The first sweep for a monitor imports the domain's entire current
    // certificate history. Alerting on that would mean dozens of
    // notifications for certificates the user has had for years - so the
    // first run is silently a baseline, exactly like content_hash and
    // tls_fingerprint.
    if (isFirstRun) continue;

    // Only certificates that are both new to us *and* recently issued.
    // A cert we've never seen but which was issued eight months ago is
    // a gap in our own records, not an issuance event.
    const unseen = certificates.filter((cert) => !knownIds.has(cert.id));
    for (const cert of recentlyIssued(unseen, 7)) {
      const familiarIssuer = knownIssuers.has(normalizeIssuer(cert.issuer || ""));
      await recordSecurityEvent(monitor, {
        kind: "ct_new_certificate",
        severity: familiarIssuer ? "low" : "high",
        title: familiarIssuer ? "new certificate issued (familiar CA)" : "new certificate issued by an unfamiliar CA",
        detail: familiarIssuer
          ? `A certificate for ${cert.commonName || cert.names[0]} was logged, issued by ${cert.issuer}, a CA that has issued for this domain before. Almost certainly a renewal.`
          : `A certificate covering ${cert.names.slice(0, 5).join(", ")} was issued by ${cert.issuer}, which has never issued for this domain before. If you didn't request it, someone else proved control of the domain to a CA - check your DNS and registrar account.`,
        data: { certId: cert.id, names: cert.names, issuer: cert.issuer, notBefore: cert.notBefore, notAfter: cert.notAfter },
        dedupeKey: cert.id,
      });
    }
  }

  return checked;
}

async function alertDown(monitor, result, incidentId) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const title = `${monitor.name} is down`;
  const body = result.errorMessage || "Check failed.";
  if (wantsNotification(user, "push", "down")) await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse alert: ${title}`, text: `${body}\n\nURL: ${monitor.url}` });
  if (wantsNotification(user, "telegram", "down")) await sendTelegramMessage({ chatId: resolveChatId(user), text: `🔴 ${title}\n${body}\n\n${monitor.url}` });
  if (wantsNotification(user, "webhook", "down")) await sendWebhookAlert(user.webhook_url, { event: "down", severity: "high", title, body, monitor });
}

async function alertStillDown(monitor, result, incident) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const downtimeMs = Date.now() - new Date(incident.started_at).getTime();
  const hours = Math.round(downtimeMs / 3600000);
  const title = `${monitor.name} is still down`;
  const body = `Down for about ${hours} hour${hours === 1 ? "" : "s"} now. Latest: ${result.errorMessage || "Check failed."}`;
  if (wantsNotification(user, "push", "down")) await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse alert: ${title}`, text: `${body}\n\nURL: ${monitor.url}` });
  if (wantsNotification(user, "telegram", "down")) await sendTelegramMessage({ chatId: resolveChatId(user), text: `🔴 ${title}\n${body}\n\n${monitor.url}` });
  if (wantsNotification(user, "webhook", "down")) await sendWebhookAlert(user.webhook_url, { event: "still_down", severity: "high", title, body, monitor });
}

async function alertRecovered(monitor, incident) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const downtimeMs = Date.now() - new Date(incident.started_at).getTime();
  const minutes = Math.round(downtimeMs / 60000);
  const title = `${monitor.name} is back up`;
  const body = `Was down for about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  if (wantsNotification(user, "push", "down")) await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: body });
  if (wantsNotification(user, "telegram", "down")) await sendTelegramMessage({ chatId: resolveChatId(user), text: `🟢 ${title}\n${body}` });
  if (wantsNotification(user, "webhook", "down")) await sendWebhookAlert(user.webhook_url, { event: "recovered", severity: "info", title, body, monitor });
}

async function alertContentChanged(monitor) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const title = `${monitor.name} content changed`;
  const body = "The page's content changed since the last check. If this was an expected deploy, no action needed - the new content is now the baseline for future comparisons.";
  if (wantsNotification(user, "push", "contentChanged")) await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: `${body}\n\nURL: ${monitor.url}` });
  if (wantsNotification(user, "telegram", "contentChanged")) await sendTelegramMessage({ chatId: resolveChatId(user), text: `📝 ${title}\n${body}\n\n${monitor.url}` });
  if (wantsNotification(user, "webhook", "contentChanged")) await sendWebhookAlert(user.webhook_url, { event: "content_changed", severity: "medium", title, body, monitor });
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
  if (wantsNotification(user, "push", "degraded")) await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: `${body}\n\nURL: ${monitor.url}` });
  if (wantsNotification(user, "telegram", "degraded")) await sendTelegramMessage({ chatId: resolveChatId(user), text: `🟡 ${title}\n${body}\n\n${monitor.url}` });
  if (wantsNotification(user, "webhook", "degraded")) await sendWebhookAlert(user.webhook_url, { event: "degraded", severity: "medium", title, body, monitor });
}

async function alertNoLongerDegraded(monitor) {
  const { rows: userRows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  const user = userRows[0];
  if (!user) return;
  const title = `${monitor.name} is back to normal speed`;
  const body = "Response time is back under the slow threshold.";
  if (wantsNotification(user, "push", "degraded")) await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: body });
  if (wantsNotification(user, "telegram", "degraded")) await sendTelegramMessage({ chatId: resolveChatId(user), text: `🟢 ${title}` });
  if (wantsNotification(user, "webhook", "degraded")) await sendWebhookAlert(user.webhook_url, { event: "degraded_recovered", severity: "info", title, body, monitor });
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
  if (wantsNotification(user, "push", "expiring")) await sendPushToUser(monitor.user_id, { title, body, url: `/monitors/${monitor.id}` });
  await sendAlertEmail({ to: user.alert_email, subject: `Pulse: ${title}`, text: body });
  if (wantsNotification(user, "telegram", "expiring")) await sendTelegramMessage({ chatId: resolveChatId(user), text: `⚠️ ${title}\n${body}` });
  if (wantsNotification(user, "webhook", "expiring")) await sendWebhookAlert(user.webhook_url, { event: "expiring", severity: "medium", title, body, monitor });
}
