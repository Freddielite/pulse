import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

// Deliberately NOT behind requireAuth — this is the one door into Pulse's
// data meant to be public. It only ever returns monitors the user has
// explicitly opted in via public_status = true, and only safe fields:
// no URLs, no auth headers, no user_id, nothing account-related.
router.get("/status", async (req, res) => {
  const { rows: monitors } = await pool.query(
    `SELECT id, name, current_status, last_checked_at, group_name
     FROM monitors
     WHERE public_status = true AND active = true
     ORDER BY group_name NULLS FIRST, name ASC`
  );

  const withUptime = await Promise.all(
    monitors.map(async (m) => {
      const { rows } = await pool.query(
        `SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'up') / NULLIF(COUNT(*), 0), 2) AS uptime_pct
         FROM checks WHERE monitor_id = $1 AND checked_at >= now() - interval '1 day'`,
        [m.id]
      );
      return {
        name: m.name,
        status: m.current_status,
        uptime_24h: rows[0]?.uptime_pct ?? null,
        last_checked_at: m.last_checked_at,
        group: m.group_name,
      };
    })
  );

  res.json(withUptime);
});

export default router;
