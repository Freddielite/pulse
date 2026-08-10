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
       AND (last_checked_at IS NULL OR last_checked_at <= now() - (check_interval_min || ' minutes')::interval)`
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
