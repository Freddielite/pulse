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

- **Domain (WHOIS) expiry is best-effort.** WHOIS response formats aren't
  standardized across registrars, so parsing relies on matching a handful
  of common field names. If a monitor's domain expiry shows "unknown," the
  lookup either failed or used a format the parser doesn't recognize -
  it's not a promise the domain never expires. SSL certificate expiry, by
  contrast, is read directly off the live TLS handshake and is reliable.
- **WHOIS needs outbound TCP on port 43.** Most hosts allow this, but
  it's not universal. If every domain expiry check fails on your Render
  instance, this is the first thing to check.
- **The 15-second check timeout** applies to every HTTP check. A
  legitimately slow endpoint that takes longer than that will be recorded
  as down. Not currently configurable per-monitor.

## Recent changes

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

Not built, just worth keeping track of:

- **Slack/Discord webhook alerts** - Telegram now covers the "push
  notification to a channel/group, not just a personal device" need;
  Slack and Discord incoming-webhooks would fit the same alert sites for
  teams that live there instead.
- **Read-only share links per monitor** - a link scoped to one monitor's
  status/uptime/security score that can be handed to a client, no login,
  no visibility into any other monitor. Different from a full public
  status page - narrower, single-monitor scope.
- **Scheduled maintenance windows** - pre-announce a window in advance
  instead of manually snoozing each time; useful once client deploys
  happen on a regular cadence.
- **Content-diff monitoring** - hash the response body and alert on
  unexpected changes outside a known deploy window. This is a real
  defacement/compromise detector (site returns 200 but someone injected
  something), which nothing currently checks for.
- **Multi-step synthetic checks** - simulate a real user flow (load page
  → log in → confirm dashboard renders) instead of just pinging a URL.
  Catches "returns 200 but the app itself is actually broken," which a
  status-code check can't see.
- **CSV export of check/uptime history** - for when a client asks for
  proof of downtime over a specific window.
- **API tokens** - script against Pulse directly instead of only through
  the UI.
