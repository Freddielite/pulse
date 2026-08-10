import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { runUptimeChecks } from "../lib/checkRunner.js";
import { scanSite } from "../lib/scanner.js";

const router = Router();
router.use(requireAuth);

// Shared by both create and update. Only enforced when the monitor is (or
// is being changed to) 'synthetic' - an 'http' monitor's steps are simply
// ignored, so there's nothing to validate for it.
function validateSyntheticSteps(type, steps) {
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
    `SELECT * FROM monitors WHERE user_id = $1 ORDER BY created_at ASC`,
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
    `SELECT * FROM monitors WHERE user_id = $1 AND active = true AND (snoozed_until IS NULL OR snoozed_until <= now())`,
    [req.userId]
  );
  const results = await runUptimeChecks(mine);
  res.json(results);
});

router.post("/", async (req, res) => {
  const {
    name, url, method, expected_status, auth_header_name, auth_header_value, check_interval_min, keep_alive_target,
    group_name, body_contains, alert_after_failures, content_diff_enabled, monitor_type, synthetic_steps,
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
  const type = monitor_type === "synthetic" ? "synthetic" : "http";
  const stepsError = validateSyntheticSteps(type, synthetic_steps);
  if (stepsError) return res.status(400).json({ error: stepsError });
  try {
    const { rows } = await pool.query(
      `INSERT INTO monitors
         (user_id, name, url, method, expected_status, auth_header_name, auth_header_value, check_interval_min, keep_alive_target, group_name, body_contains, alert_after_failures, content_diff_enabled, monitor_type, synthetic_steps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
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
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create monitor" });
  }
});

router.patch("/:id", async (req, res) => {
  const {
    name, url, method, expected_status, auth_header_name, auth_header_value, check_interval_min, keep_alive_target,
    active, group_name, body_contains, alert_after_failures, content_diff_enabled, monitor_type, synthetic_steps,
  } = req.body;
  if (alert_after_failures !== undefined && alert_after_failures !== null && Number(alert_after_failures) < 1) {
    return res.status(400).json({ error: "alert after failures must be at least 1" });
  }
  if (monitor_type !== undefined) {
    const stepsError = validateSyntheticSteps(monitor_type === "synthetic" ? "synthetic" : "http", synthetic_steps);
    if (stepsError) return res.status(400).json({ error: stepsError });
  }
  try {
    const willTouchSteps = monitor_type !== undefined;
    const nextType = monitor_type === undefined ? null : (monitor_type === "synthetic" ? "synthetic" : "http");
    const nextSteps = monitor_type === "synthetic" ? JSON.stringify(synthetic_steps) : null;
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
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
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
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: "monitor not found" });
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
  const minutes = Number(req.body.minutes);
  if (!minutes || minutes <= 0) return res.status(400).json({ error: "minutes must be a positive number" });
  const { rows } = await pool.query(
    `UPDATE monitors SET snoozed_until = now() + ($3 || ' minutes')::interval, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [req.params.id, req.userId, minutes]
  );
  if (rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  res.json(rows[0]);
});

router.post("/:id/unsnooze", async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE monitors SET snoozed_until = NULL, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`,
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  res.json(rows[0]);
});

// Bulk versions of the same action, scoped to every active monitor the
// user owns at once - useful for something like taking your whole setup
// down for a broader maintenance window instead of clicking into each
// monitor individually.
router.post("/snooze-all", async (req, res) => {
  const minutes = Number(req.body.minutes);
  if (!minutes || minutes <= 0) return res.status(400).json({ error: "minutes must be a positive number" });
  const { rows } = await pool.query(
    `UPDATE monitors SET snoozed_until = now() + ($2 || ' minutes')::interval, updated_at = now()
     WHERE user_id = $1 AND active = true RETURNING id`,
    [req.userId, minutes]
  );
  res.json({ snoozed: rows.length });
});

router.post("/unsnooze-all", async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE monitors SET snoozed_until = NULL, updated_at = now()
     WHERE user_id = $1 AND snoozed_until IS NOT NULL RETURNING id`,
    [req.userId]
  );
  res.json({ unsnoozed: rows.length });
});

router.delete("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM monitors WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  res.json({ ok: true });
});

// Recent checks for the uptime chart / response-time trend.
router.get("/:id/checks", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const { rows } = await pool.query(
    `SELECT * FROM checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT $2`,
    [req.params.id, limit]
  );
  res.json(rows.reverse());
});

router.get("/:id/incidents", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
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
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const { rows } = await pool.query(
    `SELECT * FROM security_scans WHERE monitor_id = $1 ORDER BY scanned_at DESC LIMIT 1`,
    [req.params.id]
  );
  if (rows.length === 0) return res.json(null);
  res.json(rows[0]);
});

// Force a scan right now, ignoring the 24h cadence, the same "I don't want
// to wait" escape hatch check-now gives uptime checks.
router.post("/:id/security/run", async (req, res) => {
  const owns = await pool.query(`SELECT * FROM monitors WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "monitor not found" });
  const monitor = owns.rows[0];

  const result = await scanSite(monitor.url);
  const { rows } = await pool.query(
    `INSERT INTO security_scans (monitor_id, score, findings) VALUES ($1, $2, $3) RETURNING *`,
    [monitor.id, result.score, JSON.stringify(result.findings)]
  );
  await pool.query(`UPDATE monitors SET security_scanned_at = now() WHERE id = $1`, [monitor.id]);
  res.json(rows[0]);
});

// Uptime percentage over rolling windows, computed from the checks log
// rather than stored, so it's always consistent with what's actually there.
router.get("/:id/uptime", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
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

// Day-by-day uptime for the heatmap. Returns one row per day that has at
// least one check (days with none are gaps the frontend fills in itself),
// so a monitor added last week doesn't need 90 empty rows from before it
// existed.
router.get("/:id/daily-uptime", async (req, res) => {
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND user_id = $2`, [req.params.id, req.userId]);
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
