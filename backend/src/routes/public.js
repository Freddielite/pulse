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
    `SELECT id, name, url, monitor_type, check_interval_min, current_status, last_checked_at, last_response_ms, created_at, organization_id
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
  const branding = await resolveBranding(monitor.organization_id);
  const { organization_id: _organizationId, ...publicMonitor } = monitor;
  res.json({ ...publicMonitor, branding });
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

// Combined status pages: one link, several monitors. group_name pages
// resolve live off the current group membership; monitor_ids pages are
// a fixed manual list captured at creation time. Either way, the result
// is the same narrow per-monitor shape the single-monitor share view
// uses - no auth header, no synthetic steps, no owner - plus a rolled-up
// uptime % per monitor for 24h/7d/30d, computed here rather than making
// the frontend fan out to N separate uptime calls.
async function findStatusPageByToken(token) {
  const { rows } = await pool.query(`SELECT * FROM status_pages WHERE share_token = $1`, [token]);
  return rows[0] || null;
}

async function resolveStatusPageMonitors(page) {
  // Broadened the same way monitor ownership is everywhere else: the
  // page's own user_id is the anchor, but a monitor counts if it's
  // personally owned by that user OR owned by any org they belong to -
  // matching how validateSelection allowed it onto the page in the
  // first place. Re-checked here (not just at creation) so a monitor
  // that got removed from an org, or a page owner who left that org,
  // stops appearing without anyone having to edit the page.
  if (page.group_name) {
    const { rows } = await pool.query(
      `SELECT id, name, url, monitor_type, current_status, last_checked_at, last_response_ms
       FROM monitors
       WHERE group_name = $2 AND active = true
         AND (user_id = $1 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $1))
       ORDER BY name ASC`,
      [page.user_id, page.group_name]
    );
    return rows;
  }
  const ids = page.monitor_ids || [];
  if (ids.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, name, url, monitor_type, current_status, last_checked_at, last_response_ms
     FROM monitors
     WHERE id = ANY($1::uuid[]) AND active = true
       AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))
     ORDER BY name ASC`,
    [ids, page.user_id]
  );
  return rows;
}

// Branding for a status page or single-monitor share, when whatever it
// belongs to has an organization attached - only the fields a public,
// unauthenticated visitor should see (name/logo/color), never the
// custom_domain setup detail or anything else about the org itself.
async function resolveBranding(organizationId) {
  if (!organizationId) return null;
  const { rows } = await pool.query(
    `SELECT brand_name, brand_logo_url, brand_accent_color FROM organizations WHERE id = $1`,
    [organizationId]
  );
  return rows[0] || null;
}

router.get("/status-pages/:token", async (req, res) => {
  const page = await findStatusPageByToken(req.params.token);
  if (!page) return res.status(404).json(NOT_FOUND);
  const [monitors, branding] = await Promise.all([resolveStatusPageMonitors(page), resolveBranding(page.organization_id)]);
  if (monitors.length === 0) return res.json({ name: page.name, monitors: [], branding });

  const ids = monitors.map((m) => m.id);
  const { rows: uptimeRows } = await pool.query(
    `SELECT
       monitor_id,
       window_days,
       ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'up') / NULLIF(COUNT(*), 0), 2) AS uptime_pct
     FROM checks, (VALUES (1), (7), (30)) AS windows(window_days)
     WHERE monitor_id = ANY($1::uuid[]) AND checked_at >= now() - (window_days || ' days')::interval
     GROUP BY monitor_id, window_days`,
    [ids]
  );
  const byMonitor = {};
  for (const row of uptimeRows) {
    byMonitor[row.monitor_id] = byMonitor[row.monitor_id] || {};
    const key = row.window_days === 1 ? "24h" : row.window_days === 7 ? "7d" : "30d";
    byMonitor[row.monitor_id][key] = row.uptime_pct;
  }

  res.json({
    name: page.name,
    branding,
    monitors: monitors.map((m) => ({
      ...m,
      uptime: {
        "24h": byMonitor[m.id]?.["24h"] ?? null,
        "7d": byMonitor[m.id]?.["7d"] ?? null,
        "30d": byMonitor[m.id]?.["30d"] ?? null,
      },
    })),
  });
});

// Embeddable trust badge - shields.io-style SVG, no JS needed on the
// embedding page, so it renders anywhere an <img> tag works (a client's
// own site, a README, a status-page link in an email signature). Pulled
// from the same share-token-scoped data as the rest of this router, so
// it can never expose more than an unauthenticated visitor could already
// see on the public monitor page. Grade first, since that's the thing
// worth bragging about; uptime as a secondary line.
function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}

function badgeSvg({ label, grade, uptimePct, color }) {
  const gradeText = grade || "-";
  const uptimeText = uptimePct == null ? "no data" : `${uptimePct}% uptime`;
  const width = 168;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="42" viewBox="0 0 ${width} 42" role="img" aria-label="${escapeXml(label)}: grade ${escapeXml(gradeText)}, ${escapeXml(uptimeText)}">
  <rect width="${width}" height="42" rx="6" fill="#12181f"/>
  <rect x="1" y="1" width="${width - 2}" height="40" rx="5" fill="none" stroke="#2a323c" stroke-width="1"/>
  <text x="12" y="17" font-family="Helvetica,Arial,sans-serif" font-size="10" fill="#8b96a3">${escapeXml(label)}</text>
  <text x="12" y="33" font-family="Helvetica,Arial,sans-serif" font-size="12" font-weight="bold" fill="${color}">Grade ${escapeXml(gradeText)}</text>
  <text x="${width - 12}" y="33" font-family="Helvetica,Arial,sans-serif" font-size="10" fill="#8b96a3" text-anchor="end">${escapeXml(uptimeText)}</text>
</svg>`;
}

const GRADE_COLOR = { A: "#3ddc84", B: "#8bd450", C: "#e6c74b", D: "#e08a3c", F: "#e5484d" };

router.get("/monitors/:token/badge.svg", async (req, res) => {
  const monitor = await findByToken(req.params.token);
  res.set("Content-Type", "image/svg+xml");
  res.set("Cache-Control", "public, max-age=300"); // matches the scanner's own 300s-ish cadence closely enough that a stale badge isn't a real concern
  if (!monitor) return res.status(404).send(badgeSvg({ label: "Pulse", grade: "?", uptimePct: null, color: "#8b96a3" }));

  const [{ rows: scanRows }, { rows: uptimeRows }] = await Promise.all([
    pool.query(`SELECT grade FROM security_scans WHERE monitor_id = $1 ORDER BY scanned_at DESC LIMIT 1`, [monitor.id]),
    pool.query(
      `SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'up') / NULLIF(COUNT(*), 0), 1) AS pct
       FROM checks WHERE monitor_id = $1 AND checked_at >= now() - interval '30 days'`,
      [monitor.id]
    ),
  ]);
  const grade = scanRows[0]?.grade || null;
  res.send(
    badgeSvg({
      label: monitor.name,
      grade,
      uptimePct: uptimeRows[0]?.pct ?? null,
      color: GRADE_COLOR[grade?.[0]] || "#8b96a3",
    })
  );
});

export default router;
