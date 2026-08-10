import { Router } from "express";
import cors from "cors";
import { pool } from "../db.js";
import { BEACON_SCRIPT, parseUserAgent } from "../lib/beacon.js";

const router = Router();

// This is the one router in the whole app that has to accept requests from
// arbitrary origins: the beacon script runs in a visitor's browser on
// whatever client site it's embedded on (focusdial.app, shefitts.co,
// wherever), which is never the same origin as Pulse's own frontend. The
// app-wide CORS lock in index.js stays scoped to CORS_ORIGIN as-is; this
// override only applies to these two routes, and neither one touches
// cookies/sessions, so opening it up here doesn't weaken auth anywhere else.
router.use(cors({ origin: true }));

router.get("/beacon.js", (req, res) => {
  res.set("content-type", "application/javascript; charset=UTF-8");
  res.set("cache-control", "public, max-age=3600");
  res.send(BEACON_SCRIPT);
});

router.post("/collect", async (req, res) => {
  const { site_id, path, referrer, ua } = req.body || {};
  if (!site_id || !path) return res.status(400).json({ error: "missing fields" });

  // Confirm site_id maps to a real, active monitor, so this endpoint can't
  // be used as an open write sink for arbitrary monitor_id values. This is
  // a public existence check only, it doesn't leak anything about who owns
  // the monitor or what its other data looks like.
  const owns = await pool.query(`SELECT id FROM monitors WHERE id = $1 AND active = true`, [site_id]);
  if (owns.rows.length === 0) return res.status(404).json({ error: "unknown site" });

  const { browser, os } = parseUserAgent(ua || "");
  await pool.query(
    `INSERT INTO pageviews (monitor_id, path, referrer, browser, os) VALUES ($1, $2, $3, $4, $5)`,
    [site_id, String(path).slice(0, 200), referrer || null, browser, os]
  );

  res.status(204).end(); // beacon requests don't need a response body
});

export default router;
