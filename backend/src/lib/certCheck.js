import tls from "node:tls";
import { lookup as whoisLookup } from "whois";
import { registrableRoot } from "./dnsCheck.js";

// Reads the full TLS posture off one handshake: not just the expiry date
// but the negotiated protocol and cipher, the key, the issuer, the SAN
// list, and the certificate's SHA-256 fingerprint.
//
// All of this was already sitting on the socket the expiry-only version
// was throwing away. It costs one extra property read each, and it turns
// "your cert expires on the 4th" into a real answer to "is the TLS on
// this host actually set up correctly" - including the chain problems
// that work in Chrome (which fetches missing intermediates) and break
// curl, Android and every server-to-server client.
//
// The fingerprint is the interesting one: stored and compared over time,
// an unexpected change is the signal for a hijacked DNS record, a
// compromised CDN account, or a certificate reissued by someone who
// shouldn't have been able to.
export function getTlsPosture(hostname, port = 443) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        timeout: 10000,
        // Deliberately does NOT reject unauthorized certs: a
        // self-signed or expired certificate is exactly the kind of
        // thing this is meant to *report*, and refusing the connection
        // would turn the most interesting findings into a bare
        // "handshake failed" with no detail.
        rejectUnauthorized: false,
      },
      () => {
        // true = include the full chain via .issuerCertificate links.
        const cert = socket.getPeerCertificate(true);
        const protocol = socket.getProtocol();
        const cipher = socket.getCipher();
        const authorized = socket.authorized;
        const authorizationError = socket.authorizationError;
        socket.end();

        if (!cert || !cert.valid_to) return reject(new Error("no certificate returned"));

        // Walk the chain to count how many certs the server actually
        // sent. A server that presents only its leaf is the classic
        // "works in my browser, fails everywhere else" misconfiguration.
        let chainLength = 0;
        let node = cert;
        const seen = new Set();
        while (node && !seen.has(node.fingerprint256)) {
          seen.add(node.fingerprint256);
          chainLength += 1;
          node = node.issuerCertificate;
        }

        const altNames = (cert.subjectaltname || "")
          .split(",")
          .map((entry) => entry.trim().replace(/^DNS:/i, ""))
          .filter(Boolean);

        resolve({
          expiresAt: new Date(cert.valid_to),
          validFrom: new Date(cert.valid_from),
          fingerprint256: cert.fingerprint256 || null,
          serialNumber: cert.serialNumber || null,
          subject: cert.subject?.CN || null,
          issuer: cert.issuer?.O || cert.issuer?.CN || null,
          altNames,
          hostnameMatches: matchesHostname(hostname, cert.subject?.CN, altNames),
          selfSigned: !!cert.issuerCertificate && cert.issuerCertificate.fingerprint256 === cert.fingerprint256,
          chainLength,
          protocol,
          cipherName: cipher?.name || null,
          keyBits: cert.bits ?? null,
          keyType: cert.asn1Curve ? `ECDSA (${cert.asn1Curve})` : cert.modulus ? "RSA" : null,
          authorized,
          authorizationError: authorizationError ? String(authorizationError) : null,
        });
      }
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("TLS handshake timed out"));
    });
  });
}

// Wildcard-aware hostname matching, the same rule browsers apply: a
// leading *. matches exactly one label, so *.example.com covers
// api.example.com but not a.b.example.com and not example.com itself.
function matchesHostname(hostname, commonName, altNames) {
  const candidates = [...altNames];
  if (commonName) candidates.push(commonName);
  return candidates.some((candidate) => {
    if (!candidate) return false;
    const name = candidate.toLowerCase();
    const host = hostname.toLowerCase();
    if (name === host) return true;
    if (name.startsWith("*.")) {
      const suffix = name.slice(1); // ".example.com"
      if (!host.endsWith(suffix)) return false;
      const label = host.slice(0, host.length - suffix.length);
      return label.length > 0 && !label.includes(".");
    }
    return false;
  });
}

// Kept as the narrow original signature because the cert sweep, the
// digest, and the expiry alert all only ever wanted the one date.
export async function getSslExpiry(hostname) {
  const posture = await getTlsPosture(hostname);
  return posture.expiresAt;
}

// Turns a posture read into scored findings, so TLS configuration shows
// up in the same security report as everything else rather than being a
// separate panel the user has to interpret themselves.
export function tlsFindings(posture) {
  const findings = [];
  const push = (check, pass, detail, severity) => findings.push({ check, pass, detail, severity, category: "transport", remediation: null });

  const weakProtocol = posture.protocol && /TLSv1(\.[01])?$/.test(posture.protocol);
  push(
    "Modern TLS protocol",
    !weakProtocol,
    weakProtocol
      ? `The server negotiated ${posture.protocol}. TLS 1.0 and 1.1 are deprecated, are rejected by current browsers, and fail PCI DSS. Enable TLS 1.2 and 1.3 and disable everything below.`
      : `Negotiated ${posture.protocol || "an unknown protocol"}${posture.cipherName ? ` with ${posture.cipherName}` : ""}.`,
    weakProtocol ? "high" : "high"
  );

  push(
    "Certificate matches hostname",
    posture.hostnameMatches,
    posture.hostnameMatches
      ? "The certificate covers the hostname being monitored."
      : `The certificate's subject (${posture.subject || "unknown"}) and SAN list don't cover this hostname. Browsers will show a name-mismatch warning.`,
    "critical"
  );

  push(
    "Certificate chain is complete",
    posture.chainLength > 1 || posture.selfSigned === false,
    posture.chainLength > 1
      ? `The server sent ${posture.chainLength} certificates, so the chain to a trusted root is intact.`
      : "The server sent only its leaf certificate, with no intermediates. Browsers usually fetch the missing intermediate themselves and it looks fine - but curl, Java, Android and most server-to-server clients will fail to verify it.",
    "medium"
  );

  push(
    "Certificate is trusted",
    posture.authorized,
    posture.authorized
      ? `Issued by ${posture.issuer || "a trusted CA"} and validates against the system trust store.`
      : `The certificate does not validate: ${posture.authorizationError || "unknown reason"}.`,
    "critical"
  );

  if (posture.keyBits && posture.keyType === "RSA") {
    push(
      "Key size is adequate",
      posture.keyBits >= 2048,
      posture.keyBits >= 2048 ? `RSA ${posture.keyBits}-bit key.` : `RSA key is only ${posture.keyBits} bits; 2048 is the modern minimum.`,
      "high"
    );
  }

  return findings;
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
  // Strip to the registrable root - a WHOIS server has no record for
  // "api.example.com", only "example.com". Shared with dnsCheck.js
  // rather than duplicated, since this used to be its own "last two
  // labels" guess that gave a different (and differently wrong) answer
  // than the other copy for the exact domains that need a real Public
  // Suffix List lookup - a .com.ng or .co.uk domain was getting WHOIS'd
  // against a fabricated root either way, just not always the SAME
  // fabricated root in both places.
  const root = registrableRoot(hostname);

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
