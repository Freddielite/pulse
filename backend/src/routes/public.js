import { Router } from "express";
import { pool } from "../db.js";

// No requireAuth here on purpose - this whole router exists to be
// reachable without a session, gated only by whoever holds the
// unguessable share_token in the URL. Every query below is scoped by
// that token, never by monitor id alone, so there's no way to walk from
// one shared monitor to another or to anything not explicitly shared.
const router = Router();

async function findByToken(token) {
  const { rows } = await pool.query(
    `SELECT id, name, url, monitor_type, check_interval_min, current_status, last_checked_at, last_response_ms, created_at
     FROM monitors WHERE share_token = $1`,
    [token]
  );
  return rows[0] || null;
}

const NOT_FOUND = { error: "This share link is invalid or has been revoked." };

// Deliberately a narrow field list, not SELECT * - a shared monitor
// should never leak auth_header_value, synthetic_steps, body_contains,
// or which user owns it, only what a client looking at their own
// status page needs to see.
router.get("/monitors/:token", async (req, res) => {
  const monitor = await findByToken(req.params.token);
  if (!monitor) return res.status(404).json(NOT_FOUND);
  res.json(monitor);
});

// Recent checks for the response-time trend line. Same narrowing as the
// monitor read above: checked_at/status/response_ms only - never
// error_message, which can carry upstream URLs or internal detail the
// owner sees for their own monitor but a link recipient shouldn't.
router.get("/monitors/:token/checks", async (req, res) => {
  const monitor = await findByToken(req.params.token);
  if (!monitor) return res.status(404).json(NOT_FOUND);
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const { rows } = await pool.query(
    `SELECT checked_at, status, response_ms FROM checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT $2`,
    [monitor.id, limit]
  );
  res.json(rows.reverse());
});

router.get("/monitors/:token/uptime", async (req, res) => {
  const monitor = await findByToken(req.params.token);
  if (!monitor) return res.status(404).json(NOT_FOUND);
  const { rows } = await pool.query(
    `SELECT
       window_days,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'up') / NULLIF(COUNT(*), 0), 2) AS uptime_pct,
       COUNT(*) AS total_checks
     FROM checks, (VALUES (1), (7), (30)) AS windows(window_days)
     WHERE monitor_id = $1 AND checked_at >= now() - (window_days || ' days')::interval
     GROUP BY window_days`,
    [monitor.id]
  );
  const byWindow = Object.fromEntries(rows.map((r) => [r.window_days, r]));
  res.json({
    "24h": byWindow[1] || { uptime_pct: null, total_checks: 0 },
    "7d": byWindow[7] || { uptime_pct: null, total_checks: 0 },
    "30d": byWindow[30] || { uptime_pct: null, total_checks: 0 },
  });
});

router.get("/monitors/:token/daily-uptime", async (req, res) => {
  const monitor = await findByToken(req.params.token);
  if (!monitor) return res.status(404).json(NOT_FOUND);
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
    [monitor.id, days]
  );
  res.json(rows);
});

// Score and timestamp only - never the findings array. The findings are
// specifics like exposed paths or missing headers, exactly the kind of
// detail that's useful for the owner to see about their own site and
// not something worth handing to whoever holds this link.
router.get("/monitors/:token/security", async (req, res) => {
  const monitor = await findByToken(req.params.token);
  if (!monitor) return res.status(404).json(NOT_FOUND);
  const { rows } = await pool.query(
    `SELECT score, scanned_at FROM security_scans WHERE monitor_id = $1 ORDER BY scanned_at DESC LIMIT 1`,
    [monitor.id]
  );
  res.json(rows[0] || null);
});

export default router;
