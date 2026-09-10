// Certificate Transparency monitoring.
//
// Every publicly trusted certificate issued anywhere is logged to public,
// append-only CT logs - that's a requirement browsers enforce, not an
// opt-in. Two useful things fall out of reading those logs for a domain
// you own:
//
// 1. Unexpected issuance. A certificate for your domain that you didn't
//    request is one of the highest-signal, lowest-noise security events
//    that exists. It means someone proved control of the domain (or the
//    DNS, or the registrar account, or a CA was tricked) to a CA that
//    then issued for it. Nothing else in this app catches that, because
//    the site itself keeps working perfectly while it happens.
// 2. Subdomain discovery, free. CT logs enumerate every subdomain anyone
//    ever got a certificate for, including the staging box from two
//    years ago that's still running an old build with an old dependency
//    and no one remembers exists. For an agency holding a handful of
//    client domains, that list is usually the single most valuable
//    output of this whole feature - you can't monitor what you forgot
//    you deployed.
//
// crt.sh is a public, free, no-key search interface over the logs. It is
// occasionally slow or briefly unavailable; every failure here is soft,
// because a CT lookup being down is not an event worth alerting anyone
// about.

const CRT_SH_TIMEOUT_MS = 20000;
// crt.sh returns every historical certificate, which for a big domain is
// tens of thousands of rows. Only recent issuance is interesting for
// alerting, and the subdomain list saturates long before this.
const MAX_CERTS = 400;

export async function fetchCtCertificates(domain) {
  // %25 is a URL-encoded %, i.e. the SQL wildcard - "example.com and
  // anything under it". exclude=expired keeps the response to what's
  // currently live rather than a decade of history.
  const url = `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json&exclude=expired`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(CRT_SH_TIMEOUT_MS),
    headers: { "user-agent": "PulseSecurityScan/1.0 (+CT log monitoring for a domain the user owns)", accept: "application/json" },
  });
  if (!response.ok) throw new Error(`crt.sh returned HTTP ${response.status}`);

  const raw = await response.json();
  if (!Array.isArray(raw)) throw new Error("crt.sh returned an unexpected response shape");

  // One "certificate" appears once per name it covers in crt.sh's output,
  // so dedupe by the log entry id to get actual certificates back.
  const byId = new Map();
  for (const entry of raw.slice(0, MAX_CERTS * 4)) {
    const id = String(entry.id ?? `${entry.serial_number}-${entry.not_before}`);
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      commonName: entry.common_name || null,
      // name_value is newline-separated when a cert covers several names.
      names: String(entry.name_value || "")
        .split("\n")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
      issuer: entry.issuer_name || null,
      notBefore: entry.not_before || null,
      notAfter: entry.not_after || null,
      serialNumber: entry.serial_number || null,
    });
    if (byId.size >= MAX_CERTS) break;
  }

  return [...byId.values()].sort((a, b) => String(b.notBefore).localeCompare(String(a.notBefore)));
}

// Every distinct hostname seen across the certificates, minus wildcards.
// This is the subdomain inventory.
export function subdomainsFrom(certificates, rootDomain) {
  const suffix = `.${rootDomain.toLowerCase()}`;
  const names = new Set();
  for (const cert of certificates) {
    for (const name of cert.names) {
      if (name.startsWith("*.")) continue;
      if (name === rootDomain.toLowerCase() || name.endsWith(suffix)) names.add(name);
    }
  }
  return [...names].sort();
}

// Certificates that weren't in the previously recorded set. On the very
// first run everything is new, which is a baseline rather than an
// incident - the caller is responsible for treating it that way, exactly
// like the content-hash baseline in checkRunner.js.
export function newCertificates(certificates, knownIds) {
  const known = new Set(knownIds);
  return certificates.filter((cert) => !known.has(cert.id));
}

// A newly issued certificate is only worth alerting on if it's actually
// recent. crt.sh's exclude=expired still returns certs issued months ago
// that Pulse simply hadn't seen before because it only started watching
// this domain yesterday - alerting on those would mean a wall of
// notifications for perfectly normal history.
export function recentlyIssued(certificates, withinDays = 7) {
  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  return certificates.filter((cert) => {
    const issued = Date.parse(cert.notBefore);
    return !Number.isNaN(issued) && issued >= cutoff;
  });
}

// Issuers the user has already seen issue for this domain. A cert from a
// CA that has issued for you a hundred times is a renewal; a cert from
// one that never has is the interesting case, and this is what lets the
// alert say which of the two it is.
export function isFamiliarIssuer(issuer, knownIssuers) {
  if (!issuer) return false;
  const normalized = normalizeIssuer(issuer);
  return knownIssuers.some((known) => normalizeIssuer(known) === normalized);
}

export function normalizeIssuer(issuer) {
  // crt.sh issuer strings are full DNs. The O= component is the stable,
  // human-meaningful part ("Let's Encrypt", "Google Trust Services").
  const org = String(issuer).match(/O\s*=\s*("([^"]+)"|([^,]+))/i);
  return (org?.[2] || org?.[3] || String(issuer)).trim().toLowerCase();
}
