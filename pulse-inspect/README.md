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
    routes/        auth, monitors, push, cron
    lib/           check runner, HTTP checks, SSL/WHOIS, push, email
    db.js           schema + migrations (runs automatically on boot)
  scripts/
    gen-vapid.js    generates VAPID keys for push notifications
frontend/         React + Vite dashboard
  src/
    components/     Dashboard, MonitorDetail, MonitorForm, Settings, etc.
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
