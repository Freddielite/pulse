# Pulse: Handover

Uptime, SSL/domain expiry, and keep-alive monitoring for your own apps and APIs.
Backend: Node/Express + Postgres, deploys to Render.
Frontend: React/Vite, deploys to Vercel.

## The one thing that actually makes this work

Render's free tier spins a web service down after 15 minutes with no
inbound traffic, and spins it back up (slowly) on the next request. That
includes Pulse's own backend.

Everything in this app runs off a single endpoint: `POST /api/cron/tick`.
When it's hit, it checks every monitor that's due, records the result,
opens/closes incidents, sends alerts, and (roughly once a day per monitor)
refreshes SSL/domain expiry. Nothing runs on a timer inside the app itself
- Render's free tier can't run background timers reliably anyway, since
the process is asleep most of the time.

So: **you need an external, free scheduler hitting your own `/api/cron/tick`
every few minutes.** This does two things at once: it performs the checks,
and being an inbound request, it's also what keeps Pulse's own backend
awake. Any monitor you've set `keep_alive_target` on gets checked (and
therefore pinged, and therefore kept awake) on the same cadence.

Recommended: [cron-job.org](https://cron-job.org) (free, no card required).
Point it at:

```
https://your-backend.onrender.com/api/cron/tick?secret=YOUR_CRON_SECRET
```

every 5 minutes. A monitor's own `check_interval_min` still controls how
often *it* actually gets pinged (the tick endpoint skips anything not due
yet), so 5 minutes is just the polling floor. If you're using this to keep a
Render free app awake, keep that monitor's interval at 10 minutes or less;
Render sleeps at 15.

GitHub Actions' scheduled workflows are a fine alternative if you'd rather
not depend on a third-party cron site: a `schedule: cron:` step that
curls the same URL works identically.

## Environment variables

### Backend (Render)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | Render Postgres connection string |
| `SESSION_SECRET` | Yes | Random string, generate your own |
| `CORS_ORIGIN` | Yes | Your Vercel frontend URL, exact match |
| `NODE_ENV` | Yes | `production` |
| `CRON_SECRET` | Recommended | Without it, `/api/cron/tick` is unauthenticated and anyone who finds the URL can trigger it |
| `SIGNUP_CODE` | Recommended | Gate signup so randoms can't create accounts on your instance |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | For push | Generate with `npm run gen-vapid` in `backend/` |
| `VAPID_SUBJECT` | For push | `mailto:you@example.com` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | For email | Any SMTP provider. Gmail app password, Resend, Mailgun, etc. |
| `TELEGRAM_BOT_TOKEN` | For Telegram | One bot for the whole instance, from [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_CHAT_ID` | Optional, for Telegram | Hardcodes a single destination chat for the whole deployment. Simplest setup for a single-user instance - set this and skip per-user chat IDs entirely. If unset, falls back to each user's own `telegram_chat_id` (see below), for deployments with more than one account. |

### Frontend (Vercel)

| Variable | Required | Notes |
|---|---|---|
| `VITE_API_URL` | Yes | Your Render backend URL + `/api`, e.g. `https://your-backend.onrender.com/api` |

## Deploying

1. **Backend on Render**: new Web Service from `backend/`, build command
   `npm install`, start command `npm start`. Add a Render Postgres instance
   and wire `DATABASE_URL` to it. Set the rest of the env vars above.
2. **Frontend on Vercel**: import `frontend/`, framework preset Vite. Set
   `VITE_API_URL`.
3. Once both are live, update `CORS_ORIGIN` on the backend to your real
   Vercel URL (not `*`) and redeploy.
4. Sign up through the deployed frontend (with your `SIGNUP_CODE` if set).
5. Set up the external cron (see above). The app does nothing without it.
6. In Settings, turn on push notifications and send yourself a test one.

## Known limitations, stated plainly

- **Domain (WHOIS) expiry is still best-effort, by nature of WHOIS
  itself.** Response formats aren't standardized across registrars -
  `lib/certCheck.js` now matches a wider set of field names (including
  JPRS's bracketed `[Expires on]` format and a few date shapes like
  `2027/01/01` that `new Date()` doesn't parse on its own) and explicitly
  follows referral servers for thin-registry TLDs, but there is no
  registry-agnostic way to guarantee a parse. If a monitor's domain
  expiry shows "unknown," the lookup either failed or used a format the
  parser still doesn't recognize - it's not a promise the domain never
  expires. SSL certificate expiry, by contrast, is read directly off the
  live TLS handshake and is reliable.
- **WHOIS needs outbound TCP on port 43.** Most hosts allow this, but
  it's not universal. If every domain expiry check fails on your Render
  instance, this is the first thing to check.

## Recent changes

- **TCP/port checks, a third monitor_type alongside http and synthetic.**
  For anything that isn't a web endpoint - a database, a message queue, a
  raw socket service. `lib/tcpCheck.js` just opens a TCP connection to
  `tcp://host:port` and checks it completes within the timeout; nothing
  about what's actually listening there is inspected, which is what
  makes it work for arbitrary TCP services rather than only HTTP ones.
  Same result shape (`{ status, statusCode, responseMs, errorMessage,
  contentHash }`) and same one-retry-before-it-counts behavior as
  `httpCheck.js`, for the same reason - a transient connection blip
  shouldn't open an incident on its own. `checkRunner.js`'s dispatch is
  now a three-way switch on `monitor_type` instead of two; everything
  past that point (logging, thresholds, degraded-state, alerting) is
  unchanged and doesn't know which check type ran.
  Deliberately excluded rather than made to silently no-op: the cert
  sweep already only picks up `url LIKE 'https://%'` so tcp:// monitors
  were never going to reach it, but the security-scan sweep had no such
  filter and would have handed `scanSite()` a `tcp://` URL `fetch()`
  can't touch - added a `monitor_type != 'tcp'` condition there, and the
  manual "Rescan now" route now returns a plain 400 instead of an ugly
  fetch failure. Frontend hides the Certificate & domain and Security
  scan sections entirely on a TCP monitor's detail page rather than
  showing them permanently empty. `routes/monitors.js` validates a
  tcp-type monitor's URL at save time (`tcp://` scheme, port required) -
  `new URL()` alone accepts `tcp://host` with no port just fine, since
  it's a syntactically valid if useless URL.

- **Fixed inconsistent row layout on the public combined status page.**
  `SharedStatusPageView.jsx`'s per-monitor row used `flexWrap: "wrap"`
  with no truncation on the name, so whether the 24h/7d/30d stats sat
  inline or dropped to their own line depended on how long that
  particular monitor's name happened to be - "Focusdial" fit on one
  line, "Expenses tracker" didn't, so the two rows looked inconsistently
  laid out next to each other even though nothing was actually broken.
  `MonitorCard.jsx` already solved this exact shape (dot + name on the
  left, stats on the right) the other way: never wrap, truncate the name
  with an ellipsis instead (`.pl-monitor-card__main`'s `flex: 1;
  min-width: 0` plus `.pl-monitor-card__name`'s `white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis`). Rebuilt the status-page
  row the same way instead of inventing a second approach - name/dot
  block gets `flex: 1; min-width: 0`, the stats block gets
  `flex-shrink: 0`, name truncates. Every row now behaves identically
  regardless of name length.
- **Fixed the monitor checklist in "New status page."** `.pl-field
  input` is a descendant selector meant for the one direct text-input
  child a `.pl-field` normally has - it was also reaching the checkboxes
  nested two levels down in the monitor checklist (`.pl-field` >
  scroll box > `<label>` > `<input type="checkbox">`), stretching each
  one to `width: 100%` with 10px/12px padding meant for a text field.
  That's what put visible daylight between each checkbox and its label
  instead of them sitting flush together. Added a `.pl-field
  input[type="checkbox"]` (and `[type="radio"]`, same problem waiting
  to happen) override right after it that resets width/padding/
  background/border back to a normal inline checkbox.
- **Mobile layout fixes on the Status pages tab.** Two real bugs, not
  just tightening: (1) `StatusPagesView.jsx`'s header row (the
  explanatory text + "New status page" button) used a raw inline flex
  style with no wrap, so on narrow screens the text and button got
  squeezed onto one cramped line instead of stacking - switched it to
  the same `.pl-dashboard-toolbar` / `.pl-dashboard-actions` classes the
  Monitors tab's own toolbar already uses, so it inherits that existing
  mobile stacking for free instead of needing its own media query. (2)
  The nav pill for "Status pages" (`App.jsx`'s `.pl-nav`) is two words
  where the other two tabs are one, so at mobile widths it wrapped onto
  two lines and rendered visibly taller than "Monitors"/"Settings" next
  to it - fixed with a mobile-only smaller font/padding + `white-space:
  nowrap` on `.pl-nav button`, which keeps it on one line without
  shrinking the desktop nav at all. Also trimmed the gap between the
  24h/7d/30d numbers in `SharedStatusPageView.jsx`'s per-monitor rows on
  mobile (new `.pl-status-page-row__stats` class, same pattern as
  `.pl-monitor-card__stats` already had), matching the tightening every
  other uptime-cell/stat block already got.
- **Combined status pages** - one link showing several monitors together,
  distinct from `monitors.share_token` (still one link per monitor, for
  a client who only needs the one service). A new `status_pages` table
  is either group-based (`group_name` - live, so adding a monitor to
  that group later shows up on the page automatically) or manual
  (`monitor_ids`, a fixed JSONB array picked at creation time) - never
  both, enforced in `routes/statusPages.js` rather than a CHECK
  constraint, same "cross-field validation lives in the API layer"
  pattern `validateSteps` already uses for synthetic monitors. The
  public read (`GET /api/public/status-pages/:token` in `routes/public.js`)
  resolves the monitor list live from whichever mode the page uses, then
  computes 24h/7d/30d uptime % for all of them in one grouped query
  rather than making the frontend fan out to N separate uptime calls.
  Same narrow field set as the existing per-monitor share view - no auth
  header, no synthetic steps, no owner - plus the rolled-up uptime.
  Management UI is a new "Status pages" tab (`StatusPagesView.jsx`):
  create with a name and either a group dropdown or a monitor checklist,
  copy/regenerate the link, edit, delete. The link itself is
  `#/status/<token>`, resolved in `main.jsx` before `App` mounts -
  identical no-session treatment to `#/share/<token>` - and rendered by
  `SharedStatusPageView.jsx`, a flat list of monitor rows (status dot,
  name, last-checked, 24h/7d/30d uptime) rather than the deep-dive chart
  a single-monitor share page gets; anyone wanting more detail on one
  monitor specifically still uses that monitor's own share link.
- **Weekly digest**, opt-in per user (`users.digest_enabled`, off by
  default). Once turned on, `lib/digest.js`'s `runDigestSweep()` - called
  from the cron tick alongside the cert/security sweeps - sends one
  summary per user roughly every 7 days: uptime % and incident count per
  active monitor over the last week, plus a cert/domain-expiring-within-
  14-days note reusing the same threshold `alertExpiringSoon` already
  uses, so nothing shows up in the digest that wouldn't also have paged
  you separately. Goes out over whatever channels are already
  configured - push, email, Telegram - same three sends every other
  alert in `checkRunner.js` already does, just once a week instead of
  on a state transition. `digest_sent_at` is the cadence clock: NULL is
  immediately due, and it's a rolling 7-days-since-last-send rather than
  a fixed day-of-week, so turning it on any day just means "every 7 days
  from now" - no everyone-converges-on-Monday effect. The clock resets
  even if a send fails (e.g. SMTP misconfigured), same reasoning as
  everything else here that would rather go quiet than retry forever.
  Settings has a new "Weekly digest" toggle plus a "Send test" button
  (`POST /api/auth/digest-test`) that sends immediately without
  touching `digest_sent_at`, same "test doesn't affect real state" shape
  as the existing push/Telegram test buttons.
- **Degraded state**, distinct from up/down. Opt-in per monitor
  (`degraded_threshold_ms`, NULL by default = off): a *passing* check
  slower than the threshold bumps a separate `consecutive_slow` counter,
  and once that streak hits `alert_after_slow` (default 3, same shape
  as `alert_after_failures`) `current_status` flips to `degraded` and
  fires one alert - lighter than a down alert on purpose: no incident
  row, no repeat "still slow" nag every tick, just one nudge on the way
  in and one ("back to normal speed") on the way out. Down still takes
  priority - the degraded check only runs on the branch where the check
  itself passed. Suggested default threshold is 1500ms, matching the
  amber cutoff `lib/latency.js`'s `latencyColorForMs()` already used for
  the response-time color scale, so "degraded" and "reads as amber
  everywhere else in the UI" line up rather than being two different
  numbers that happen to almost agree. `MonitorForm.jsx` gained a
  toggle + two fields (threshold, streak count) right after the
  existing failure-threshold field; `MonitorCard.jsx` and
  `MonitorDetail.jsx` both show an amber "slow" badge and the dot gets
  its own pulsing amber `pl-status-dot--degraded` class, mirroring the
  existing up/down dot treatment instead of reusing red for something
  that isn't actually down.
- **Per-monitor check timeout.** `monitors.check_timeout_sec` (default
  15, bounded 3-60 at the API layer in `routes/monitors.js`), replacing
  the old fixed 15-second constant in both `httpCheck.js` and
  `syntheticCheck.js` (per step there, same as the timeout always
  applied per step rather than to the whole sequence). Exists because a
  legitimately slow endpoint - a cold-start API, a heavy report page -
  had no way to avoid being recorded as "down" purely for being slow.
  Set per monitor in `MonitorForm.jsx`, right under the check-interval
  field.
- **Broader WHOIS expiry parsing**, `lib/certCheck.js` - see "Known
  limitations" above for what changed and what's still inherently
  unfixable about it.

- **Read-only share links, per monitor.** `monitors.share_token`
  (nullable, unique) - NULL means sharing's off. "Create share link" in
  a monitor's detail view sets it and shows
  `<frontend-url>/#/share/<token>`; "Regenerate" swaps it for a new one
  in the same write, so the old link stops resolving the instant the new
  one exists; "Revoke" clears it back to NULL. The hash route is checked
  in `main.jsx` before `App` ever mounts, so opening one never touches
  `getMe()` or the session - it's rendered by the new
  `SharedMonitorView.jsx` instead, which only talks to a new
  `routes/public.js` (mounted at `/api/public`, outside `requireAuth`
  entirely). Every query in that router is scoped by the token itself,
  never by monitor id alone, so there's no way to walk from one shared
  monitor to another. Deliberately narrow, matching "status/uptime/
  security score" plus a response-time trend, nothing more: the public
  monitor read and the `/checks` read are both explicit column lists
  (name/url/status/last-checked/response-time; checked_at/status/
  response_ms), not `SELECT *` - no auth header, no synthetic steps, no
  owner, no `error_message`. The security endpoint returns only
  `{ score, scanned_at }`, never the findings array (exposed paths,
  missing headers - useful to the owner, not to whoever holds the link).
  Still no incident history; `routes/monitors.js`'s own `:id/incidents`
  is the reference if that's ever wanted. The token itself isn't hashed
  at rest the way `api_tokens.token_hash` is - it's not a credential
  proving who you are, it's a lookup key that's supposed to grant read
  access to whoever has the URL, so hashing it would add nothing.
  The response-time chart itself (`components/ResponseTimeChart.jsx`)
  was pulled out of `MonitorDetail.jsx` into its own component so the
  share view could reuse it exactly rather than re-implementing the
  downsampling/tooltip logic a second time - both pass it raw
  `{ checked_at, status, response_ms }` rows and it handles bucketing
  and mobile sizing itself via `useIsMobile`. `SharedMonitorView.jsx`
  applies the same hook for its own layout - tighter shell padding,
  smaller title/uptime-cell type, and wrapping the security-score row -
  below the app's existing 560px breakpoint.
- **Custom dropdown, app-wide.** Every native `<select>` (Check type,
  Method in the monitor form, and the per-step Method in
  `SyntheticStepsEditor.jsx`) is now `components/Dropdown.jsx` - a
  button + absolutely-positioned option list styled to the app's own
  dark theme, instead of the OS/browser's native picker rendering with
  zero relation to Pulse's own look. Same `value`/`onChange`/flat-options
  shape as a native select, so it drops into an existing `pl-field`
  without touching surrounding form logic. Closes on an outside click or
  Escape.
- **Fixed: multi-step monitor detail page broke into horizontal scroll
  on mobile.** Two instances of the same bug, both flex children missing
  `min-width: 0` so they'd refuse to shrink below their content's
  natural width regardless of what `overflow`/`text-overflow` said:
  `.pl-detail-head`'s name+URL side (a "multi-step" badge tacked onto a
  short name was usually enough to tip a header over the viewport width
  on a phone), and, the one that actually mattered here,
  `.pl-incident-row__error` - it had `text-overflow: ellipsis` set, but
  that was silently doing nothing without `min-width: 0`, so a
  multi-step error message ("Step 2 (GET .../cookies): response did not
  contain expected text..."), much longer than a typical single-request
  error, just overflowed the row instead of truncating. Both fixed;
  regular http monitors never hit either bug since their error text and
  header are usually short enough to fit anyway. Mirrors the pattern
  `.pl-monitor-card__main` already had right, which is why the monitors
  list was never affected.
- **API tokens.** Bearer-token auth for scripting against Pulse directly
  (cron jobs, other tools) alongside the existing browser session -
  `requireAuth.js` now accepts either. New `api_tokens` table (hash only,
  never the raw value - same shape as a password), `lib/apiTokens.js` for
  generate/hash, `routes/tokens.js` for list/create/revoke. Settings has a
  new "API tokens" section: name one, copy it once (it's never shown
  again after that response), revoke it later. `last_used_at` updates in
  the same query as the auth lookup so a token that's actually in use
  doesn't cost a second write per request.
- **Content-diff monitoring**, http-type monitors only (toggle in the
  monitor form). `httpCheck.js` hashes the response body - reusing the
  same read `body_contains` already does, not a second fetch - and
  `checkRunner.js` compares it against the last-seen hash on each passing
  check. First time seeing a hash, it's just the baseline, no alert. A
  mismatch fires one alert *and* immediately becomes the new baseline, so
  a legitimate deploy costs a single nudge rather than repeating on every
  check until someone manually re-baselines it. Shows up in
  `MonitorDetail.jsx` as a "Content monitoring" panel with the
  last-changed timestamp, when the monitor has it turned on.
- **Multi-step synthetic checks** - a new `monitor_type` ('http' default,
  'synthetic'), with steps stored as JSONB on `monitors.synthetic_steps`.
  **Scope note, called out explicitly because it's a real trade-off, not
  a hidden shortcut:** this is a sequence of plain HTTP requests
  (`lib/syntheticCheck.js`) carrying cookies and `{{name}}`-substituted
  extracted variables from one step to the next. No JS execution, no
  client-side rendering. It covers "log in, follow the session, hit a
  gated page, assert on the result" (most of what "returns 200 but is
  actually broken" means for a typical backend) - but it won't catch a
  page that loads fine over the wire and then breaks once client-side JS
  runs. `checkOneMonitor`'s result shape (`{ status, statusCode,
  responseMs, errorMessage }`) doesn't care which check type produced
  it, so that gap stays an option to revisit later rather than something
  baked into the architecture. `MonitorForm.jsx` gained a
  check-type selector and a `SyntheticStepsEditor.jsx` for building the
  step list (method, URL, body, expected status, body-contains, and the
  optional extract); no per-step custom headers in that UI - the
  monitor's single auth header applies to every step. Everything
  downstream (checks table, uptime %, heatmap, response-time chart,
  incidents) already worked for free, since a synthetic check's result
  logs into the exact same `checks` row shape as an http check's does.
- **Response-time chart tooltip colors by actual latency, not the
  line's fixed color.** The `ms : 431` figure in the chart tooltip used
  to inherit recharts' default per-series coloring, which is just the
  line's static stroke - so it read as green even on a genuinely slow
  431ms point. It's now a custom tooltip (`ResponseTimeTooltip` in
  `MonitorDetail.jsx`) that colors that number with the same green /
  amber / red bands `MonitorCard.jsx` already uses for the latency stat
  on each monitor card. Pulled the threshold logic out of `MonitorCard.jsx`
  into `lib/latency.js` (`latencyColorForMs(ms)`) so both places share one
  definition instead of two copies drifting apart later.
- **Push test/send now reports real delivery, not just "request
  received."** `sendPushToUser()` used to swallow every per-subscription
  failure and return nothing, so `POST /api/push/test` always answered
  `{ ok: true }` even when zero notifications actually reached a device -
  the exact "it says sent but nothing arrives" report that prompted this.
  It now returns `{ total, sent, failed, configured }`, and `/test` turns
  that into a real error when appropriate: 503 if VAPID isn't configured
  at all, 400 if this device has no subscription row, 502 if the push
  service rejected every send. The Settings toast reflects genuine
  outcomes now, including a partial-failure case ("delivered to 1 of 2
  devices"). The most common real-world cause behind a silent failure:
  the browser/OS drops a subscription on its own after a long idle period
  or a reinstall, with no way for the server to know until the next send
  attempt fails - toggling push off and back on gets a fresh one.
- **Mobile response-time chart decluttered.** The chart in
  `MonitorDetail.jsx` was plotting one point per check - up to 200 of
  them - which reads as jittery noise on a narrow screen with nowhere
  near that many pixels of width to render it meaningfully. It's now
  bucketed and averaged down to at most 60 points on desktop / 24 on
  mobile (`downsampleChartData()`, viewport detected via the new
  `hooks/useIsMobile.js`). Down/no-data points are excluded from each
  bucket's average rather than counted as 0ms, and an all-down bucket
  stays null, so real outages still show as a gap in the line instead of
  a dip to zero.
- **Telegram alerts: env-var chat ID.** `TELEGRAM_CHAT_ID` now resolves
  ahead of `users.telegram_chat_id` (`resolveChatId()` in
  `lib/telegram.js`), so a single-user deployment can wire up alerts
  entirely from Render/hosting env vars with no per-user field to fill
  in. The Settings page reflects this: it no longer has a chat-ID input,
  just a "Telegram alerts: Connected / Not connected" status line and a
  test-send button, driven by `GET /api/telegram/status`'s `ready` flag.
  `users.telegram_chat_id` and the `PATCH /api/auth/me` support for it
  are still there in the schema/API for a future multi-user setup where
  a shared env-var chat would cross-wire everyone's alerts - there's just
  no UI wired up to set it right now, since the only account on this
  instance doesn't need it. If that's ever needed again, it's a Settings
  form away, not a backend change.
- **Telegram alerts**, alongside push and email. One bot for the whole
  instance (`TELEGRAM_BOT_TOKEN`, from BotFather), each user pastes their
  own chat ID into Settings - same shape as SMTP-for-sending +
  `alert_email`-for-routing, just with `telegram_chat_id`. Fires from the
  same four alert sites as push/email (`alertDown`, `alertStillDown`,
  `alertRecovered`, `alertExpiringSoon` in `checkRunner.js`), so it's
  subject to the same throttling (hourly repeat-down, once-per-day expiry
  nudge) rather than being a separate alerting path. `GET
  /api/telegram/status` tells the frontend whether a bot is configured at
  all, so the Settings section only appears when it's actually usable;
  `POST /api/telegram/test` sends a one-off test message the same way the
  existing push test does. No new dependency - it's a plain `fetch` to
  Telegram's Bot API, same as every other outbound HTTP call in this repo.
- **Consecutive-failure threshold before alerting**, per monitor
  (`alert_after_failures`, default 1 = old behavior). A failed check below
  the threshold is still logged in `checks` and bumps a
  `consecutive_failures` counter on the monitor row, but doesn't flip
  `current_status` to "down", open an incident, or fire an alert - only
  the check that actually crosses the threshold does. Any "up" resets the
  counter to 0. This sits on top of, not instead of, the existing single
  retry in `httpCheck.js`: the retry absorbs a blip within one check, this
  absorbs a blip that spans several checks in a row. Editable per-monitor
  in the monitor form; no UI surfaces the live streak count itself, only
  the resulting `current_status`.
- **Security scanner added**, ported from a separate Cloudflare Worker
  project (`wyntek-status`) that briefly existed as a standalone public
  status page for Wyntek clients. That whole project was retired -
  everything it did now lives here instead, so there's one app to
  maintain, not two. The scanner runs the same passive checks (HTTPS
  enforcement, six security headers, server-version disclosure, four
  exposed-path checks) on the same daily cadence as the existing cert
  sweep, and is fully private: no public endpoint, results only visible
  to a monitor's owner.
- **A traffic/analytics beacon was ported over too, then removed** at the
  owner's request - decided it wasn't worth the added surface area
  (a public write endpoint, an embed snippet to paste into every client
  site) for what it added. If this ever comes back, the reference
  implementation is in `wyntek-status`'s git history: `analytics.ts`
  (event collection + UA parsing) and the `BEACON_SCRIPT` template.
- **Fixed a stale-data race condition** on the monitor detail page: if you
  switched monitors quickly, a slow-resolving fetch for the previous
  monitor could resolve after the switch and silently overwrite the
  now-current monitor's state with the old one's data. Most visible with
  security scan results specifically, since those only change once a day
  and wouldn't self-correct on the next 30s auto-refresh the way checks
  or incidents would. Fixed with a per-effect `ignore` flag that discards
  any response that resolves after its monitor has been navigated away
  from - the standard React pattern for this class of bug.
- **Fixed mobile layout on the security findings list** - it was reusing
  `.pl-incident-row`, styled for a short single-line error message with
  `white-space: nowrap`. A finding's detail text is a full sentence of
  advice, so on narrow screens it couldn't wrap and pushed the Pass/Fail
  badge off-screen. Now has its own `.pl-finding-row` class that wraps
  normally and stacks the result badge below the text under 560px.
- **Added "Download report"** next to "Rescan now" - exports the current
  scan as a plain-text file (score, timestamp, every finding with detail)
  client-side, no backend endpoint needed since the data's already loaded
  on the page.

## Ideas for later

Not built, just worth keeping track of. Deliberately excludes anything
that would need Pulse to hold write access to another repo/host - that
was considered (auto-fix for security header findings, opening a PR to
fix them) and deliberately not built for exactly that reason.

- **Scheduled maintenance windows** - pre-announce a window in advance
  instead of manually snoozing each time; useful once client deploys
  happen on a regular cadence. Purely a read/write against Pulse's own
  DB, no external access, so this is back on the table now that the
  auto-fix idea (the thing that actually needed outside write access) is
  off it.
- **CSV export of check/uptime history** - for when a client asks for
  proof of downtime over a specific window.
