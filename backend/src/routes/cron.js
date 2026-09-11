import { Router } from "express";
import { pool } from "../db.js";
import { runUptimeChecks, runCertSweep, runSecuritySweep, runDnsSweep, runCtSweep } from "../lib/checkRunner.js";
import { runDigestSweep } from "../lib/digest.js";

const router = Router();

// Postgres advisory lock key for the tick endpoint. Arbitrary constant -
// its only job is to be a number nothing else in this app uses, so it
// doesn't collide with a different advisory lock somewhere else.
const TICK_LOCK_KEY = 727501;

function requireCronSecret(req, res, next) {
  const provided = req.query.secret || req.headers["x-cron-secret"];
  if (process.env.CRON_SECRET && provided !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "invalid cron secret" });
  }
  next();
}

router.all("/tick", requireCronSecret, async (req, res) => {
  // A tick that's still running when the next one fires - a slow run
  // (enough monitors, or a security/CT sweep that's due for several of
  // them at once) overlapping the external cron service's next call, or
  // that service retrying because the last response was slow - is the
  // actual cause behind most "false" down alerts, not the individual
  // checks themselves. Two overlapping ticks both read the same monitor
  // rows (last_checked_at hasn't been written yet by either), so both see
  // the same stale consecutive_failures/current_status and can each
  // independently decide a monitor just crossed its alert threshold -
  // two incidents opened, two alerts sent, for what was really one
  // failure (or sometimes no real failure at all, just two racing writes
  // to consecutive_failures landing in a way that crosses the threshold
  // together when neither would have alone).
  //
  // A session-scoped advisory lock on a single held connection - rather
  // than an in-memory flag - is what makes this safe across process
  // restarts and multiple backend instances, not just within one. It's
  // released explicitly in `finally`, and Postgres also drops it
  // automatically if this connection ever dies mid-request, so a crashed
  // tick can never leave the lock held forever.
  const client = await pool.connect();
  try {
    const { rows: lockRows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [TICK_LOCK_KEY]);
    if (!lockRows[0].locked) {
      return res.json({ skipped: true, reason: "a previous tick is still running" });
    }

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
    // DNS drift and Certificate Transparency, on their own cadences (see
    // the interval constants in checkRunner.js). Both are per-run capped
    // the same way the cert and security sweeps are, so a backlog can
    // never turn one tick into a long-running job - which matters more
    // here than elsewhere, because the external cron service calling this
    // endpoint has its own request timeout.
    const dnsChecks = await runDnsSweep();
    const ctChecks = await runCtSweep();
    // Same unscoped-across-everyone shape as the sweeps above - weekly
    // cadence means this is a no-op most ticks (nobody's clock is due),
    // so it costs nothing to check on every tick rather than needing its
    // own separate schedule.
    const digestsSent = await runDigestSweep();

    res.json({ ...uptimeResults, certChecks, securityScans, dnsChecks, ctChecks, digestsSent });
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [TICK_LOCK_KEY]).catch(() => {});
    client.release();
  }
});

export default router;
