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
| `BREVO_API_KEY` / `EMAIL_FROM` / `EMAIL_FROM_NAME` | For email | Free API key from [Brevo](https://app.brevo.com) (300 emails/day on the free plan) plus a sender address verified in Brevo's dashboard. `EMAIL_FROM_NAME` is optional, defaults to "Pulse". Replaced SMTP entirely - see the "Email switched from SMTP to Brevo" entry under Recent changes for why. |
| `TELEGRAM_BOT_TOKEN` | For Telegram | One bot for the whole instance, from [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_CHAT_ID` | Optional, for Telegram | Hardcodes a single destination chat for the whole deployment. Simplest setup for a single-user instance - set this and skip per-user chat IDs entirely. If unset, falls back to each user's own `telegram_chat_id` (see below), for deployments with more than one account. |
| `GOOGLE_SAFE_BROWSING_API_KEY` | For blacklist checks | Free from the Google Cloud Console (enable the Safe Browsing API). Without it, `blacklist_status` stays `NULL` on every monitor rather than reading as a false "clean" - see lib/blacklistCheck.js. |
| `HIBP_API_KEY` | For breach monitoring | Paid subscription key from [haveibeenpwned.com/API/Key](https://haveibeenpwned.com/API/Key) - HIBP gated this endpoint in 2019, there's no free tier. Without it, breach monitoring silently never runs even if a user turns the toggle on - see lib/breachCheck.js. |
| `FRONTEND_URL` | Optional, for org invite emails | Where the invite email tells someone to go log in or sign up. Without it, the email just says "log into Pulse" / "sign up for Pulse" with no link - still useful, just not clickable. |

The original DNS/TLS/CT posture features still need nothing beyond what
was already required - DNS uses the system resolver, TLS is a plain
handshake, crt.sh is a public endpoint with no key. Only the two rows
above are new, and both features degrade to "not checked" rather than
erroring when their key is missing, so leaving either unset is a safe
default, not a broken one.

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
- **Certificate Transparency depends on crt.sh.** It's free, public and
  needs no key, but it's also occasionally slow or briefly unavailable.
  Every failure there is soft: the sweep logs it, marks the monitor
  checked so one unavailable third party can't jam the same monitor
  forever, and moves on. A CT lookup being down is not an event worth
  alerting anyone about.
- **The registrable-root heuristic is wrong for multi-part suffixes.**
  `registrableRoot()` in `lib/dnsCheck.js` takes the last two labels,
  which is right for `example.com` and wrong for `example.co.uk` or
  `example.com.ng` - it would look up `co.uk`. This is the same
  simplification `getDomainExpiry()` has always made. Fixing it properly
  means shipping the Public Suffix List, which is a dependency plus a
  data file that goes stale; it's a deliberate trade, not an oversight.
- **The auth-required assertion can't run on a monitor that's down.** It
  only runs on the passing branch of a check, because "does this endpoint
  still refuse anonymous callers" is unanswerable when the endpoint isn't
  answering at all. Practically: if you point a monitor at a protected
  endpoint *without* giving it credentials, the uptime check will record
  it as down (401 != expected 200) and the probe will never run. Give the
  monitor its auth header, or set `expected_status` to what the
  authenticated request actually returns.
- **Subdomain takeover detection is signature-based.** It covers the 8
  platforms whose "nothing is configured here" pages are recognizable
  (GitHub Pages, Heroku, S3, Netlify, Vercel, Shopify, Fastly, Azure). A
  dangling CNAME to anything else won't be flagged, and an unreachable
  host is treated as inconclusive rather than as a takeover - a dangling
  record and a temporarily down host look identical from outside, and
  reporting the second as the first would be a frightening false
  positive.
- **WHOIS needs outbound TCP on port 43.** Most hosts allow this, but
  it's not universal. If every domain expiry check fails on your Render
  instance, this is the first thing to check.
- **A plain member can still view and edit their own settings, obviously
  - the role model is about what they can do to other people's/the
  org's shared resources, not their own account.** Stated explicitly
  because it's easy to misread "members have less power" as broader
  than it is: a member's own notification prefs, 2FA, webhook URL, etc.
  are theirs regardless of org role.
- **A status page still can't be moved between personal and org
  ownership after creation** (monitors can now - see "Recent changes").
  `status_pages.organization_id` is set once, at creation, through the
  create form's "Owner" selector - the same PATCH-side reassignment
  monitors just got would extend directly if this is ever needed.
- **`custom_domain` on an organization is a stored reminder, not
  automation.** Typing one in doesn't route anything - actually serving
  a client's own domain still needs a CNAME on their end and host
  routing/TLS on this app's end.
- **Scheduled authenticated deep-scans are still not built.** Everything
  the scanner does today runs unauthenticated and read-only against
  whatever a normal visitor can reach. A scan that logs in and checks for
  things like broken access control between roles is a genuinely
  different feature - it needs an explicit per-monitor opt-in and
  consent step (this is the one thing in the app that would act *as* the
  site owner rather than just observe from outside), a place to store
  credentials/session state safely, and its own scheduling separate from
  the passive scan. Deliberately not folded into this round.
- **The secret scanner only catches a credential sitting in a bundle as
  a literal matching string.** A key assembled at runtime (fetched from
  another endpoint, built from pieces, base64-wrapped) won't match, and
  the pattern list only covers about a dozen well-known formats (AWS,
  Stripe, GitHub, Slack, SendGrid, Square, generic private-key blocks) -
  it's the same class of coverage gap gitleaks/truffleHog have, not
  something specific to this implementation.
- **CSP violation reports are capped at 300 distinct shapes per monitor**
  (`MAX_CSP_ROWS_PER_MONITOR` in `routes/public.js`) and deduped by
  directive+blocked-URI+source-file with a running count, not stored one
  row per report. A policy that embeds something ever-changing into the
  blocked URI in a way `stripQuery()` doesn't catch could still fill that
  cap with distinct-looking rows for what's really one problem.

## Recent changes

- **Tier 3: remediation guidance, client-side secret scanning, CSP
  violation ingestion.**
  - Every scanner finding that was missing a "how to fix" now has one -
    exposed files/paths, mixed content, missing SRI, exposed source
    maps, long-lived session cookies, permissive CORS, TRACE enabled,
    open GraphQL introspection, and missing HTTPS/HTTP-redirect all get
    a concrete fix now, not just a description of the problem. Findings
    that aren't a hosting-header fix (build config, app logic) get a new
    "Fix" tab in the UI instead of being mislabeled under a platform name
    that wouldn't actually apply (`scanner.js`, `SecurityScanPanel.jsx`,
    `MonitorDetail.jsx`'s report generator).
  - New `auditSecrets()` in `scanner.js` checks a monitor's first-party
    shipped JavaScript against about a dozen well-known live-key formats
    (AWS, Stripe, GitHub, Slack, SendGrid, Square, private-key blocks).
    Any hit is masked before it's ever stored or displayed. Passive only
    - it reads the same files a browser already downloads, same as the
    existing source-map audit; it never sends a crafted request or tries
    a found credential against anything. Runs last in the scan so it
    only spends whatever request budget the more established checks
    didn't need, rather than crowding them out.
  - New CSP violation ingestion: `POST /api/public/monitors/:token/
    csp-report` accepts both the older `report-uri` format and the
    newer Reporting API's `report-to` format, dedupes by violation shape
    with a running count and last-seen time (one row per distinct
    problem, not one per report), and is capped per monitor so a noisy
    policy can't grow the table without bound. `index.js`'s JSON body
    parser now also accepts `application/csp-report` and
    `application/reports+json` content-types for `/api/public` - the
    default parser only reads `application/json` and would have silently
    dropped these. New `GET /:id/csp-violations` (read-only, same
    org-member access as every other GET) and `DELETE
    /:id/csp-violations` (mutation-gated, same as deleting the monitor
    itself) in `monitors.js`. Frontend: new `CspViolations.jsx` panel
    rendered under the security timeline, and a new "CSP violation
    reports" section under Share link showing the exact URL/header
    snippet to point a monitored site's policy at.
  - Item 12 from the original Tier 3 scope (scheduled authenticated
    deep-scans) is deliberately not included here - see Known
    limitations for why.
- **Uptime/synthetic checks now send a real browser-shaped User-Agent,
  Accept, and Accept-Language.** Root cause of false downtime alerts
  that only ever hit frontend-hosted sites: Node's built-in `fetch`
  sends no meaningful User-Agent by default, and a growing share of
  frontend hosting (Vercel's own firewall, Cloudflare in front of a
  custom domain) runs bot mitigation that specifically challenges or
  blocks requests shaped like a script instead of a browser - a
  missing/default User-Agent is the single biggest tell it looks for.
  The check then saw a 403 or a challenge page instead of the site's
  real 200 and reported an outage that never happened. A backend API
  on Render almost never sits behind this kind of filter, which is
  why the false alerts were frontend-specific. `httpCheck.js` and
  `syntheticCheck.js` both now default to ordinary browser headers,
  still overridable per monitor via `auth_header_name`/`auth_header_value`.
  This isn't a guaranteed fix against every WAF (a JS-challenge that
  needs an actual browser engine to solve is out of reach without the
  synthetic engine becoming an actual headless browser, a deliberate
  weight trade-off - see "Known limitations"), but it resolves the
  ordinary header-based bot filtering that's the far more common case.

- **The dashboard's "Snooze all monitors" panel no longer shows up when
  it would be a guaranteed no-op.** `snoozeAllMonitors`/
  `unsnoozeAllMonitors` only ever act on monitors the clicking user
  personally owns (`user_id` match, no `organization_id`) - a
  deliberate choice from when orgs were added, so a bulk action never
  silently reaches into a teammate's monitors. That means the panel was
  showing (and, for "unsnooze all," sometimes claiming something was
  snoozed) even for someone with zero personal monitors - not a role
  problem specifically, since an admin or owner whose monitors are all
  org-owned would hit the exact same dead button. `Dashboard.jsx` now
  only renders the panel when the viewer has at least one personal
  monitor, and `anySnoozed` is computed from personal monitors only
  too, so "Unsnooze all" doesn't appear based on an org monitor's
  snooze state that the button can't actually touch.

- **The dashboard's swipe-to-Snooze/Delete row missed the same
  treatment and has now had it applied.** The previous entry covered
  `MonitorDetail.jsx` and `StatusPagesView.jsx`, but `Dashboard.jsx`'s
  card-grid swipe actions (`GroupedMonitorList`) were left showing
  Snooze/Delete on every card regardless of role - a member could
  swipe any org monitor's card, including ones they didn't create,
  and see the exact same two buttons an owner would. Backend still
  rejected the actual request via `loadMonitorForMutation`, so nothing
  was ever exploitable, but the visible affordance was itself the bug:
  it looked like a member had owner/admin-level control from the list
  view. `Dashboard.jsx` now fetches `listOrganizations()` once (same
  pattern as `StatusPagesView.jsx`'s `orgRoles`) and computes
  `canManageMonitor()` per card - creator, or admin+ on the monitor's
  org - passing an empty `actions` array to `SwipeableRow` when it's
  false. `SwipeableRow.jsx` itself had a bug this exposed: its reveal
  width was a hardcoded 152px (two buttons) regardless of how many
  actions it was actually given, so an empty `actions` array would
  have opened onto 152px of visible dead space. It now sizes the
  reveal to `actions.length * 76`, and renders the card with no swipe
  wrapper at all when there are zero actions.

- **"Snooze all monitors" now covers org monitors an admin/owner
  manages, not just personal ones.** The previous scoping (`snooze-all`/
  `unsnooze-all` limited to `user_id = $1`) meant an admin whose
  monitors were entirely org-owned never saw the panel at all - it was
  gated on having at least one *personal* monitor, and even then only
  ever touched personal ones. Both routes in `monitors.js` now match
  `user_id = $1 OR organization_id IN (... role IN ('admin','owner'))`,
  and `Dashboard.jsx`'s panel visibility/eligibility (`manageableMonitors`,
  replacing the old `personalMonitors`) is computed with the same
  `canManageMonitor()` used for the swipe actions below, so a plain
  member still doesn't get this panel for monitors they don't manage.

- **Frontend now hides the actions a member's role blocks, instead of
  showing buttons that 403 on click.** The previous entry (member role
  enforcement) was backend-only - correct in that it actually stopped
  the action, but a member would still see Edit/Delete/Snooze/Regenerate/
  etc. looking fully clickable and only find out they couldn't use them
  after clicking. `MonitorDetail.jsx` now computes `canManage` (creator,
  or admin+ on the monitor's org) and hides exactly the buttons the
  backend would reject - Edit, Delete, the whole snooze panel, Rescan,
  DNS/certificate "Check now", event Acknowledge, and Regenerate/Revoke
  on the share link. Read-only things (viewing an existing share link
  and its badge, downloading a report) stay visible to everyone.
  `StatusPagesView.jsx` got the same treatment for its Edit/Delete/
  Regenerate buttons. Both compute this by calling `listOrganizations()`
  (or, for a single monitor, `getOrganization()`) to get the viewer's
  own role, and default to hiding the action if that hasn't resolved
  yet or fails - a brief flash of hidden buttons that then appear is a
  far better failure mode than the reverse. This is purely a
  display-layer mirror of the real server-side check from the previous
  entry, not new enforcement of its own - hiding a button here is about
  not showing someone an action they can't take, not what actually
  stops them from taking it.

- **Member role is now actually enforced on managing monitors and
  status pages, not just on org membership itself.** This closed the
  gap flagged in the original Tier 2 write-up: a plain member could
  previously see AND edit/delete/snooze/rescan/manage-sharing on any
  monitor in their org, which defeated the point of having roles at
  all - "member" and "admin" behaved identically everywhere except org
  management (invites, role changes, removal) and creating brand-new
  monitors.

  `monitors.js` gained `loadMonitorForMutation()`: every mutating route
  (PATCH, DELETE, snooze/unsnooze, security/DNS/certificate re-run,
  event acknowledgment, and all three share-link routes) now calls it
  first and gets a monitor row back only if the requester is either the
  monitor's own creator or admin+ on the org that owns it - otherwise a
  403, not a silent no-op. `statusPages.js` got the equivalent
  `loadStatusPageForMutation()` for its PATCH/regenerate/DELETE routes.
  Every read-only route (the list, checks, incidents, uptime, TLS/DNS/
  certificate data, etc.) is untouched - a member still sees everything
  and still gets paged for everything, which is the actual point of
  being on a team. Bulk actions (`snooze-all`, `unsnooze-all`, the
  manual "check now" button) were already scoped to a user's own
  monitors, personal ownership included, and didn't need this.

  This surfaced a real pre-existing bug while fixing it: the manual
  DNS/certificate re-check routes scoped their underlying sweep by
  `userId`, which would have silently matched zero rows (and done
  nothing) the moment an org admin who wasn't a monitor's creator tried
  to use them - `runDnsSweep`/`runCtSweep` in `checkRunner.js` gained a
  `monitorId` option that scopes by the specific monitor instead, which
  is what these two routes actually needed all along.

- **An existing monitor can now be moved into (or out of) an org.**
  Closes the gap where being added to an org didn't retroactively grant
  access to anything, since every monitor made before Tier 2 (or made
  without picking an org at creation) stayed personal forever with no
  way to change that. `PATCH /api/monitors/:id` now accepts
  `organization_id`, gated narrower than every other field on that
  route: only the monitor's own creator can move it at all (not just
  anyone with access via org membership), and moving it INTO an org
  additionally needs admin+ there - same bar as creating a new monitor
  under that org. `MonitorForm.jsx`'s "Owner" selector is no longer
  create-only; editing an existing monitor shows the same dropdown,
  pre-set to wherever it currently lives, and only sends the field if
  it actually changed. Status pages didn't get the same treatment yet -
  see "Known limitations" for why that's still open, not forgotten.

- **A pending org invite now bypasses `SIGNUP_CODE`.** These were two
  unrelated gates that had never been introduced to each other:
  `SIGNUP_CODE` exists to stop random strangers signing up for a
  publicly-deployed instance, and has nothing to do with org invites -
  it never got included in the invite email (deliberately, since
  broadcasting the site-wide code by email would defeat its own point),
  which meant an invited person had no way to know it and would just
  hit "invalid signup code" on the account they were specifically
  invited to create. Fixed in `POST /api/auth/signup`: a pending
  `organization_members` row (`invited_email` matching, `user_id` still
  NULL) is checked before the code comparison, and skips it if found -
  someone with admin+ access on an org already vouched for that exact
  address, which is a stronger signal than the shared code was ever
  standing in for. Signing up with no invite and no code still behaves
  exactly as before.

- **Invite emails now render an actual button, not a bare pasted URL.**
  `sendAlertEmail()` gained optional `actionUrl`/`actionLabel` params -
  when present, it sends `htmlContent` (a simple styled button) alongside
  the existing `textContent`, so clients that render HTML show a real
  "Sign up to join" / "Open Pulse" button and clients that don't still
  get the plain-text sentence with the link spelled out. Every other
  call site is untouched - those params are optional, and every other
  alert (down/degraded/security/etc.) has nothing actionable to link to
  anyway. Still needs `FRONTEND_URL` set to have anything to point the
  button at; without it the email correctly has no link at all rather
  than a broken one - this doesn't require owning a custom domain, a
  plain Vercel URL works fine as `FRONTEND_URL`.

- **Email switched from SMTP to Brevo's HTTP API.** `lib/mailer.js` used
  nodemailer over SMTP, which looked correctly configured (right host,
  port, credentials) but never actually worked once this app landed on
  a free Render web service: Render blocks all outbound traffic on SMTP
  ports (25, 465, 587) on free instances (since Sept 2025) specifically
  to stop them being used for spam - so nodemailer's connection attempt
  just hung until it timed out, completely independent of whether the
  SMTP setup itself was right. Every "Connection timeout" in the logs
  was that block, not a config mistake.

  Replaced with a plain HTTPS POST to Brevo's transactional email API
  (`https://api.brevo.com/v3/smtp/email`) - same reasoning as
  lib/telegram.js and lib/webhook.js, a fetch call needs no SDK. HTTPS
  on port 443 isn't part of Render's block, so this works identically on
  a free instance. `sendAlertEmail({ to, subject, text })` kept the exact
  same signature, so every call site across the app (checkRunner.js,
  digest.js, securityEvents.js, breachCheck.js, organizations.js) needed
  no changes at all. Needs `BREVO_API_KEY` and `EMAIL_FROM` (a sender
  address verified in Brevo's dashboard) - the old `SMTP_*` vars can be
  removed from Render, they're no longer read anywhere.

- **Org invites now actually send an email, and logos can be uploaded
  instead of just linked.** Two gaps found in real use of Tier 2.

  The invite endpoint (`POST /api/organizations/:id/invite`) wrote the
  membership/pending-invite row and stopped there - nothing ever told
  the invitee. It now sends an email via the existing `sendAlertEmail`
  (silently a no-op without SMTP configured, same as every other email
  in this app) telling them who invited them, to which org, and what to
  do next - log in if they already have an account, or sign up with
  that exact address if they don't. An optional `FRONTEND_URL` env var
  makes that instruction a clickable link; without it the email still
  says what to do, just without a URL to hand out. A pending invite
  created before this change won't retroactively get an email - cancel
  and re-send it from the org's Manage panel if the person needs it.

  The first version of this awaited the email send before responding -
  which turned the invite request itself into a 15-second-timeout risk,
  since nodemailer can hang well past that on a slow or misconfigured
  SMTP server (wrong host/port, network egress blocked, auth failing
  slowly). Fixed by not awaiting it: the response goes back the instant
  the membership row is written, and the email fires in the background
  with its own `.catch` so a slow or failing send can't affect the
  invite itself. That fixed the timeout, but not delivery itself - see
  the "Email switched from SMTP to Brevo" entry above for why SMTP
  couldn't actually work on this deployment at all.

  Also added: an invited person who already has a Pulse account gets
  notified on their own already-connected Telegram and/or webhook, not
  just email - reusing `sendTelegramMessage`/`sendWebhookAlert` exactly
  as every alert path does, since those already no-op safely when
  nothing's configured. This only works for existing accounts - a
  brand-new invitee has no telegram_chat_id or webhook_url yet, since
  those are things a person connects themselves after signing in, so
  email is the only channel Pulse has for someone who isn't a user yet.

  Logo upload: there's no file-storage backend in this app (no
  S3/Cloudinary, and Render's own disk isn't persistent across deploys
  anyway), so rather than build one, `OrganizationsPanel.jsx` downscales
  the chosen image to 200px on the long side and re-encodes it
  client-side into a `data:` URL, stored in the same
  `organizations.brand_logo_url` column a pasted hosted URL would have
  gone into - nothing downstream had to change, since an `<img src>`
  doesn't care whether the scheme is `https:` or `data:`. This did
  surface a real ceiling: the API's global body limit is a deliberate
  64kb (see the comment above `express.json` in `index.js`), sized for
  the largest *previously* legitimate payload - a monitor with a
  handful of synthetic steps. A base64-encoded logo comfortably exceeds
  that, so `/api/organizations` now gets its own `express.json({ limit:
  "1mb" })` registered ahead of the global one, rather than raising the
  ceiling for every other endpoint.

- **Tier 2 of the security-suite roadmap: teams, white-label branding,
  trend dashboard, trust badge.** All four items from the "turns this
  into something resellable" tier below, now built.

  **Teams/multi-tenant.** New `organizations` / `organization_members` /
  `org_audit_log` tables, fully additive - `monitors.organization_id`
  and `status_pages.organization_id` are nullable, so every account
  keeps working exactly as before without ever creating an org.
  `lib/orgAccess.js` holds the role model (owner > admin > member) and,
  most importantly, `getNotifiableUsers()` - the function every alert
  site now calls instead of looking up `monitor.user_id` directly, so an
  org-owned monitor pages every member, not just whoever created it.
  That fan-out is wired into all seven alert functions in
  `checkRunner.js`, `notifySecurityEvent()`, and the digest sweep.
  Ownership checks across `monitors.js` (22 queries) and
  `statusPages.js` were broadened with an `OR organization_id IN (...)`
  clause rather than replaced, so the personal-monitor code path is
  untouched. `routes/organizations.js` covers create/rename/delete,
  invite-by-email (with a pending-invite row for addresses that don't
  have an account yet, claimed automatically at signup - see
  `claimPendingInvites`), role changes, and member removal, each with a
  guard against leaving an org with zero owners. Settings has a full
  `OrganizationsPanel.jsx` for all of it, and monitor/status-page
  creation forms gained an "Owner: just me / org" selector.

  **Scoped deliberately, not an oversight:** any accepted member can
  edit or delete an *existing* org monitor today - role is only
  enforced at creation (needs admin+) and on org management itself
  (invites, role changes, removal), not on every mutation of a monitor
  that already belongs to an org. Extending that is a small change (the
  broadened access clause already distinguishes membership; it would
  just need a role-aware variant on the edit/delete routes) but wasn't
  done here to keep this change's blast radius contained given how many
  endpoints touch monitor ownership. Also: an existing monitor can't be
  moved between personal and org ownership after creation - only set at
  creation time.

  **White-label branding.** `organizations` carries `brand_name`,
  `brand_logo_url`, `brand_accent_color`, `custom_domain`. Applied to
  both public share views (`SharedMonitorView.jsx`,
  `SharedStatusPageView.jsx` - logo/name in the header, accent color on
  the status badge, "Powered by Pulse" suppressed once a brand name is
  set) and the downloadable text report (`Generated by {brand_name}`
  instead of "Generated by Pulse"). `custom_domain` is a stored field
  only - typing one in doesn't route anything. Actually serving a
  client's own domain still needs a CNAME on their end and host
  routing/TLS on this app's end, neither of which this column
  automates; it's a reminder of the setup, not the setup itself.

  **Trend dashboard.** `SecurityTrendChart.jsx`, a recharts line chart
  of score-over-time, dropped into `MonitorDetail.jsx` right under the
  existing scan panel. No new backend endpoint - it reuses the same
  `security/history` data the panel above it already fetches.

  **Embeddable trust badge.** `GET /api/public/monitors/:token/badge.svg`
  renders a shields.io-style SVG (grade + 30-day uptime) straight from
  share-token-scoped data, so it can never expose more than an
  unauthenticated visitor already could. The monitor's share section now
  shows the rendered badge plus a copyable `<img>`/`<a>` snippet.

- **Tier 1 of the security-suite roadmap: webhooks, 2FA, blacklist
  checks, breach monitoring.** All four items from the "cheap, closes
  real gaps" tier below, now built rather than proposed.

  **Generic webhooks.** `lib/webhook.js` is one plain `fetch` POST, same
  shape as `lib/telegram.js`. `notification_prefs` gained a third
  channel (`webhook`, defaults live in `lib/notificationPrefs.js` - no
  migration needed for that part) alongside push and Telegram, wired
  into every alert site that already had those two: all seven functions
  in `checkRunner.js` and `notifySecurityEvent()` in
  `securityEvents.js`. Configured per-user via `users.webhook_url`
  (Settings -> Webhook alerts), with a "Send test" button
  (`POST /api/auth/webhook-test`) since a user-typed URL has no other
  "is this actually working" signal the way Telegram's bot-configured
  check does.

  **2FA (TOTP).** `lib/totp.js` implements RFC 6238 directly on Node's
  `crypto` - no dependency, same reasoning as the webhook and rate-limit
  code. Setup is a two-step flow (`POST /2fa/setup` generates a secret
  into `totp_pending_secret`; `POST /2fa/confirm` verifies a code before
  it becomes the live `totp_secret` and hands back one-time backup
  codes, bcrypt-hashed at rest like a password). Login checks
  `totp_enabled` and, if set, holds the session at
  `pendingTotpUserId` (deliberately not `userId`, so `requireAuth` can't
  mistake it for a real session) until `POST /2fa/verify-login` accepts
  either a live code or a backup code. No QR image is rendered
  (no new dependency for it) - the setup screen shows the secret and the
  `otpauth://` URI for manual entry instead.

  **Blacklist / malware reputation.** `lib/blacklistCheck.js` calls
  Google Safe Browsing's `threatMatches:find`, folded into the existing
  daily scan sweep in `scanAndRecord()` rather than its own schedule.
  Result lands on `monitors.blacklist_status` /
  `blacklist_threats` / `blacklist_checked_at`; a flip to `flagged`
  raises a `critical` `security_events` row the same way a scan
  regression does, deduped on the sorted threat-type list so it doesn't
  renotify every day while still flagged. Skipped entirely (columns stay
  `NULL`) without `GOOGLE_SAFE_BROWSING_API_KEY` set.

  **Breach exposure monitoring.** `lib/breachCheck.js` checks the
  account's own alert email against HaveIBeenPwned on the same
  weekly-cadence-clock shape as the digest (`breach_checked_at` /
  `breach_monitoring_enabled`, opt-in and off by default). Doesn't use
  `security_events` - that table is keyed to a `monitor_id` and a breach
  isn't about any one monitor - so the last-known result lives directly
  on the user row (`breach_last_result`) and a genuinely new breach
  notifies over whatever channels are already on (push/email/
  Telegram/webhook). The very first check for an account establishes the
  baseline without alerting, same as CT logs' first sweep. Needs
  `HIBP_API_KEY`; the sweep is a no-op without one.

- **Security suite: scoring, regressions, TLS/DNS/CT posture, auth
  assertions.** The largest change since the original scanner port, and
  it's less "more checks" than a change in what the feature *is*: a
  scanner answers "how is this configured right now," a monitor answers
  "what changed, and when." Everything below serves the second question,
  because that's the one the rest of this app already answers for uptime.

  **Two bugs in the ported scanner, fixed first.** (1) Header checks used
  `headers.has()`, so a `Content-Security-Policy: default-src *` and a
  `Strict-Transport-Security: max-age=1` both passed. Those are worse
  than no finding, because they read green while providing nothing. Every
  header is now graded on its value. (2) Exposed-path checks treated any
  HTTP 200 as "this file is public," which is wrong for every SPA - a
  React app on Vercel serves index.html with a 200 for `/.env`,
  `/.git/config` and every other path that doesn't exist, so healthy
  sites scored zero on four checks. Paths are now judged against a
  soft-404 baseline (fetch a random path first, fingerprint the
  response), a content signature (an `.env` finding needs a body that
  actually looks like `KEY=VALUE`), and a content-type gate (an HTML
  response can never be a real `.env`, `.sql` dump or JSON config).
  That last rule was added after live testing found two false positives
  of exactly the class this was meant to prevent: `github.com/swagger-ui.html`
  is a real 200 profile page for a user named "swagger-ui", and
  `github.com/graphql?query=...` echoes the query string into a meta tag,
  so the naive "does `__schema` appear in the body" test read a normal
  404-ish page as a live introspection endpoint. GraphQL detection now
  requires a JSON response that parses with a populated `data.__schema`.

  **Severity weighting** (`lib/severity.js`) replaces pass/total scoring.
  Critical is worth 10x a low finding, INFO findings are reported but
  never scored, and any critical failure forces the grade to F - a number
  that can show 85/100 while `.env` is world-readable is a number that
  tracks check count rather than risk, and adding cosmetic checks would
  mechanically dilute the serious ones.

  **Regression detection.** `security_scans` already kept history; it was
  just never read. `scanAndRecord()` in `checkRunner.js` now diffs each
  scan against the previous one and records an event per check that flipped
  pass -> fail. A check present only in the newer scan is deliberately
  *not* a regression - otherwise the first scan after any Pulse upgrade
  would tell every user their site got worse, and the alert would never
  be trusted again. The manual "Rescan now" route goes through the same
  function rather than its own copy, so an on-demand scan can't silently
  skip the diffing.

  **`security_events`, one table for every detector.** Six near-identical
  alert functions in `checkRunner.js` were already a pattern worth not
  repeating five more times, so detections go through
  `lib/securityEvents.js` instead: it writes the row, decides whether the
  severity is worth notifying (medium and up; a missing Permissions-Policy
  is never worth a phone buzzing at 2am), and sends over the same three
  channels as every other alert. Throttling lives there too, keyed on a
  caller-supplied dedupe key and checked *against the table* rather than
  an in-process cache - Render restarts this service constantly, and an
  in-memory throttle would leak a duplicate notification on every
  redeploy.

  **TLS posture** (`lib/certCheck.js`). `getTlsPosture()` replaces
  `getSslExpiry()` internally (the old signature is kept as a thin wrapper,
  since the digest and expiry alert only ever wanted the date). It reads
  protocol, cipher, key size, SANs with wildcard-aware hostname matching,
  chain length, trust status and the SHA-256 fingerprint - all of it
  already sitting on the socket the expiry-only version was discarding.
  `rejectUnauthorized: false` is deliberate: an expired or self-signed
  certificate is precisely what this should *report*, and refusing the
  connection would turn the most interesting findings into a bare
  "handshake failed". Fingerprint changes alert, with severity depending
  on whether the issuer also changed - same issuer is a renewal, different
  issuer on a domain you didn't move is worth looking at immediately.
  First fingerprint seen is a baseline, never an alert, same as
  `content_hash`.

  **DNS posture and drift** (`lib/dnsCheck.js`, `node:dns/promises`, no new
  dependency). Snapshots the records every 6 hours, diffs against the
  previous snapshot, grades SPF/DMARC/CAA/NS, and detects dangling CNAMEs
  across 8 platforms. The distinction that matters here: a lookup that
  *fails* (timeout, SERVFAIL) is tracked separately from one that comes
  back empty (ENODATA/ENOTFOUND), and only the second is ever graded or
  diffed. Live testing caught this - the sandbox couldn't resolve TXT, and
  the first version confidently reported "no SPF record" for a domain
  that has one. A transient resolver failure must never read as "your
  nameservers were removed".

  **Certificate Transparency** (`lib/ctLogs.js`, crt.sh). Alerts on
  certificates issued for the domain, with severity depending on whether
  that CA has issued for you before. Two rules keep it quiet: the first
  sweep for a monitor imports the whole current certificate history as a
  baseline without alerting, and only certificates issued in the last 7
  days can alert - a cert we've never seen but which was issued eight
  months ago is a gap in *our* records, not an issuance event. The
  subdomain inventory falls out of the same data and is the part likely
  to earn its keep fastest: `GET /:id/certificates` returns every
  hostname seen, flagged by whether you already monitor it, with
  one-click "monitor this too". This is the only feature here that
  queries a third party, hence the per-monitor `ct_enabled` switch and
  the most conservative sweep cadence of the lot.

  **Auth-required assertions** (`lib/authProbe.js`). Opt-in per monitor.
  Sends the monitor's own request minus the credential and asserts the
  server refuses it. `redirect: "manual"` matters - a 302 to /login is a
  perfectly good refusal, and following it would turn that into a
  misleading 200 from the login page. A network failure is explicitly
  *inconclusive* and never alerts; only a repeated failure (there's a
  retry, same reasoning as `runHttpCheck`) counts. Runs on the normal
  check cadence rather than the daily security sweep, which costs one
  extra request per interval for the monitors that enable it - justified
  because an endpoint that lost its authentication is the most expensive
  thing this app can detect, and finding out 24 hours later is barely
  better than not finding out.

  **Scope note, stated plainly:** every check added here is passive,
  outside-in observation of infrastructure the user owns or is engaged to
  monitor. Nothing exploits, submits, authenticates, guesses a credential,
  or port-scans an arbitrary host. That line was already drawn
  deliberately in this file (see the auto-fix idea below) and it's the
  reason this tool can be pointed at a client's production site without a
  conversation first.

- **Pulse's own hardening.** An app that hands clients a report scoring
  their security posture should pass its own scan, and the first thing a
  technical client does with a security report is point the tool at the
  tool. Login and signup are rate limited
  (`middleware/rateLimit.js`), security headers are set on every response
  (`middleware/securityHeaders.js`), `x-powered-by` is disabled, and the
  JSON body limit is 64kb.

  The limiter is written rather than pulled from `express-rate-limit`,
  same reasoning as `lib/telegram.js` being a plain fetch: the dependency's
  real value is its store adapters, which don't apply. It's backed by
  Postgres rather than process memory for a specific reason - Render's
  free tier restarts this service constantly (it's why the keep-alive
  feature exists at all), and an in-memory counter resets to zero on every
  restart, which is a lockout an attacker can simply wait out while being
  strictest against the honest user who got unlucky with a redeploy. Two
  buckets are counted independently: client IP (stops one source spraying
  many accounts) and submitted email (stops a distributed attempt at one
  account). Only *failures* count, so logging in successfully all day
  never trips it. It fails **open** if the database is unreachable -
  a limiter that failed closed would lock everyone out of their own
  monitoring the moment Postgres hiccuped, and this is defence in depth
  on top of bcrypt, not the only thing between an attacker and an account.

  The login response is also now identical whether the email exists or
  not, so the endpoint can't be used to enumerate which addresses have
  accounts.


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

### Security-suite roadmap (proposed, not built)

Ranked by cost vs. impact. Nothing here crosses the "passive, outside-in,
no exploitation" line the scanner already draws deliberately - see the
scope note above. Anything that would need Pulse to authenticate as the
user or actively probe beyond what an anonymous visitor could do is
called out explicitly as its own opt-in surface, not folded into the
default suite.

**Cheap, closes real gaps: shipped, see "Recent changes" above.**

- ~~Generic webhooks~~ - done (`lib/webhook.js`).
- ~~2FA (TOTP) on the Pulse account itself~~ - done (`lib/totp.js`).
- ~~Blacklist/reputation checks~~ - done via Google Safe Browsing
  (`lib/blacklistCheck.js`); PhishTank wasn't added, still an option if
  Safe Browsing's coverage ever proves too narrow.
- ~~Breach exposure monitoring~~ - done via HaveIBeenPwned
  (`lib/breachCheck.js`), against the account's own alert email rather
  than a per-monitor admin contact (Pulse doesn't collect the latter).

**Turns this into something resellable to agencies/clients: shipped, see
"Recent changes" above.**

- ~~Teams/multi-tenant with roles~~ - done (`lib/orgAccess.js`,
  `routes/organizations.js`). The "scoped deliberately" gap noted above
  (member could edit/delete an existing org monitor) was closed in a
  later pass - see "Member role is now actually enforced..." further up.
- ~~White-labeled client reports & branded status pages~~ - done;
  `custom_domain` is a stored reminder field, not actual DNS/routing
  automation.
- ~~Trend/history dashboard~~ - done (`SecurityTrendChart.jsx`).
- ~~Embeddable trust badge~~ - done (`/api/public/monitors/:token/badge.svg`).

**More effort, real differentiation:**

- **Remediation guidance per finding.** Each finding has a severity;
  add a short "how to fix" (exact header value, DNS record to add). Turns
  a report into a checklist instead of homework.
- **Client-side secret scanning.** Passively parse served JS bundles for
  exposed API keys/tokens (regex against known key shapes - Stripe, AWS,
  Firebase, etc.). Still passive - reading what's already served - so it
  stays inside the existing scope line.
- **CSP violation ingestion endpoint.** Let a monitored site point its
  `report-uri`/`report-to` at Pulse and passively collect real violations
  instead of only inferring risk from the header value.
- **Scheduled authenticated deep-scans, opt-in per monitor.** Everything
  today is unauthenticated/outside-in by design, which is itself a
  selling point ("safe to point at a client's prod site without asking
  first"). Deeper coverage - authenticated endpoint enumeration,
  business-logic checks - would need its own explicit consent flow, kept
  separate from the default suite so that guarantee never gets
  compromised for existing monitors.
