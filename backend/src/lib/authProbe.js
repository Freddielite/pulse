// Auth-negative assertion.
//
// Every check in this app so far asks "does this endpoint work?" This one
// asks the inverse: "does this endpoint still refuse people who aren't
// logged in?"
//
// That's the question nothing else here answers, and it's the one that
// catches the genuinely expensive bug - an endpoint shipped with the auth
// middleware missing, a route moved out from behind a guard during a
// refactor, a `requireAuth` accidentally deleted along with the line above
// it. Every existing check goes green for that deploy, because the
// endpoint does respond, quickly, with a 200 and valid data. It's just
// serving that data to everyone.
//
// The probe is deliberately the narrowest possible test: send the same
// request the monitor already sends, minus the credential, and assert the
// server says no. It never tries to guess a credential, never submits
// anything, and never touches an endpoint the user hasn't explicitly
// pointed it at and opted in for.

import { assertPublicHttpUrl } from "./urlSafety.js";

const RETRY_DELAY_MS = 3000;
const DEFAULT_ACCEPTED = [401, 403];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseAcceptedStatuses(raw) {
  if (!raw) return DEFAULT_ACCEPTED;
  const parsed = String(raw)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599);
  return parsed.length > 0 ? parsed : DEFAULT_ACCEPTED;
}

async function probeOnce(monitor, accepted) {
  const timeoutMs = (monitor.check_timeout_sec || 15) * 1000;
  // Same re-check-every-time reasoning as httpCheck.js - this is a
  // separate outbound request on its own code path, not something that
  // inherits whatever httpCheck.js already checked this cycle.
  try {
    await assertPublicHttpUrl(monitor.url);
  } catch (err) {
    return { verdict: "inconclusive", statusCode: null, detail: `Couldn't complete the probe: ${err.message}` };
  }
  try {
    const response = await fetch(monitor.url, {
      method: monitor.method || "GET",
      // The entire point: no auth header, and Pulse never carries cookies
      // between requests anyway, so this is a genuinely anonymous request.
      // redirect: "manual" matters - a login redirect (302 to /login) is a
      // perfectly good way to refuse an anonymous request, and following
      // it would turn that into a misleading 200 from the login page.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "PulseSecurityScan/1.0 (+auth-required assertion configured by the site owner)" },
    });

    const status = response.status;
    if (accepted.includes(status)) {
      return { verdict: "pass", statusCode: status, detail: `Anonymous request was refused with HTTP ${status}.` };
    }

    // A redirect to something that looks like a login page is the other
    // legitimate way to refuse, and it's what most session-cookie apps
    // actually do. Treated as a pass, but reported honestly as a
    // redirect rather than silently counted as a 401.
    if (status >= 300 && status < 400) {
      const location = response.headers.get("location") || "";
      if (/login|signin|sign-in|auth/i.test(location)) {
        return { verdict: "pass", statusCode: status, detail: `Anonymous request was redirected to a login page (${status} -> ${location}).` };
      }
      return {
        verdict: "fail",
        statusCode: status,
        detail: `Anonymous request was redirected (${status} -> ${location || "no location header"}), which isn't one of the accepted refusal statuses (${accepted.join(", ")}) and doesn't look like a login redirect.`,
      };
    }

    return {
      verdict: "fail",
      statusCode: status,
      detail: `This endpoint answered an unauthenticated request with HTTP ${status} instead of refusing it (${accepted.join(" or ")}). If it's meant to be protected, it currently isn't - anyone can call it.`,
    };
  } catch (err) {
    // A network failure tells us nothing about the auth configuration.
    // Reporting it either way would be wrong, so it's explicitly
    // inconclusive and never alerts.
    return { verdict: "inconclusive", statusCode: null, detail: `Couldn't complete the probe: ${err.message}` };
  }
}

export async function runAuthProbe(monitor) {
  const accepted = parseAcceptedStatuses(monitor.auth_probe_expect);
  const first = await probeOnce(monitor, accepted);
  // Same reasoning as runHttpCheck's single retry: one transient blip
  // shouldn't be enough to claim an endpoint lost its authentication.
  // Only a repeated failure counts.
  if (first.verdict !== "fail") return first;

  await sleep(RETRY_DELAY_MS);
  return probeOnce(monitor, accepted);
}
