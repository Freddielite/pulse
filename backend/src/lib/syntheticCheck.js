const STEP_TIMEOUT_MS = 15000;

// Substitutes {{varName}} in a string with a value captured by an
// earlier step's `extract`. Left untouched if the variable was never
// set (a bad/missing extract on step 1 then surfaces as a normal step-2
// failure - a literal "{{sessionId}}" in the URL - rather than silently
// requesting a broken URL with no explanation).
function substitute(str, vars) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{(\w+)\}\}/g, (match, name) => (name in vars ? vars[name] : match));
}

// Runs a short, ordered sequence of HTTP requests, carrying cookies and
// named variables forward from one step to the next - deliberately not a
// full headless-browser flow. There's no JS execution or client-side
// rendering here, so it can't catch "the page loads but React crashes
// before rendering" the way a real browser check would. What it does
// cover: the "hit an endpoint, follow a redirect or cookie session, hit
// a second endpoint, assert on the result" shape - a login-gated health
// check or a multi-hop API flow - which is most of what "returns 200 but
// is actually broken" means for a typical backend, at a fraction of the
// operational weight (memory, cold-start time, OS deps) of running a
// browser engine on a free-tier instance.
export async function runSyntheticCheck(monitor) {
  const steps = Array.isArray(monitor.synthetic_steps) ? monitor.synthetic_steps : [];
  if (steps.length === 0) {
    return { status: "down", statusCode: null, responseMs: 0, errorMessage: "No steps configured for this synthetic check.", contentHash: null };
  }

  const start = Date.now();
  let cookies = {}; // name -> value, replayed as one Cookie header on every later step
  const vars = {};
  let lastStatusCode = null;

  const authHeaders = {};
  if (monitor.auth_header_name && monitor.auth_header_value) {
    authHeaders[monitor.auth_header_name] = monitor.auth_header_value;
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepLabel = `Step ${i + 1} (${step.method || "GET"} ${step.url})`;
    const url = substitute(step.url, vars);
    const body = step.body != null && step.body !== "" ? substitute(step.body, vars) : undefined;
    const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method: step.method || "GET",
        headers: { ...authHeaders, ...(cookieHeader ? { Cookie: cookieHeader } : {}) },
        body,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (err) {
      const responseMs = Date.now() - start;
      const detail =
        err.name === "AbortError" ? `timed out after ${STEP_TIMEOUT_MS / 1000}s` : err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message;
      return { status: "down", statusCode: lastStatusCode, responseMs, errorMessage: `${stepLabel}: ${detail}`, contentHash: null };
    } finally {
      clearTimeout(timer);
    }
    lastStatusCode = response.status;

    // fetch's Headers.get("set-cookie") joins multiple cookies into one
    // unparseable string; getSetCookie() (Node 18.14+ / undici) is what
    // actually returns them as a list, which a login response setting
    // more than one cookie (session id + CSRF, say) needs.
    const setCookieValues =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : response.headers.get("set-cookie")
          ? [response.headers.get("set-cookie")]
          : [];
    for (const raw of setCookieValues) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }

    const expectedStatus = step.expected_status || 200;
    if (response.status !== expectedStatus) {
      const responseMs = Date.now() - start;
      return { status: "down", statusCode: response.status, responseMs, errorMessage: `${stepLabel}: expected ${expectedStatus}, got ${response.status}`, contentHash: null };
    }

    let bodyText = null;
    if (step.body_contains || step.extract?.regex) {
      try {
        bodyText = await response.text();
      } catch (err) {
        const responseMs = Date.now() - start;
        return { status: "down", statusCode: response.status, responseMs, errorMessage: `${stepLabel}: could not read response body: ${err.message}`, contentHash: null };
      }
    }

    if (step.body_contains && bodyText != null && !bodyText.includes(step.body_contains)) {
      const responseMs = Date.now() - start;
      return { status: "down", statusCode: response.status, responseMs, errorMessage: `${stepLabel}: response did not contain expected text: "${step.body_contains}"`, contentHash: null };
    }

    if (step.extract?.name && step.extract?.regex && bodyText != null) {
      try {
        const match = bodyText.match(new RegExp(step.extract.regex));
        if (match) vars[step.extract.name] = match[1] ?? match[0];
      } catch {
        // A malformed regex shouldn't fail the whole check on the spot -
        // it just leaves that variable unset, and whichever later step
        // actually needed it fails explicitly with its own clear "step N"
        // message instead of this step throwing on a config typo.
      }
    }
  }

  const responseMs = Date.now() - start;
  return { status: "up", statusCode: lastStatusCode, responseMs, errorMessage: null, contentHash: null };
}
