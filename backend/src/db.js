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
      -- Recipient for Telegram alerts, from the app's single bot
      -- (TELEGRAM_BOT_TOKEN env var) to this user's chat with it. NULL
      -- means Telegram alerts are off for this user, same as a blank
      -- alert_email effectively turns off email alerts.
      telegram_chat_id TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
    -- Weekly digest email/push/Telegram summary (uptime %, incidents,
    -- upcoming cert/domain expiry) - opt-in, off by default like every
    -- other alert channel here. digest_sent_at is the cadence clock:
    -- NULL means never sent, so it's immediately due once turned on
    -- (same "due" pattern as cert_checked_at/security_scanned_at on
    -- monitors), and runDigestSweep() only ever looks at whether 7 days
    -- have passed since this, never a day-of-week schedule - so turning
    -- it on any day of the week settles into "once every 7 days from
    -- when you turned it on" rather than everyone converging on the
    -- same Monday.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_sent_at TIMESTAMPTZ;

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
      current_status       TEXT NOT NULL DEFAULT 'unknown', -- unknown | up | degraded | down
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
      -- How many consecutive failed checks it takes before this monitor
      -- actually goes "down" (opens an incident, fires an alert). Default
      -- of 1 preserves the original behavior - alert on the first failure
      -- (runHttpCheck's own single retry already absorbs the shortest
      -- blips; this is for flaky connections that need more runway than
      -- that before it's worth waking someone up).
      alert_after_failures INTEGER NOT NULL DEFAULT 1,
      -- Running count of consecutive failed checks, reset to 0 on any
      -- "up". Compared against alert_after_failures to decide whether a
      -- given failure actually crosses into "down". Deliberately stored
      -- rather than derived from the checks table each tick - counting
      -- backwards through check history on every single check would be
      -- far more work for the same answer.
      consecutive_failures  INTEGER NOT NULL DEFAULT 0,
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
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS alert_after_failures INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
    -- 'http' (default): the original single-request check via httpCheck.js.
    -- 'synthetic': a short ordered sequence of HTTP requests (login, then
    -- hit a gated page, etc.) via syntheticCheck.js - see synthetic_steps.
    -- monitors.url stays required either way: for a synthetic monitor it's
    -- just the "representative" URL used for SSL/domain checks and shown
    -- in the list, not itself one of the steps.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS monitor_type TEXT NOT NULL DEFAULT 'http';
    -- Array of { method, url, body, expected_status, body_contains, extract }
    -- steps, only read when monitor_type = 'synthetic'. extract is an
    -- optional { name, regex } that captures group 1 (or the whole match)
    -- of the step's response body into a named variable, which later
    -- steps can reference in their url/body as {{name}} - the mechanism a
    -- login flow needs to carry a CSRF token or session id forward.
    -- Deliberately JSONB rather than a child table: steps are only ever
    -- read/written as a whole ordered unit with the monitor that owns
    -- them, never queried or joined on individually.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS synthetic_steps JSONB;
    -- Content-diff monitoring, http-type monitors only. content_hash is
    -- a sha256 of the last-seen response body; a mismatch on a later
    -- "up" check fires an alert and the new hash becomes the baseline,
    -- so it self-quiets after one nudge per actual change rather than
    -- alerting every check until someone manually re-baselines it.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS content_diff_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS content_hash TEXT;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS content_changed_at TIMESTAMPTZ;
    -- Which hashing scheme content_hash was computed with. v1 = raw
    -- response body (the original scheme - noisy on real frontends,
    -- since a build-hashed asset filename or a CSRF token changes the
    -- whole-body hash same as an actual content edit). v2 = normalized
    -- visible text, see extractVisibleText() in httpCheck.js. A monitor
    -- sitting on v1 gets silently re-baselined onto v2 on its next check
    -- (see checkRunner.js) rather than firing a false "changed" alert
    -- for what's really just a hashing-scheme change, not a page change.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS content_hash_version INTEGER NOT NULL DEFAULT 1;
    -- Read-only share links, one per monitor. NULL means sharing is off.
    -- A non-NULL value is an unguessable lookup key (18 random bytes),
    -- not a hashed secret like api_tokens.token_hash - anyone holding the
    -- URL is *meant* to be able to view the scoped read-only data behind
    -- it, so there's nothing gained by hashing it at rest. UNIQUE allows
    -- any number of monitors to share the NULL "not shared" state while
    -- still guaranteeing two live links never collide.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE;
    -- Per-request timeout for this monitor's checks, in seconds. Used by
    -- both httpCheck.js (once, for the single request) and
    -- syntheticCheck.js (per step - a 5-step synthetic check can still
    -- take up to 5x this in the worst case, same as it always could).
    -- Previously a hardcoded 15s for every monitor regardless of what it
    -- watched; a legitimately slow endpoint (a cold-start API, a heavy
    -- report page) had no way to avoid being recorded as "down" just for
    -- being slow. Bounded 3-60s at the API layer, not just in the form -
    -- see the checks in routes/monitors.js.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS check_timeout_sec INTEGER NOT NULL DEFAULT 15;
    -- Degraded state: a monitor can be "up but slow" without going down.
    -- degraded_threshold_ms is NULL by default (feature off) - a passing
    -- check slower than this counts toward the slow streak below. Same
    -- 1500ms line lib/latency.js already colors amber, reused as the
    -- suggested default rather than inventing a second cutoff, but it's
    -- editable per monitor since "slow" means something different for a
    -- cold-start API than a static health check.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS degraded_threshold_ms INTEGER;
    -- Consecutive slow (but passing) checks before current_status actually
    -- flips to 'degraded' and fires one alert - identical shape to
    -- alert_after_failures/consecutive_failures, just for the slow case
    -- instead of the down case, so a single slow blip doesn't page anyone.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS alert_after_slow INTEGER NOT NULL DEFAULT 3;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS consecutive_slow INTEGER NOT NULL DEFAULT 0;

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

    -- Combined status pages: one link showing several monitors together,
    -- distinct from monitors.share_token (one link per monitor). Exactly
    -- one of group_name / monitor_ids is set per row - group_name means
    -- "live" membership (adding a monitor to that group later shows up
    -- automatically, no edit needed), monitor_ids is a fixed manual list
    -- for a page that doesn't correspond to an existing group. Enforced
    -- at the API layer (routes/statusPages.js), not a CHECK constraint,
    -- since "exactly one of two nullable columns" is awkward to express
    -- well in SQL and the API layer already owns every other cross-field
    -- validation in this app (see validateSteps for synthetic monitors).
    CREATE TABLE IF NOT EXISTS status_pages (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      share_token   TEXT UNIQUE NOT NULL,
      group_name    TEXT,
      monitor_ids   JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_status_pages_user_id ON status_pages(user_id);

    -- Bearer tokens for scripting against Pulse directly (cron jobs, other
    -- tools) instead of only through the browser session. Only the hash is
    -- stored - the raw token is generated once, returned once in the POST
    -- response, and is unrecoverable after that, same shape as a password.
    -- token_prefix keeps enough of the raw value (never secret on its own -
    -- it's a small fraction of a long random token) visible in the UI so a
    -- user can tell their tokens apart without the full value ever being
    -- stored or shown again.
    CREATE TABLE IF NOT EXISTS api_tokens (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      token_hash    TEXT NOT NULL UNIQUE,
      token_prefix  TEXT NOT NULL,
      last_used_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);
  `);
}
