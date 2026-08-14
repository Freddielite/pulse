import crypto from "node:crypto";

const DEFAULT_CHECK_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 4000;
export const CONTENT_HASH_VERSION = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Strips a raw HTML response down to just its visible text before
// hashing for content-diff monitoring. A raw-body hash (v1) changes on
// every check for most real frontends even when nothing a visitor would
// notice actually changed - a Vite/webpack build-hashed asset filename,
// an inline CSRF token, a request-id meta tag, a "generated at" comment.
// None of that is content; hashing only the visible text ignores it, so
// the alert fires for actual copy/layout changes instead of every
// deploy or every request. Deliberately regex-based rather than pulling
// in an HTML parser - this only needs to be good enough to strip tags
// and boilerplate, not to handle malformed markup correctly, and it
// keeps the free-tier backend's dependency list and memory footprint
// small (same reasoning as skipping a headless browser in
// syntheticCheck.js).
function extractVisibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// One outcome shape for every caller: never throws, always resolves with
// { status, statusCode, responseMs, errorMessage, contentHash }, so the
// tick loop can treat a network failure and a wrong status code the same
// way. contentHash is only ever non-null when the check passed and the
// monitor has content-diff monitoring on, and is always computed with
// the current CONTENT_HASH_VERSION scheme (extractVisibleText below) -
// see checkRunner.js for what it does with it.
async function runSingleAttempt(monitor) {
  // check_timeout_sec is per-monitor (see db.js) - falls back to the old
  // fixed default for any row from before that column existed, or if it's
  // ever null for some other reason.
  const timeoutMs = (monitor.check_timeout_sec || DEFAULT_CHECK_TIMEOUT_MS / 1000) * 1000;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {};
  if (monitor.auth_header_name && monitor.auth_header_value) {
    headers[monitor.auth_header_name] = monitor.auth_header_value;
  }

  try {
    const response = await fetch(monitor.url, {
      method: monitor.method || "GET",
      headers,
      signal: controller.signal,
      redirect: "follow",
    });

    let up = response.status === monitor.expected_status;
    let errorMessage = up ? null : `Expected ${monitor.expected_status}, got ${response.status}`;
    let contentHash = null;

    // Only read the body when there's something to check for, and only
    // when the status already passed - no point paying for a body read
    // (or risking it hang) on a check that's already failing. One read
    // serves both body_contains and the content-diff hash below, rather
    // than reading the body twice for a monitor that has both on.
    if (up && (monitor.body_contains || monitor.content_diff_enabled)) {
      try {
        const bodyText = await response.text();
        if (monitor.body_contains && !bodyText.includes(monitor.body_contains)) {
          up = false;
          errorMessage = `Response did not contain expected text: "${monitor.body_contains}"`;
        }
        if (up && monitor.content_diff_enabled) {
          contentHash = crypto.createHash("sha256").update(extractVisibleText(bodyText)).digest("hex");
        }
      } catch (bodyErr) {
        up = false;
        errorMessage = `Could not read response body: ${bodyErr.message}`;
      }
    }

    const responseMs = Date.now() - start;
    return {
      status: up ? "up" : "down",
      statusCode: response.status,
      responseMs,
      errorMessage,
      contentHash,
    };
  } catch (err) {
    const responseMs = Date.now() - start;
    // Node's fetch throws a generic "fetch failed" for any connection-level
    // problem (DNS failure, connection refused, TLS error, etc.) and puts
    // the actually useful detail on err.cause instead of the message. For
    // a tool whose entire job is telling the person what went wrong, the
    // bare "fetch failed" is close to useless, so surface the cause too
    // whenever there is one.
    let errorMessage;
    if (err.name === "AbortError") {
      errorMessage = `Timed out after ${timeoutMs / 1000}s`;
    } else if (err.cause?.message) {
      errorMessage = `${err.message}: ${err.cause.message}`;
    } else {
      errorMessage = err.message;
    }
    return { status: "down", statusCode: null, responseMs, errorMessage, contentHash: null };
  } finally {
    clearTimeout(timer);
  }
}

// A single failed attempt gets one retry, after a short delay, before it's
// allowed to count as "down". This exists specifically because a fair
// amount of what this app watches is Render/Vercel free-tier infrastructure,
// where a transient blip (mid-cold-start connection refusal, a dropped
// packet) is common and self-resolves in seconds - without a retry, every
// one of those blips would open an incident and fire a push + email alert
// for something that was never actually a real outage. The first attempt's
// timing/response fields are discarded on retry; only the attempt that
// decided the final verdict is returned, so the checks table stays a
// record of "was it actually up or down", not a log of retry mechanics.
export async function runHttpCheck(monitor) {
  const first = await runSingleAttempt(monitor);
  if (first.status === "up") return first;

  await sleep(RETRY_DELAY_MS);
  const second = await runSingleAttempt(monitor);
  return second;
}
