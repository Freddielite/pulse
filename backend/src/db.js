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
    -- monitors). digest_day_of_week (0=Sunday..6=Saturday, matching JS's
    -- own Date.getDay() so the frontend needs no lookup table) is the
    -- schedule: runDigestSweep() in lib/digest.js only sends on a match
    -- against the current UTC day, with digest_sent_at as a "already went
    -- out this week" guard rather than the whole cadence clock it used to
    -- be. Defaults to Sunday, changeable any time in Settings.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_sent_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_day_of_week SMALLINT NOT NULL DEFAULT 0;

    -- Per-channel, per-event-kind opt-outs for push and Telegram (email
    -- stays all-or-nothing via alert_email, unchanged; the weekly digest
    -- has its own single on/off - digest_enabled above - rather than a
    -- key here, so there's exactly one switch for it instead of two
    -- disagreeing ones). Shape:
    -- { push: { down, degraded, contentChanged, expiring, security },
    --   telegram: { ...same keys } }. Missing keys default to true - see
    -- lib/notificationPrefs.js, which is the only place that reads this
    -- column, so the default shape only has to be right in one place.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{
      "push": {"down": true, "degraded": true, "contentChanged": true, "expiring": true, "security": true},
      "telegram": {"down": true, "degraded": true, "contentChanged": true, "expiring": true, "security": true}
    }'::jsonb;

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

    -- ===================================================================
    -- Security posture
    -- ===================================================================

    -- Auth-negative assertion: send this monitor's request *without* its
    -- credential and require the server to refuse. Opt-in per monitor
    -- (off by default) because it doubles the request count for a
    -- monitor that has it on, and because "this endpoint should reject
    -- anonymous callers" is only true of some of them. auth_probe_expect
    -- is a comma-separated list of statuses that count as a refusal;
    -- 401,403 covers almost everything, but an API that answers 404 to
    -- hide the existence of a resource is a legitimate design too.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS auth_probe_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS auth_probe_expect TEXT NOT NULL DEFAULT '401,403';
    -- pass | fail | inconclusive | NULL (never run). Stored rather than
    -- derived so the alert can fire on the transition only - same
    -- self-quieting shape as content_hash, not a nag on every check.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS auth_probe_status TEXT;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS auth_probe_checked_at TIMESTAMPTZ;

    -- Full TLS posture from the same handshake the expiry check already
    -- performs (see lib/certCheck.js getTlsPosture). tls_fingerprint is
    -- the SHA-256 of the leaf certificate: an unexpected change to it is
    -- the signal for a hijacked DNS record, a compromised CDN account,
    -- or a certificate reissued by someone who shouldn't have been able
    -- to. Same baseline-then-compare shape as content_hash - the first
    -- value seen is never an alert.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS tls_fingerprint TEXT;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS tls_posture JSONB;

    -- Latest DNS record snapshot, compared against the previous one each
    -- sweep to detect drift (see lib/dnsCheck.js). Kept on the monitor
    -- row for the fast "what does it look like right now" read; the
    -- dns_snapshots table below keeps the history.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS dns_snapshot JSONB;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS dns_checked_at TIMESTAMPTZ;

    -- Certificate Transparency log monitoring. Defaults on for https
    -- monitors because the signal-to-noise is unusually good, but it's a
    -- per-monitor switch since it's the one feature here that queries a
    -- third-party service (crt.sh) rather than the user's own site.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS ct_enabled BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS ct_checked_at TIMESTAMPTZ;

    -- Third-party origins seen in the page's script/iframe/stylesheet
    -- tags on the last scan. A new origin appearing here between scans is
    -- the supply-chain signal - it's what a Magecart-style injection
    -- looks like from the outside.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS third_party_origins JSONB;

    -- Scans gained a grade, a severity breakdown, and scan metadata.
    -- Older rows keep their score and findings and simply have NULLs
    -- here; the API treats a missing grade as "computed before grading
    -- existed" rather than backfilling, since the old findings have no
    -- severity to compute one from.
    ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS grade TEXT;
    ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS summary JSONB;
    ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS meta JSONB;

    -- One timeline of everything security-relevant that has happened to a
    -- monitor: a check that regressed from pass to fail, a certificate
    -- fingerprint that changed, a DNS record that moved, a new
    -- certificate in the CT logs, an endpoint that stopped requiring
    -- auth.
    --
    -- This table is what turns a scanner into a monitor. A scan result on
    -- its own answers "how is it configured right now"; the interesting
    -- question for anyone actually running a service is "what changed,
    -- and when" - which is the same question the checks and incidents
    -- tables already answer for uptime. Keeping it as one events table
    -- rather than one per feature means the UI has a single thing to
    -- render and every new detector gets the timeline for free.
    CREATE TABLE IF NOT EXISTS security_events (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      monitor_id   UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- scan_regression | scan_improvement | tls_fingerprint_changed |
      -- dns_drift | ct_new_certificate | auth_probe_failed |
      -- auth_probe_recovered | third_party_origin_added
      kind         TEXT NOT NULL,
      severity     TEXT NOT NULL, -- critical | high | medium | low | info
      title        TEXT NOT NULL,
      detail       TEXT,
      -- Whatever the detector wants to keep for the UI: the before/after
      -- values of a DNS record, the issuer of a new certificate. Free
      -- shape on purpose - each detector's payload is only ever read by
      -- the code that wrote it plus a generic renderer.
      data         JSONB,
      acknowledged BOOLEAN NOT NULL DEFAULT false
    );

    CREATE INDEX IF NOT EXISTS idx_security_events_monitor_time ON security_events(monitor_id, created_at DESC);
    -- Partial index for the dashboard's "anything unacknowledged?" badge,
    -- which only ever touches the handful of open rows.
    CREATE INDEX IF NOT EXISTS idx_security_events_open ON security_events(monitor_id) WHERE acknowledged = false;

    -- Certificates seen in the public CT logs for a monitor's domain.
    -- Existence in this table is what makes a certificate "known", so a
    -- row appearing is what a new-issuance alert keys off. UNIQUE on
    -- (monitor_id, cert_id) lets the sweep insert blindly with ON
    -- CONFLICT DO NOTHING instead of reading the whole set first.
    CREATE TABLE IF NOT EXISTS ct_certificates (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      monitor_id    UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      cert_id       TEXT NOT NULL,
      common_name   TEXT,
      names         JSONB,
      issuer        TEXT,
      not_before    TIMESTAMPTZ,
      not_after     TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (monitor_id, cert_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ct_certificates_monitor ON ct_certificates(monitor_id, not_before DESC);

    -- DNS snapshot history. The monitor row holds the current snapshot
    -- for fast reads; this keeps the trail so "when did the A record
    -- change" is answerable after the fact, which is exactly the question
    -- asked during an incident review.
    CREATE TABLE IF NOT EXISTS dns_snapshots (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      monitor_id  UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      taken_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      records     JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dns_snapshots_monitor_time ON dns_snapshots(monitor_id, taken_at DESC);

    -- Rate limiting for authentication endpoints, keyed by IP and by
    -- email. Persisted rather than in-process memory because Render can
    -- and does restart a free-tier service at will, and an in-memory
    -- counter that resets on restart is a lockout an attacker can simply
    -- wait out. Old rows are swept opportunistically (see
    -- middleware/rateLimit.js) rather than needing their own scheduled
    -- job, in keeping with this app having no background runner.
    CREATE TABLE IF NOT EXISTS auth_attempts (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket      TEXT NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_auth_attempts_bucket_time ON auth_attempts(bucket, attempted_at DESC);

    -- ===================================================================
    -- Tier 1 additions: webhooks, 2FA, blacklist, breach monitoring
    -- ===================================================================

    -- Generic webhook alerts (Slack/Discord/PagerDuty/custom URL), same
    -- on/off-per-event-kind shape as push/Telegram - see
    -- notification_prefs above and lib/notificationPrefs.js, which now
    -- also owns a "webhook" channel (its defaults live in code, not a
    -- column default, so no migration was needed to add the channel
    -- itself). NULL means no webhook configured, same as a NULL
    -- telegram_chat_id means Telegram is off.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS webhook_url TEXT;

    -- TOTP two-factor auth. totp_secret is the active, verified secret;
    -- totp_pending_secret holds a freshly generated one between "start
    -- setup" and "confirm with a code from your app" so a user who
    -- abandons setup halfway never ends up with 2FA silently required
    -- with no way to produce a valid code. totp_backup_codes are
    -- bcrypt-hashed one-time recovery codes, same treatment as
    -- password_hash - shown once at generation and unrecoverable after.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending_secret TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes JSONB;

    -- Breach exposure monitoring (HaveIBeenPwned), opt-in and off by
    -- default like every other alert-adjacent feature here - it queries
    -- a third party with the user's own email address, so defaulting it
    -- on would be the wrong call even though the check itself is
    -- passive. Same weekly-cadence-clock shape as digest_sent_at: NULL
    -- means never checked, so it's immediately due once turned on.
    -- breach_last_result is { breaches: [name, ...] } from the most
    -- recent check - kept so the sweep can tell "a new breach appeared"
    -- apart from "still the same ones as last week".
    ALTER TABLE users ADD COLUMN IF NOT EXISTS breach_monitoring_enabled BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS breach_checked_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS breach_last_result JSONB;

    -- Blacklist/malware reputation (Google Safe Browsing). Runs on the
    -- same sweep as the header/exposed-path scan (see
    -- security_scanned_at) rather than its own schedule - one more cheap
    -- request tacked onto a sweep that already happens daily per
    -- monitor. NULL means never checked (key not configured, or not
    -- reached yet); 'unknown' means checked but the API call itself
    -- failed - both are distinct from 'clean', same reasoning as
    -- auth_probe_status treating "never run" and "ran but inconclusive"
    -- as different states.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS blacklist_status TEXT;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS blacklist_threats JSONB;
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS blacklist_checked_at TIMESTAMPTZ;

    -- ===================================================================
    -- Tier 2 additions: teams/orgs, white-label branding, trend history
    -- ===================================================================

    -- An organization is a shared owner for monitors and status pages -
    -- an agency's account, effectively. Every account keeps working
    -- exactly as before without ever creating one: monitors.organization_id
    -- (below) is nullable, and a personal monitor with it NULL behaves
    -- identically to how every monitor worked before this migration.
    -- Branding fields live here rather than on individual monitors/status
    -- pages, since the whole point is one look applied across everything
    -- the org owns.
    CREATE TABLE IF NOT EXISTS organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      brand_name TEXT,
      brand_logo_url TEXT,
      brand_accent_color TEXT,
      -- Stored for display on branded reports/status pages, and as a
      -- reminder of the setup this app doesn't automate: pointing an
      -- actual domain at Pulse still needs the org's own DNS (a CNAME)
      -- and Pulse-side host routing/TLS - neither of which this column
      -- does by itself. See the note in HANDOVER.md.
      custom_domain TEXT,
      owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Membership is separate from ownership: owner_user_id above is who
    -- can delete the org outright, while this table is who can see/use
    -- it and at what role. A row with user_id NULL and invited_email set
    -- is a pending invite - claimed (user_id filled in, invited_email
    -- cleared) the moment someone signs up or already has an account
    -- with that email, so an invite sent before someone has ever used
    -- Pulse still works.
    CREATE TABLE IF NOT EXISTS organization_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      invited_email TEXT,
      role TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT member_identity_present CHECK (user_id IS NOT NULL OR invited_email IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_user ON organization_members(organization_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_invite ON organization_members(organization_id, invited_email) WHERE invited_email IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

    -- "Who changed what" for an org - membership and monitor-ownership
    -- changes only (not every field edit on every monitor, which would
    -- just be the existing security_events/checks tables' job under a
    -- different name). detail is a short human sentence, not a
    -- structured diff - this is for a member asking "wait, who added
    -- this?", not a compliance export.
    CREATE TABLE IF NOT EXISTS org_audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_org_audit_log_org_time ON org_audit_log(organization_id, created_at DESC);

    -- Nullable, additive - see the organizations comment above for why
    -- this is safe for every monitor/status page that predates it.
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
    ALTER TABLE status_pages ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_monitors_organization ON monitors(organization_id);

    -- Passive CSP violation collection: point a monitored site's
    -- report-uri/report-to at this app's public, token-gated endpoint
    -- (see routes/public.js) and browsers report real, actually-hit
    -- violations instead of Pulse only being able to infer risk from the
    -- policy's text (see scanner.js's header grading). Stored one row
    -- per distinct violation *shape* (same directive, same blocked URI,
    -- same source file) with a running count and last-seen time, not one
    -- row per report - a single misconfigured directive can otherwise
    -- generate one report per pageview from every visitor, which would
    -- turn this into an unbounded log rather than a useful list of
    -- distinct problems to fix.
    CREATE TABLE IF NOT EXISTS csp_violations (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      monitor_id          UUID NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      document_uri        TEXT,
      violated_directive  TEXT,
      blocked_uri         TEXT,
      source_file         TEXT,
      line_number         INTEGER,
      disposition         TEXT,
      count               INTEGER NOT NULL DEFAULT 1,
      first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (monitor_id, violated_directive, blocked_uri, source_file)
    );
    CREATE INDEX IF NOT EXISTS idx_csp_violations_monitor ON csp_violations(monitor_id, last_seen_at DESC);
  `);
}
