const CHECK_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One outcome shape for every caller: never throws, always resolves with
// { status, statusCode, responseMs, errorMessage }, so the tick loop can
// treat a network failure and a wrong status code the same way.
async function runSingleAttempt(monitor) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

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

    // Only read the body when there's something to check for, and only
    // when the status already passed - no point paying for a body read
    // (or risking it hang) on a check that's already failing.
    if (up && monitor.body_contains) {
      try {
        const bodyText = await response.text();
        if (!bodyText.includes(monitor.body_contains)) {
          up = false;
          errorMessage = `Response did not contain expected text: "${monitor.body_contains}"`;
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
      errorMessage = `Timed out after ${CHECK_TIMEOUT_MS / 1000}s`;
    } else if (err.cause?.message) {
      errorMessage = `${err.message}: ${err.cause.message}`;
    } else {
      errorMessage = err.message;
    }
    return { status: "down", statusCode: null, responseMs, errorMessage };
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
