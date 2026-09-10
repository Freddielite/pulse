# Pulse

A personal uptime and keep-alive monitor for your own apps and APIs. Built
specifically for the Render/Vercel free-tier reality: Render spins a web
service down after 15 minutes idle, so Pulse pings the things you care
about often enough that they never get the chance.

## What it does

- **Uptime monitoring** - add any URL, Pulse checks it on a schedule you
  set, tracks response time, and keeps a full history of every check.
- **Keeps Render apps awake** - mark a monitor as a keep-alive target and
  Pulse's own check cycle is what stops it from sleeping.
- **SSL and domain expiry tracking** - reads your certificate's real
  expiry off a live TLS handshake, and makes a best-effort WHOIS lookup
  for domain registration expiry. Warns you 14 days out.
- **Content assertion** - optionally require the response body to contain
  specific text, so a 200 with a broken or empty page still counts as
  down.
- **Retry before alerting** - a single failed check gets one retry after
  a short delay before it's treated as down, so a transient network blip
  doesn't turn into a false alarm.
- **Snooze** - pause checks and alerts on a monitor for a set window
  (e.g. during a planned redeploy), it resumes automatically.
- **Groups** - label monitors (e.g. "Wyntek clients", "Personal") and the
  dashboard groups them once you have more than one label in use.
- **Push and email alerts** - notified the moment something goes down,
  when it recovers, and periodically if it's still down. Push works once
  deployed over real HTTPS (browsers block it on plain HTTP).
- **Incident history and uptime heatmap** - every outage is logged with
  duration, plus a day-by-day heatmap per monitor going back 90 days.
- **Security scanning** - a passive, non-destructive scan per monitor,
  around 30 checks: HTTPS enforcement and HTTP-to-HTTPS redirect, six
  security headers graded on their *values* (a CSP of `default-src *`
  and an HSTS of `max-age=1` fail, rather than passing a presence
  check), cookie flags, version disclosure, third-party script
  inventory with SRI, mixed content, CORS reflection, TRACE, GraphQL
  introspection, and 17 commonly-exposed sensitive paths. Runs
  automatically once a day per monitor, or on demand with "Rescan now."
  Fully private - there's no public endpoint for it, only the
  authenticated owner of a monitor can see its results.
- **Severity-weighted scoring** - findings are critical/high/medium/low,
  and the score is weighted accordingly, so an exposed `.env` and a
  missing `Permissions-Policy` don't move the number by the same amount.
  Any critical failure forces the letter grade to F regardless of what
  else passes.
- **Security regression alerts** - scans are kept as history, not
  overwritten, and every scan is diffed against the previous one. A
  check going from passing to failing alerts ("HSTS disappeared after
  Friday's deploy"). A check that only exists in the newer scan is never
  reported as a regression, so upgrading Pulse itself can't fire a false
  alarm.
- **Security timeline** - one chronological record per monitor of
  everything that changed: regressions, certificate swaps, DNS drift,
  new certificates in the CT logs, an endpoint that stopped requiring
  auth. Acknowledging an event keeps it in the record rather than
  deleting it.
- **Full TLS posture** - the same handshake that reads expiry now also
  reports protocol and cipher (flagging TLS 1.0/1.1), key size,
  hostname/SAN match, chain completeness (the "works in Chrome, fails in
  curl" misconfiguration), trust status, and the certificate's SHA-256
  fingerprint. An unexpected fingerprint change alerts - that's the
  signal for a hijacked DNS record, a compromised CDN account, or a
  mis-issued certificate, none of which make the site look any different
  from the outside.
- **DNS posture and drift** - snapshots A/AAAA/CNAME/MX/NS/TXT/CAA every
  few hours and alerts when they change unexpectedly, grades SPF, DMARC
  and CAA, and detects dangling CNAMEs pointing at deprovisioned
  platforms (subdomain takeover). A lookup that *fails* is reported as
  unknown, never as "not configured".
- **Certificate Transparency monitoring** - watches the public CT logs
  for certificates issued for your domain, alerting on issuance from a
  CA that's never issued for you before. Doubles as subdomain discovery:
  every hostname anyone ever got a certificate for, with a one-click
  "monitor this too" on the ones you aren't watching yet.
- **Auth-required assertions** - opt in per monitor and Pulse sends the
  same request *without* its credential and fails if the server answers
  it anyway. This is what catches an endpoint shipped with its auth
  middleware missing: every other check goes green for that deploy,
  because the endpoint does respond, quickly, with valid data, to
  everyone.
- **Downloadable security reports** - export a monitor's latest scan as a
  plain-text report led by the grade and the failures, each with its
  severity and the exact configuration change that fixes it (nginx,
  Express, Vercel, Netlify or Cloudflare), plus TLS details and recent
  unacknowledged changes.
- **Multi-step (synthetic) checks** - a plain-HTTP request sequence
  (login, follow the session, hit a gated page, assert on the result)
  with cookies and extracted variables carried from one step to the
  next. No JS execution or client-side rendering.
- **Read-only share links** - a link scoped to one monitor's status,
  uptime, and security score that you can hand to a client, no login,
  no visibility into any other monitor.
- **Telegram alerts**, alongside push and email - one bot for the whole
  instance, resolves a shared `TELEGRAM_CHAT_ID` env var first so a
  single-user deployment needs zero per-account setup.
- **Content-diff monitoring** - hashes the response body and flags an
  unexpected change, catching a live defacement/compromise that a plain
  status-code check can't see.
- **API tokens** - script against Pulse directly instead of only through
  the browser session.

## Stack

- **Backend**: Node/Express + PostgreSQL, deploys to Render.
- **Frontend**: React + Vite, deploys to Vercel.
- No background job runner - every scheduled thing (checks, cert
  sweeps, alerts) happens through one endpoint, `POST /api/cron/tick`,
  meant to be hit by a free external cron service. See `HANDOVER.md` for
  why that's the design and exactly how to wire it up.

## Project structure

```
backend/          Express API + Postgres
  src/
    routes/        auth, monitors, push, cron, telegram, tokens, public
    lib/           check runner, HTTP/synthetic checks, SSL/WHOIS,
                    push, email, telegram, security scanner, API tokens
    db.js           schema + migrations (runs automatically on boot)
  scripts/
    gen-vapid.js    generates VAPID keys for push notifications
frontend/         React + Vite dashboard
  src/
    components/     Dashboard, MonitorDetail, MonitorForm, Settings,
                    SyntheticStepsEditor, SharedMonitorView, etc.
    api.js          all backend calls
HANDOVER.md       deployment steps, env vars, known limitations
```

## Running it locally

You'll need Node and a Postgres database (local or a free hosted one).

```bash
# Backend
cd backend
npm install
# create backend/.env with:
#   DATABASE_URL=postgresql://user:pass@localhost:5432/pulse_dev
#   SESSION_SECRET=any-random-string
#   NODE_ENV=development
#   PORT=4000
npm run dev

# Frontend, in a second terminal
cd frontend
npm install
npm run dev
```

The frontend's dev server proxies `/api` straight to `localhost:4000`, so
no extra config is needed there. Tables are created automatically on the
backend's first boot.

There's no cron running locally, so nothing gets checked on its own -
hit `http://localhost:4000/api/cron/tick` yourself (browser or curl)
whenever you want to force a check cycle.

## Deploying

See `HANDOVER.md` for the full walkthrough: Render + Vercel setup, every
environment variable, and - critically - the external cron setup that
makes the whole "never sleeps" idea actually work.
