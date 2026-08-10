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

- **Consecutive-failure threshold before alerting** - right now the
  existing single retry helps, but a configurable "N checks in a row"
  option would cut down false-positive alerts further on flaky
  connections.
- **Webhook alerts** (Slack/Discord/Telegram) - push and email exist;
  a webhook option would fit better for a client-facing channel than
  personal push notifications.
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
