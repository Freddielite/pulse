import net from "node:net";

const DEFAULT_CHECK_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A tcp:// monitor's url is "tcp://host:port" - parsed the same way an
// http(s) url would be, just with a scheme fetch() would never accept.
// Pulled out to its own export since routes/monitors.js needs this at
// save time too (to reject a tcp monitor with no port before it's ever
// stored), not only here at check time.
export function parseTcpTarget(url) {
  const parsed = new URL(url);
  return { hostname: parsed.hostname, port: Number(parsed.port) };
}

// Same outcome shape every other check type returns: { status,
// statusCode, responseMs, errorMessage, contentHash }. statusCode and
// contentHash are always null here - there's no HTTP response to have
// either of. A pass is just "a TCP connection to host:port completed
// within the timeout"; nothing about what's actually listening there
// (a database, a message queue, whatever) is inspected, since not
// caring what's on the other end is exactly what makes this usable for
// non-HTTP services instead of only web endpoints.
async function runSingleAttempt(monitor) {
  const timeoutMs = (monitor.check_timeout_sec || DEFAULT_CHECK_TIMEOUT_MS / 1000) * 1000;
  const start = Date.now();
  const { hostname, port } = parseTcpTarget(monitor.url);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (status, errorMessage) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ status, statusCode: null, responseMs: Date.now() - start, errorMessage, contentHash: null });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("up", null));
    socket.once("timeout", () => finish("down", `Timed out after ${timeoutMs / 1000}s connecting to ${hostname}:${port}`));
    // Covers connection refused, DNS failure, host unreachable, etc. -
    // net.Socket's own error message is already specific enough (e.g.
    // "connect ECONNREFUSED 1.2.3.4:5432") to be useful as-is.
    socket.once("error", (err) => finish("down", err.message));
    socket.connect(port, hostname);
  });
}

// Same one-retry-before-it-counts shape as httpCheck.js's runHttpCheck,
// for the same reason: a transient connection blip on Render/Vercel-class
// infrastructure shouldn't open an incident and fire alerts on its own.
export async function runTcpCheck(monitor) {
  const first = await runSingleAttempt(monitor);
  if (first.status === "up") return first;

  await sleep(RETRY_DELAY_MS);
  return runSingleAttempt(monitor);
}
