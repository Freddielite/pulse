import pg from "pg";

const { Pool } = pg;

// Render's managed Postgres requires SSL, but a plain local Postgres during
// dev doesn't speak SSL at all and will hang if you ask for it. Detect
// local-vs-hosted from the connection string itself so one config works
// for both without an extra env var to keep in sync.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "");

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

export async function migrate() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      alert_email   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- express-session's connect-pg-simple store creates/manages this table
    -- itself on boot (see index.js), so it isn't defined here.

    CREATE TABLE IF NOT EXISTS monitors (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name                 TEXT NOT NULL,
      url                  TEXT NOT NULL,
      method               TEXT NOT NULL DEFAULT 'GET',
      expected_status      INTEGER NOT NULL DEFAULT 200,
      auth_header_name     TEXT,
      auth_header_value    TEXT,
      check_interval_min   INTEGER NOT NULL DEFAULT 5,
      active               BOOLEAN NOT NULL DEFAULT true,
      -- keep_alive_target marks a monitor whose purpose is specifically to
      -- stop a Render free-tier service from spinning down (vs. a plain
      -- uptime check on something already always-on). Cosmetic/informational
      -- only right now, but keeps the two use cases distinguishable in the UI.
      keep_alive_target    BOOLEAN NOT NULL DEFAULT false,
      current_status       TEXT NOT NULL DEFAULT 'unknown', -- unknown | up | down
      last_checked_at      TIMESTAMPTZ,
      last_status_code     INTEGER,
      last_response_ms     INTEGER,
      ssl_expires_at       TIMESTAMPTZ,
      domain_expires_at    TIMESTAMPTZ,
      cert_checked_at      TIMESTAMPTZ,
      cert_check_error     TEXT,
      -- Rate limits the security scan the same way cert_checked_at rate
      -- limits the SSL/domain lookup: a header/exposed-path scan is
      -- several requests per monitor, so re-running it every tick would
      -- waste far more than the finding could ever change day to day.
      security_scanned_at  TIMESTAMPTZ,
      -- NULL means never snoozed / not currently snoozed. A future
      -- timestamp pauses both the scheduled tick and the "Check now"
      -- button for this monitor until it passes, at which point checks
      -- resume automatically with no action needed.
      snoozed_until        TIMESTAMPTZ,
      -- Free-text label for grouping the dashboard list (e.g. "Wyntek
      -- clients", "Personal"). Deliberately just a string, not a separate
      -- tags table: a personal monitoring dashboard doesn't need
      -- many-to-many tagging, and a plain label is far less to build,
      -- query, and get wrong.
      group_name           TEXT,
      -- Optional substring the response body must contain to count as
      -- "up". NULL means skip this check entirely (status code alone
      -- decides). Exists because a 200 with an empty or broken body is a
      -- real failure mode a status-code-only check can't see.
      body_contains        TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_monitors_user_id ON monitors(user_id);

    -- Covers upgrading an existing database where the monitors table was
    -- already created before these columns existed (CREATE TABLE IF NOT
    -- EXISTS above is a no-op once the table exists, so it can't add them).
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS group_name TEXT;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS body_contains TEXT;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS security_scanned_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS checks (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      monitor_id     UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      checked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      status         TEXT NOT NULL, -- up | down
      status_code    INTEGER,
      response_ms    INTEGER,
      error_message  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_checks_monitor_id_checked_at ON checks(monitor_id, checked_at DESC);

    CREATE TABLE IF NOT EXISTS incidents (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      monitor_id    UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at   TIMESTAMPTZ,
      error_message TEXT,
      notified      BOOLEAN NOT NULL DEFAULT false,
      -- When the most recent "still down" (or initial "down") alert went
      -- out, so repeat alerts can be paced (e.g. hourly) instead of firing
      -- on every single tick a monitor happens to still be down for.
      last_notified_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_incidents_monitor_id ON incidents(monitor_id);
    -- Partial index: every query that matters for this table is "does this
    -- monitor have an open incident right now", which only ever touches the
    -- handful of unresolved rows, not the full history.
    CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(monitor_id) WHERE resolved_at IS NULL;

    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint      TEXT NOT NULL UNIQUE,
      p256dh        TEXT NOT NULL,
      auth          TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Passive header/exposed-path scan results per monitor. Private by
    -- construction: every read of this table goes through a route scoped to
    -- monitors.user_id (see routes/monitors.js), there's no public endpoint
    -- for it the way wyntek-status briefly exposed a score publicly.
    CREATE TABLE IF NOT EXISTS security_scans (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      monitor_id  UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      scanned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      score       INTEGER NOT NULL, -- 0-100
      findings    JSONB NOT NULL    -- array of {check, pass, detail}
    );

    CREATE INDEX IF NOT EXISTS idx_security_scans_monitor_time ON security_scans(monitor_id, scanned_at DESC);
  `);
}
