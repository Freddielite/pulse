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
  /Expiration(?: Date)?:\s*(.+)/i,
  /Expiry Date:\s*(.+)/i,
  /paid-till:\s*(.+)/i,
  /renewal date:\s*(.+)/i,
];

export function getDomainExpiry(hostname) {
  // Strip to the registrable root. A WHOIS server has no record for
  // "api.example.com", only "example.com".
  const parts = hostname.split(".");
  const root = parts.length > 2 ? parts.slice(-2).join(".") : hostname;

  return new Promise((resolve, reject) => {
    whoisLookup(root, { timeout: 10000 }, (err, data) => {
      if (err) return reject(err);
      for (const pattern of EXPIRY_PATTERNS) {
        const match = data.match(pattern);
        if (match) {
          const date = new Date(match[1].trim());
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
