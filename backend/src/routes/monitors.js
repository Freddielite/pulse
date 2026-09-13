import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { runUptimeChecks, scanAndRecord, runDnsSweep, runCtSweep } from "../lib/checkRunner.js";
import { parseAcceptedStatuses } from "../lib/authProbe.js";
import { generateShareToken } from "../lib/shareLinks.js";
import { requireOrgRole, logOrgAction } from "../lib/orgAccess.js";

const router = Router();
router.use(requireAuth);

// Gate for every route that changes a monitor rather than just reading
// it: the monitor's own creator can always manage it, and otherwise
// only admin+ on the org that owns it - a plain member can see a
// monitor and get paged by it (that's the whole point of being on the
// team) without being able to edit, delete, snooze, rescan, or manage
// its share link. Distinct from the broadened SELECT/UPDATE/DELETE
// WHERE clauses used throughout this file, which grant every member
// read access (and, as a defense-in-depth backstop, still scope every
// query to rows the requester has SOME relationship to) - this is the
// actual permission check, run before the mutation itself, so a member
// without access gets a clear 403 rather than a query that silently
// matches zero rows.
async function loadMonitorForMutation(req, res) {
  const { rows } = await pool.query(`SELECT * FROM monitors WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: "monitor not found" });
    return null;
  }
  const monitor = rows[0];
  const isCreator = monitor.user_id === req.userId;
  const isOrgAdmin = monitor.organization_id && (await requireOrgRole(req.userId, monitor.organization_id, "admin"));
  if (!isCreator && !isOrgAdmin) {
    res.status(403).json({ error: "admin access on this monitor's organization is required for that" });
    return null;
  }
  return monitor;
}

// monitor_type as sent by the client, coerced to one of the three real
// values. Anything unrecognized falls back to 'http' - the safe default,
// since an http monitor's steps/tcp target are simply ignored rather
// than acted on.
function normalizeMonitorType(type) {
  if (type === "synthetic") return "synthetic";
  if (type === "tcp") return "tcp";
  return "http";
}

// Only enforced for a tcp-type monitor - http/synthetic monitors' urls
// are already covered by the generic new URL(url) check at the top of
// each route. tcp:// parses fine under that generic check too (it's a
// syntactically valid, if unusual, URL scheme), so this catches the two
// things that check alone wouldn't: the wrong scheme, and a missing port
// (tcpCheck.js's parseTcpTarget has nothing to connect to without one).
function validateTcpUrl(url) {
  const parsed = new URL(url); // caller already confirmed this doesn't throw
  if (parsed.protocol !== "tcp:") return "a TCP monitor's URL must start with tcp://, e.g. tcp://db.example.com:5432";
  if (!parsed.port) return "a TCP monitor's URL needs a port, e.g. tcp://db.example.com:5432";
  return null;
}

// auth_probe_expect is a comma-separated status list. Validated here
// rather than trusted, because an unparseable value would silently fall
// back to the 401,403 default at probe time and the user would have no
// idea their "404" was ignored.
function validateAuthProbe(enabled, expect) {
  if (!enabled) return null;
  if (expect === undefined || expect === null || expect === "") return null;
  const parsed = String(expect)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parsed.length === 0) return "the auth probe needs at least one expected status code";
  for (const part of parsed) {
    const code = Number(part);
    if (!Number.isInteger(code) || code < 100 || code > 599) return `"${part}" isn't a valid HTTP status code`;
    // A 2xx as the "refusal" status would make the probe assert the exact
    // opposite of what it's for, and is much more likely a typo than an
    // intention.
    if (code >= 200 && code < 300) return `${code} is a success status - the auth probe asserts that an unauthenticated request is *refused*, so this should be 401, 403, or similar`;
  }
  return null;
}

// Shared by both create and update. Only enforced when the monitor is (or
// is being changed to) 'synthetic' - an 'http' monitor's steps are simply
// ignored, so there's nothing to validate for it.
function validateSteps(type, steps) {
  if (type !== "synthetic") return null;
  if (!Array.isArray(steps) || steps.length === 0) {
    return "a synthetic check needs at least one step";
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step?.url?.trim()) return `step ${i + 1} needs a URL`;
    try {
      new URL(step.url.includes("{{") ? step.url.replace(/\{\{[^}]*\}\}/g, "x") : step.url);
    } catch {
      return `step ${i + 1}'s URL doesn't look valid`;
    }
  }
  return null;
}

router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM monitors
     WHERE user_id = $1 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $1)
     ORDER BY created_at ASC`,
    [req.userId]
  );
  res.json(rows);
});

// Button-triggered version of the cron tick, scoped to one user's own
// monitors and ignoring each monitor's check_interval_min (that interval
// exists to pace the automatic schedule, not to block someone who's
// sitting there wanting to see a result right now). Snoozed monitors are
// still skipped though - the whole point of snoozing is to silence a
// monitor during known maintenance, and this button firing an alert
// anyway would defeat that.
router.post("/check-now", async (req, res) => {
  const { rows: mine } = await pool.query(
    `SELECT * FROM monitors
     WHERE (user_id = $1 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $1))
       AND active = true AND (snoozed_until IS NULL OR snoozed_until <= now())`,
    [req.userId]
  );
  const results = await runUptimeChecks(mine);
  res.json(results);
});

router.post("/", async (req, res) => {
  const {
    name, url, method, expected_status, auth_header_name, auth_header_value, check_interval_min, keep_alive_target,
    group_name, body_contains, alert_after_failures, content_diff_enabled, monitor_type, synthetic_steps, check_timeout_sec,
    degraded_threshold_ms, alert_after_slow, auth_probe_enabled, auth_probe_expect, ct_enabled, organization_id,
  } = req.body;
  if (!name?.trim() || !url?.trim()) return res.status(400).json({ error: "name and url are required" });
  try {
    new URL(url); // throws on a malformed URL, caught below
  } catch {
    return res.status(400).json({ error: "that doesn't look like a valid URL" });
  }
  if (alert_after_failures !== undefined && alert_after_failures !== null && Number(alert_after_failures) < 1) {
    return res.status(400).json({ error: "alert after failures must be at least 1" });
  }
  if (check_timeout_sec !== undefined && check_timeout_sec !== null && (Number(check_timeout_sec) < 3 || Number(check_timeout_sec) > 60)) {
    return res.status(400).json({ error: "check timeout must be between 3 and 60 seconds" });
  }
  if (degraded_threshold_ms !== undefined && degraded_threshold_ms !== null && Number(degraded_threshold_ms) < 100) {
    return res.status(400).json({ error: "degraded threshold must be at least 100ms" });
  }
  if (alert_after_slow !== undefined && alert_after_slow !== null && Number(alert_after_slow) < 1) {
    return res.status(400).json({ error: "alert after slow checks must be at least 1" });
  }
  const authProbeError = validateAuthProbe(auth_probe_enabled, auth_probe_expect);
  if (authProbeError) return res.status(400).json({ error: authProbeError });
  const type = normalizeMonitorType(monitor_type);
  const stepsError = validateSteps(type, synthetic_steps);
  if (stepsError) return res.status(400).json({ error: stepsError });
  if (type === "tcp") {
    const tcpError = validateTcpUrl(url);
    if (tcpError) return res.status(400).json({ error: tcpError });
  }
  // Assigning a new monitor to an org, rather than keeping it personal,
  // takes admin+ in that org - member is view-only for creation, the one
  // place role actually gates a monitor-mutation action (see the note
  // at the top of lib/orgAccess.js on why the rest of monitor
  // mutation doesn't yet have the same gate).
  if (organization_id) {
    const allowed = await requireOrgRole(req.userId, organization_id, "admin");
    if (!allowed) return res.status(403).json({ error: "you need admin access on that organization to add monitors to it" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO monitors
         (user_id, name, url, method, expected_status, auth_header_name, auth_header_value, check_interval_min, keep_alive_target, group_name, body_contains, alert_after_failures, content_diff_enabled, monitor_type, synthetic_steps, check_timeout_sec, degraded_threshold_ms, alert_after_slow, auth_probe_enabled, auth_probe_expect, ct_enabled, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING *`,
      [
        req.userId,
        name.trim(),
        url.trim(),
        method || "GET",
        expected_status || 200,
        auth_header_name || null,
        auth_header_value || null,
        check_interval_min || 5,
        !!keep_alive_target,
        group_name?.trim() || null,
        body_contains?.trim() || null,
        Number(alert_after_failures) || 1,
        !!content_diff_enabled,
        type,
        type === "synthetic" ? JSON.stringify(synthetic_steps) : null,
        Number(check_timeout_sec) || 15,
        degraded_threshold_ms ? Number(degraded_threshold_ms) : null,
        Number(alert_after_slow) || 3,
        !!auth_probe_enabled,
        auth_probe_expect?.trim() || "401,403",
        ct_enabled === undefined ? true : !!ct_enabled,
        organization_id || null,
      ]
    );
    if (organization_id) await logOrgAction(organization_id, req.userId, "monitor_created", `added monitor "${rows[0].name}"`);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create monitor" });
  }
});

router.patch("/:id", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  const {
    name, url, method, expected_status, auth_header_name, auth_header_value, check_interval_min, keep_alive_target,
    active, group_name, body_contains, alert_after_failures, content_diff_enabled, monitor_type, synthetic_steps, check_timeout_sec,
    degraded_threshold_ms, alert_after_slow, auth_probe_enabled, auth_probe_expect, ct_enabled, organization_id,
  } = req.body;
  if (alert_after_failures !== undefined && alert_after_failures !== null && Number(alert_after_failures) < 1) {
    return res.status(400).json({ error: "alert after failures must be at least 1" });
  }
  if (check_timeout_sec !== undefined && check_timeout_sec !== null && (Number(check_timeout_sec) < 3 || Number(check_timeout_sec) > 60)) {
    return res.status(400).json({ error: "check timeout must be between 3 and 60 seconds" });
  }
  if (degraded_threshold_ms !== undefined && degraded_threshold_ms !== null && Number(degraded_threshold_ms) < 100) {
    return res.status(400).json({ error: "degraded threshold must be at least 100ms" });
  }
  if (alert_after_slow !== undefined && alert_after_slow !== null && Number(alert_after_slow) < 1) {
    return res.status(400).json({ error: "alert after slow checks must be at least 1" });
  }
  const authProbeError = validateAuthProbe(auth_probe_enabled, auth_probe_expect);
  if (authProbeError) return res.status(400).json({ error: authProbeError });
  if (monitor_type !== undefined) {
    const stepsError = validateSteps(normalizeMonitorType(monitor_type), synthetic_steps);
    if (stepsError) return res.status(400).json({ error: stepsError });
    if (normalizeMonitorType(monitor_type) === "tcp" && url) {
      const tcpError = validateTcpUrl(url);
      if (tcpError) return res.status(400).json({ error: tcpError });
    }
  }
  // Moving a monitor between personal and org ownership (or between two
  // orgs) is deliberately narrower than the general admin+ gate above:
  // only the monitor's own creator can do it at all - an org admin who
  // didn't create this particular monitor can edit/delete it, but can't
  // reassign it away from wherever its creator put it. Moving it INTO
  // an org additionally needs admin+ there, same bar as creating a new
  // monitor under that org.
  if (organization_id !== undefined) {
    if (monitor.user_id !== req.userId) {
      return res.status(403).json({ error: "only the monitor's creator can move it between personal and organization ownership" });
    }
    if (organization_id) {
      const allowed = await requireOrgRole(req.userId, organization_id, "admin");
      if (!allowed) return res.status(403).json({ error: "you need admin access on that organization to move monitors into it" });
    }
  }
  try {
    const willTouchSteps = monitor_type !== undefined;
    const nextType = monitor_type === undefined ? null : normalizeMonitorType(monitor_type);
    const nextSteps = nextType === "synthetic" ? JSON.stringify(synthetic_steps) : null;
    const { rows } = await pool.query(
      `UPDATE monitors SET
         name = COALESCE($3, name),
         url = COALESCE($4, url),
         method = COALESCE($5, method),
         expected_status = COALESCE($6, expected_status),
         auth_header_name = $7,
         auth_header_value = $8,
         check_interval_min = COALESCE($9, check_interval_min),
         keep_alive_target = COALESCE($10, keep_alive_target),
         active = COALESCE($11, active),
         group_name = $12,
         body_contains = $13,
         alert_after_failures = COALESCE($14, alert_after_failures),
         content_diff_enabled = COALESCE($15, content_diff_enabled),
         monitor_type = COALESCE($16, monitor_type),
         synthetic_steps = CASE WHEN $17 THEN $18::jsonb ELSE synthetic_steps END,
         check_timeout_sec = COALESCE($19, check_timeout_sec),
         degraded_threshold_ms = $20,
         alert_after_slow = COALESCE($21, alert_after_slow),
         auth_probe_enabled = COALESCE($22, auth_probe_enabled),
         auth_probe_expect = COALESCE($23, auth_probe_expect),
         ct_enabled = COALESCE($24, ct_enabled),
         -- Turning the probe off clears its last verdict rather than
         -- leaving a stale "fail" sitting on the monitor row, which the
         -- UI would otherwise keep rendering as a live problem.
         auth_probe_status = CASE WHEN $22 IS NOT NULL AND $22 = false THEN NULL ELSE auth_probe_status END,
         -- Explicit-clear-is-valid, same pattern as users.webhook_url in
         -- routes/auth.js: organization_id genuinely can be set back to
         -- NULL (moved to personal) as a real request, which a plain
         -- COALESCE could never distinguish from "field wasn't sent".
         organization_id = CASE WHEN $25 THEN $26 ELSE organization_id END,
         updated_at = now()
       WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2)) RETURNING *`,
      [
        req.params.id,
        req.userId,
        name,
        url,
        method,
        expected_status,
        auth_header_name ?? null,
        auth_header_value ?? null,
        check_interval_min,
        keep_alive_target,
        active,
        group_name?.trim() || null,
        body_contains?.trim() || null,
        alert_after_failures ? Number(alert_after_failures) : null,
        content_diff_enabled === undefined ? null : !!content_diff_enabled,
        nextType,
        willTouchSteps,
        nextSteps,
        check_timeout_sec ? Number(check_timeout_sec) : null,
        degraded_threshold_ms ? Number(degraded_threshold_ms) : null,
        alert_after_slow ? Number(alert_after_slow) : null,
        auth_probe_enabled === undefined ? null : !!auth_probe_enabled,
        auth_probe_expect?.trim() || null,
        ct_enabled === undefined ? null : !!ct_enabled,
        organization_id !== undefined,
        organization_id || null,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: "monitor not found" });
    // Moving a monitor INTO an org gets logged there; moving it OUT (back
    // to personal) has nowhere to log to, since personal ownership has
    // no audit trail of its own.
    if (organization_id) {
      await logOrgAction(organization_id, req.userId, "monitor_created", `moved existing monitor "${rows[0].name}" into this org`);
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update monitor" });
  }
});

// Snooze/unsnooze are deliberately separate endpoints rather than fields
// on the general PATCH above: PATCH's COALESCE(new, old) pattern can't
// distinguish "don't touch this field" from "explicitly clear it back to
// null", which unsnoozing needs. A dedicated pair of action endpoints
// sidesteps that ambiguity entirely.
router.post("/:id/snooze", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  const minutes = Number(req.body.minutes);
  if (!minutes || minutes <= 0) return res.status(400).json({ error: "minutes must be a positive number" });
  const { rows } = await pool.query(
    `UPDATE monitors SET snoozed_until = now() + ($2 || ' minutes')::interval, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.id, minutes]
  );
  res.json(rows[0]);
});

router.post("/:id/unsnooze", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  const { rows } = await pool.query(
    `UPDATE monitors SET snoozed_until = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  res.json(rows[0]);
});

// Bulk versions of the same action, scoped to every active monitor the
// requester can actually manage at once - their own personal monitors,
// plus any org monitor where they're admin+ on that org (mirrors
// loadMonitorForMutation's isCreator || isOrgAdmin bar, just applied to
// a whole set instead of one id). A plain member's org monitors are
// deliberately left out here even though the member can see and get
// paged by them - bulk-snoozing monitors a member doesn't manage would
// be the same overreach loadMonitorForMutation blocks one at a time.
router.post("/snooze-all", async (req, res) => {
  const minutes = Number(req.body.minutes);
  if (!minutes || minutes <= 0) return res.status(400).json({ error: "minutes must be a positive number" });
  const { rows } = await pool.query(
    `UPDATE monitors SET snoozed_until = now() + ($2 || ' minutes')::interval, updated_at = now()
     WHERE (user_id = $1 OR organization_id IN (
             SELECT organization_id FROM organization_members WHERE user_id = $1 AND role IN ('admin', 'owner')
           ))
       AND active = true RETURNING id`,
    [req.userId, minutes]
  );
  res.json({ snoozed: rows.length });
});

router.post("/unsnooze-all", async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE monitors SET snoozed_until = NULL, updated_at = now()
     WHERE (user_id = $1 OR organization_id IN (
             SELECT organization_id FROM organization_members WHERE user_id = $1 AND role IN ('admin', 'owner')
           ))
       AND snoozed_until IS NOT NULL RETURNING id`,
    [req.userId]
  );
  res.json({ unsnoozed: rows.length });
});

router.delete("/:id", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  await pool.query(`DELETE FROM monitors WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// Recent checks for the uptime chart / response-time trend.
router.get("/:id/checks", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const { rows } = await pool.query(
    `SELECT * FROM checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT $2`,
    [req.params.id, limit]
  );
  res.json(rows.reverse());
});

router.get("/:id/incidents", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const { rows } = await pool.query(
    `SELECT * FROM incidents WHERE monitor_id = $1 ORDER BY started_at DESC LIMIT 50`,
    [req.params.id]
  );
  res.json(rows);
});

// Private by construction: this only reaches security_scans through a
// route scoped to the caller's own monitor.user_id, same as every other
// per-monitor route here. There's no public equivalent of this endpoint.
router.get("/:id/security", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const { rows } = await pool.query(
    `SELECT * FROM security_scans WHERE monitor_id = $1 ORDER BY scanned_at DESC LIMIT 1`,
    [req.params.id]
  );
  if (rows.length === 0) return res.json(null);
  res.json(rows[0]);
});

// Force a scan right now, ignoring the 24h cadence, the same "I don't want
// to wait" escape hatch check-now gives uptime checks. Goes through
// scanAndRecord so a manual scan produces the same regression events an
// automatic sweep would - there's no second path that quietly skips the
// diffing.
router.post("/:id/security/run", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  if (monitor.monitor_type === "tcp") {
    return res.status(400).json({ error: "Security scanning doesn't apply to a TCP monitor - there's no HTTP response to check headers on." });
  }

  const scan = await scanAndRecord(monitor);
  res.json(scan);
});

// Score history for the trend chart. This is the read that makes the
// scan a monitor rather than a one-off: a score on its own says how a
// site is configured, a series says whether it's getting better or worse
// and when it changed.
router.get("/:id/security/history", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const limit = Math.min(Number(req.query.limit) || 60, 365);
  const { rows } = await pool.query(
    // Deliberately not selecting `findings` - a history query pulling the
    // full findings array for 60 scans would be megabytes of JSON to
    // render a sparkline out of two columns.
    `SELECT id, scanned_at, score, grade, summary FROM security_scans
     WHERE monitor_id = $1 ORDER BY scanned_at DESC LIMIT $2`,
    [req.params.id, limit]
  );
  res.json(rows.reverse());
});

// The security timeline: everything that changed, newest first.
router.get("/:id/security/events", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await pool.query(
    `SELECT * FROM security_events WHERE monitor_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [req.params.id, limit]
  );
  res.json(rows);
});

// Acknowledging an event doesn't delete it - the timeline is a record,
// and a client report is worth more when it shows what happened and that
// it was dealt with, not just what's currently outstanding.
router.post("/:id/security/events/:eventId/acknowledge", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  const { rows } = await pool.query(
    `UPDATE security_events SET acknowledged = true WHERE id = $1 AND monitor_id = $2 RETURNING *`,
    [req.params.eventId, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "event not found" });
  res.json(rows[0]);
});

// Real, browser-reported CSP violations - see routes/public.js for the
// ingestion side. Read-only, same as every other GET here: a member
// should see everything a scan or an event feed would show them.
router.get("/:id/csp-violations", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const { rows } = await pool.query(
    `SELECT * FROM csp_violations WHERE monitor_id = $1 ORDER BY last_seen_at DESC LIMIT 200`,
    [req.params.id]
  );
  res.json(rows);
});

// Clearing the list is a mutation like anything else that changes what's
// stored against a monitor - creator or admin+ only, same gate as
// deleting the monitor itself.
router.delete("/:id/csp-violations", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  await pool.query(`DELETE FROM csp_violations WHERE monitor_id = $1`, [req.params.id]);
  res.status(204).end();
});

// TLS posture from the last handshake: protocol, cipher, chain, SANs,
// fingerprint. Read straight off the monitor row - the cert sweep is what
// populates it.
router.get("/:id/tls", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT tls_posture, tls_fingerprint, ssl_expires_at, cert_checked_at, cert_check_error
     FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`,
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  res.json(rows[0]);
});

// Current DNS snapshot plus recent history, for the drift panel.
router.get("/:id/dns", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT dns_snapshot, dns_checked_at FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`,
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const { rows: history } = await pool.query(
    `SELECT id, taken_at FROM dns_snapshots WHERE monitor_id = $1 ORDER BY taken_at DESC LIMIT 20`,
    [req.params.id]
  );
  res.json({ ...rows[0], history });
});

router.post("/:id/dns/run", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  // Reuses the sweep rather than duplicating its drift-detection logic,
  // scoped to this one monitor by clearing its due-clock first. Same
  // reasoning as routing the manual scan through scanAndRecord.
  await pool.query(`UPDATE monitors SET dns_checked_at = NULL WHERE id = $1`, [req.params.id]);
  await runDnsSweep({ monitorId: req.params.id, limit: 1 });
  const { rows } = await pool.query(`SELECT dns_snapshot, dns_checked_at FROM monitors WHERE id = $1`, [req.params.id]);
  res.json(rows[0]);
});

// Certificates seen in the public CT logs, plus the subdomain inventory
// derived from them.
router.get("/:id/certificates", async (req, res) => {
  const owns = await pool.query(`SELECT id, url FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const { rows } = await pool.query(
    `SELECT cert_id, common_name, names, issuer, not_before, not_after, first_seen_at
     FROM ct_certificates WHERE monitor_id = $1 ORDER BY not_before DESC NULLS LAST LIMIT 200`,
    [req.params.id]
  );

  // The subdomain inventory is derived here rather than stored, so it's
  // always consistent with the certificate rows it comes from.
  const subdomains = new Set();
  for (const row of rows) {
    for (const name of row.names || []) {
      if (!name.startsWith("*.")) subdomains.add(name);
    }
  }

  // Which of those subdomains the user is already monitoring, so the UI
  // can offer one-click "monitor this too" on the ones they aren't. This
  // is the payoff of CT discovery: the forgotten staging box shows up
  // here as an unmonitored hostname.
  const { rows: existing } = await pool.query(
    `SELECT url FROM monitors WHERE user_id = $1 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $1)`,
    [req.userId]
  );
  const monitoredHosts = new Set(
    existing
      .map((row) => {
        try {
          return new URL(row.url).hostname.toLowerCase();
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );

  res.json({
    certificates: rows,
    subdomains: [...subdomains].sort().map((hostname) => ({ hostname, monitored: monitoredHosts.has(hostname) })),
  });
});

router.post("/:id/certificates/run", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  await pool.query(`UPDATE monitors SET ct_checked_at = NULL WHERE id = $1`, [req.params.id]);
  const checked = await runCtSweep({ monitorId: req.params.id, limit: 1 });
  if (checked === 0) {
    return res.status(502).json({ error: "The Certificate Transparency lookup didn't complete - crt.sh may be slow or unavailable right now. Try again shortly." });
  }
  res.json({ ok: true });
});

// Uptime percentage over rolling windows, computed from the checks log
// rather than stored, so it's always consistent with what's actually there.
router.get("/:id/uptime", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const { rows } = await pool.query(
    `SELECT
       window_days,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'up') / NULLIF(COUNT(*), 0), 2) AS uptime_pct,
       COUNT(*) AS total_checks
     FROM checks, (VALUES (1), (7), (30)) AS windows(window_days)
     WHERE monitor_id = $1 AND checked_at >= now() - (window_days || ' days')::interval
     GROUP BY window_days`,
    [req.params.id]
  );
  const byWindow = Object.fromEntries(rows.map((r) => [r.window_days, r]));
  res.json({
    "24h": byWindow[1] || { uptime_pct: null, total_checks: 0 },
    "7d": byWindow[7] || { uptime_pct: null, total_checks: 0 },
    "30d": byWindow[30] || { uptime_pct: null, total_checks: 0 },
  });
});

// Turns sharing on. Idempotent by design - re-opening the Share panel
// and hitting this again returns the same link rather than silently
// rotating it out from under whoever already has it. Regenerate is the
// explicit, separate action for actually invalidating an old link.
router.post("/:id/share", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  if (monitor.share_token) return res.json({ share_token: monitor.share_token });
  try {
    const { rows } = await pool.query(
      `UPDATE monitors SET share_token = $2, updated_at = now() WHERE id = $1 RETURNING share_token`,
      [req.params.id, generateShareToken()]
    );
    res.json({ share_token: rows[0].share_token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create share link" });
  }
});

// Issues a new token and drops the old one in the same write, so the
// previous link stops resolving the instant the new one exists - no
// window where both are live.
router.post("/:id/share/regenerate", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  try {
    const { rows } = await pool.query(
      `UPDATE monitors SET share_token = $2, updated_at = now() WHERE id = $1 RETURNING share_token`,
      [req.params.id, generateShareToken()]
    );
    res.json({ share_token: rows[0].share_token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to regenerate share link" });
  }
});

router.delete("/:id/share", async (req, res) => {
  const monitor = await loadMonitorForMutation(req, res);
  if (!monitor) return;
  await pool.query(`UPDATE monitors SET share_token = NULL, updated_at = now() WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// Day-by-day uptime for the heatmap. Returns one row per day that has at
// least one check (days with none are gaps the frontend fills in itself),
// so a monitor added last week doesn't need 90 empty rows from before it
// existed.
router.get("/:id/daily-uptime", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const days = Math.min(Number(req.query.days) || 90, 180);
  const { rows } = await pool.query(
    `SELECT
       to_char(date_trunc('day', checked_at), 'YYYY-MM-DD') AS date,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'up') / NULLIF(COUNT(*), 0), 1) AS uptime_pct,
       COUNT(*) AS total_checks
     FROM checks
     WHERE monitor_id = $1 AND checked_at >= now() - ($2 || ' days')::interval
     GROUP BY date_trunc('day', checked_at)
     ORDER BY date_trunc('day', checked_at) ASC`,
    [req.params.id, days]
  );
  res.json(rows);
});

export default router;
