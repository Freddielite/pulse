import { Router } from "express";
import { pool } from "../db.js";
import { runUptimeChecks, runCertSweep, runSecuritySweep } from "../lib/checkRunner.js";

const router = Router();

function requireCronSecret(req, res, next) {
  const provided = req.query.secret || req.headers["x-cron-secret"];
  if (process.env.CRON_SECRET && provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "invalid cron secret" });
  }
  next();
}

router.all("/tick", requireCronSecret, async (req, res) => {
  const { rows: due } = await pool.query(
    `SELECT * FROM monitors
     WHERE active = true
       AND (snoozed_until IS NULL OR snoozed_until <= now())
       -- The extra 45s grace here is deliberate: without it, a monitor
       -- whose last check landed even a few seconds later than expected
       -- (a retry that added ~4s, the external cron firing a bit late)
       -- can end up just past the strict interval boundary on one tick,
       -- get skipped, and only get picked up on the tick after - turning
       -- a 2-minute interval into an apparent 4-minute one. 45s is small
       -- relative to any interval worth setting, but comfortably bigger
       -- than the jitter that actually causes this.
       AND (last_checked_at IS NULL OR last_checked_at <= now() - (check_interval_min || ' minutes')::interval + interval '45 seconds')`
  );

  const uptimeResults = await runUptimeChecks(due);
  // Cert/domain sweep is deliberately unscoped to a user here (sweeps
  // across everyone) since the cron tick is the only place expiry data
  // ever gets refreshed at all. Same reasoning applies to the security
  // sweep right below it.
  const certChecks = await runCertSweep();
  const securityScans = await runSecuritySweep();

  res.json({ ...uptimeResults, certChecks, securityScans });
});

export default router;
