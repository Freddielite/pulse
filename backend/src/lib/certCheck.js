import tls from "node:tls";
import { lookup as whoisLookup } from "whois";

// Reads the peer certificate's expiry off a plain TLS handshake. This is
// the actual cert the browser would see, not a WHOIS record, so it's exact.
export function getSslExpiry(hostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: hostname, port: 443, servername: hostname, timeout: 10000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) return reject(new Error("no certificate returned"));
        resolve(new Date(cert.valid_to));
      }
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("TLS handshake timed out"));
    });
  });
}

// Registrar WHOIS records have no standard format, so this is deliberately
// best-effort: try the handful of field names that cover the overwhelming
// majority of registrars/TLDs, and give up cleanly (rather than guess) if
// none match. Callers should treat a null result as "unknown", not "never
// expires".
const EXPIRY_PATTERNS = [
  /Registry Expiry Date:\s*(.+)/i,
  /Registrar Registration Expiration Date:\s*(.+)/i,
  /Expiration(?: Date| Time)?:\s*(.+)/i,
  /Domain Expiration Date:\s*(.+)/i,
  /Expiry Date:\s*(.+)/i,
  /paid-till:\s*(.+)/i,
  /renewal date:\s*(.+)/i,
  // .jp (JPRS) wraps the label in brackets on its own line, e.g.
  // "[Expires on]                    2027/01/01".
  /\[Expires on\]\s*(.+)/i,
  // A few registries (some .cn resellers, older whois clients) send a
  // bare "expires:" with no other qualifier.
  /^expires:\s*(.+)/im,
];

// Normalizes the handful of non-ISO date shapes that show up often enough
// to be worth handling explicitly (new Date() alone chokes on some of
// these depending on the JS engine) - "2027/01/01" and "2027.01.01",
// both used by several ccTLD registries, into "2027-01-01" before
// parsing. Anything else is passed through as-is and either parses or
// doesn't.
function normalizeDateString(raw) {
  const slashOrDot = raw.trim().match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})/);
  if (slashOrDot) {
    const [, y, m, d] = slashOrDot;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return raw.trim();
}

export function getDomainExpiry(hostname) {
  // Strip to the registrable root. A WHOIS server has no record for
  // "api.example.com", only "example.com".
  const parts = hostname.split(".");
  const root = parts.length > 2 ? parts.slice(-2).join(".") : hostname;

  return new Promise((resolve, reject) => {
    // follow defaults to 2 in the whois package itself, so referral
    // chasing (needed for thin-registry TLDs whose own WHOIS response is
    // just a pointer to the registrar's server) was already happening -
    // that wasn't actually the gap. Set explicitly here just so it's
    // not silently relying on whatever the package's own default happens
    // to be in some future version.
    whoisLookup(root, { timeout: 10000, follow: 2 }, (err, data) => {
      if (err) return reject(err);
      for (const pattern of EXPIRY_PATTERNS) {
        const match = data.match(pattern);
        if (match) {
          const date = new Date(normalizeDateString(match[1]));
          if (!isNaN(date.getTime())) return resolve(date);
        }
      }
      reject(new Error("could not parse an expiry date from the WHOIS response"));
    });
  });
}

export function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
