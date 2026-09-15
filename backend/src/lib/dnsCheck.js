// DNS posture and drift.
//
// Two separate jobs sharing one lookup:
//
// 1. Drift. Snapshot the records, compare against last time, alert on an
//    unexpected change. An A record or NS record that changes when
//    nobody deployed anything is one of the few signals that catches a
//    domain or registrar-account compromise while it's happening, rather
//    than after someone notices the site is serving something else.
// 2. Posture. SPF/DMARC/DKIM/CAA are configuration a passive observer
//    can read and grade, and they're the checks most likely to be
//    missing entirely on a small site - a domain with no DMARC record
//    can be spoofed in email by anyone, and that's usually the actual
//    attack that hits a client, not anything involving their web server.
//
// node:dns/promises is built in, so none of this adds a dependency.

import dns from "node:dns/promises";
import net from "node:net";

const LOOKUP_TIMEOUT_MS = 8000;
// Deliberately short - this only ever softens an alert's wording, never
// blocks or delays recording it, so a slow/unreachable ASN lookup should
// just give up and let the change get reported at its normal severity
// rather than holding up the DNS sweep for a "nice to have."
const ASN_LOOKUP_TIMEOUT_MS = 2500;

// Every resolver call is wrapped so a missing record (the common case -
// NODATA/NXDOMAIN throw rather than returning empty) reads as "not
// configured" instead of blowing up the whole sweep.
//
// The distinction between the two failure modes matters more than it
// looks. ENODATA/ENOTFOUND genuinely means "there is no such record."
// Anything else - a timeout, SERVFAIL, a resolver that's firewalled off -
// means "we couldn't find out," and reporting that as "you have no SPF
// record" would be a confidently wrong finding on a domain that's
// configured correctly. So the two are tracked separately and only the
// first one is ever graded.
async function tryResolve(fn) {
  try {
    const value = await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("DNS lookup timed out")), LOOKUP_TIMEOUT_MS)),
    ]);
    return { value, failed: false };
  } catch (err) {
    const definitivelyAbsent = err.code === "ENODATA" || err.code === "ENOTFOUND";
    return { value: null, failed: !definitivelyAbsent, error: err.message };
  }
}

export function registrableRoot(hostname) {
  const parts = hostname.split(".");
  // Same deliberately simple heuristic getDomainExpiry already uses. It's
  // wrong for multi-part public suffixes (co.uk, com.ng) and right for
  // the overwhelming majority of what this app watches; a full Public
  // Suffix List would be a dependency and a data file to keep current.
  return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
}

export async function snapshotDns(hostname) {
  const root = registrableRoot(hostname);

  const [a, aaaa, cname, mx, ns, txt, caa, dmarc] = await Promise.all([
    tryResolve(() => dns.resolve4(hostname)),
    tryResolve(() => dns.resolve6(hostname)),
    tryResolve(() => dns.resolveCname(hostname)),
    tryResolve(() => dns.resolveMx(root)),
    tryResolve(() => dns.resolveNs(root)),
    tryResolve(() => dns.resolveTxt(root)),
    tryResolve(() => dns.resolveCaa(root)),
    tryResolve(() => dns.resolveTxt(`_dmarc.${root}`)),
  ]);

  const flatTxt = (txt.value || []).map((chunks) => chunks.join(""));
  const flatDmarc = (dmarc.value || []).map((chunks) => chunks.join(""));

  return {
    hostname,
    root,
    takenAt: new Date().toISOString(),
    a: (a.value || []).sort(),
    aaaa: (aaaa.value || []).sort(),
    cname: (cname.value || []).sort(),
    mx: (mx.value || []).map((record) => `${record.priority} ${record.exchange}`).sort(),
    ns: (ns.value || []).map((n) => n.toLowerCase()).sort(),
    txt: flatTxt.sort(),
    caa: (caa.value || []).map((record) => JSON.stringify(record)).sort(),
    dmarc: flatDmarc.sort(),
    // Which lookups couldn't be completed, as opposed to came back
    // empty. Both drift detection and grading skip these: a resolver
    // hiccup should never read as "your nameservers were removed."
    unresolved: Object.fromEntries(
      Object.entries({ a, aaaa, cname, mx, ns, txt, caa, dmarc })
        .filter(([, result]) => result.failed)
        .map(([key, result]) => [key, result.error])
    ),
  };
}

// Which record changes are worth waking someone up for. A TXT record
// churns for legitimate reasons constantly (domain verification tokens
// for every SaaS the company signs up for), so it's tracked but reported
// at a lower urgency than nameservers changing under you.
const DRIFT_SEVERITY = {
  ns: "critical",
  a: "high",
  aaaa: "high",
  cname: "high",
  mx: "high",
  caa: "medium",
  dmarc: "medium",
  txt: "low",
};

const RECORD_LABELS = {
  a: "A (IPv4)",
  aaaa: "AAAA (IPv6)",
  cname: "CNAME",
  mx: "MX (mail)",
  ns: "NS (nameservers)",
  txt: "TXT",
  caa: "CAA",
  dmarc: "DMARC",
};

const SEVERITY_DOWNGRADE = { critical: "high", high: "medium", medium: "low", low: "low" };

// Team Cymru's free, no-API-key IP-to-ASN lookup, done over DNS (the
// same "query a TXT record" shape every other check in this file
// already uses, so this doesn't introduce a new kind of dependency or
// a third-party API key to manage). For IP a.b.c.d, the octets reversed
// plus this suffix return "ASN | prefix | country | registry | date" -
// only the ASN is used here. IPv6-only in the sense that this
// implementation doesn't bother supporting it (Cymru does have a v6
// origin service at a different suffix, but AAAA-record churn is rare
// enough on the sites this app monitors that it isn't worth a second
// code path yet).
async function lookupAsn(ip) {
  if (net.isIP(ip) !== 4) return null;
  const reversed = ip.split(".").reverse().join(".");
  try {
    const records = await Promise.race([
      dns.resolveTxt(`${reversed}.origin.asn.cymru.com`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("ASN lookup timed out")), ASN_LOOKUP_TIMEOUT_MS)),
    ]);
    const line = records[0]?.join("");
    const asn = line?.split("|")[0]?.trim();
    return asn || null;
  } catch {
    return null;
  }
}

export async function diffSnapshots(previous, current) {
  if (!previous) return [];
  const changes = [];
  for (const key of Object.keys(DRIFT_SEVERITY)) {
    // A lookup that failed this time (or last time) tells us nothing
    // about whether the record changed. Skipping these is what stops a
    // transient resolver failure from paging someone with "your
    // nameservers were removed."
    if (current.unresolved?.[key] || previous.unresolved?.[key]) continue;
    const before = previous[key] || [];
    const after = current[key] || [];
    const added = after.filter((value) => !before.includes(value));
    const removed = before.filter((value) => !after.includes(value));
    if (added.length === 0 && removed.length === 0) continue;

    let severity = DRIFT_SEVERITY[key];
    // A record (IPv4) changing to a genuinely different network is one
    // of the few real early signals of a DNS/registrar-account
    // compromise - but changing to a DIFFERENT ADDRESS ON THE SAME
    // NETWORK is what a hosting provider's own infrastructure churn
    // looks like (an anycast rebalance, a new edge IP range - the
    // Vercel migration that motivated this is a real example), and it's
    // indistinguishable from a hijack by IP value alone. Same ASN isn't
    // proof nothing's wrong - nothing stops an attacker from operating
    // inside a big provider's network too - so this softens the
    // severity and wording rather than suppressing the event outright;
    // it's still worth a glance, just not "someone hijacked your
    // domain" urgent.
    let sameNetworkAsn = null;
    if (key === "a" && added.length > 0 && removed.length > 0) {
      const [addedAsn, removedAsn] = await Promise.all([lookupAsn(added[0]), lookupAsn(removed[0])]);
      if (addedAsn && removedAsn && addedAsn === removedAsn) {
        sameNetworkAsn = addedAsn;
        severity = SEVERITY_DOWNGRADE[severity] || severity;
      }
    }

    changes.push({
      record: key,
      label: RECORD_LABELS[key] || key.toUpperCase(),
      severity,
      added,
      removed,
      sameNetworkAsn,
      summary: [
        added.length > 0 ? `added ${added.join(", ")}` : null,
        removed.length > 0 ? `removed ${removed.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("; "),
    });
  }
  return changes;
}

// ---------------------------------------------------------------------
// Posture grading
// ---------------------------------------------------------------------

function finding(check, pass, detail, severity) {
  return { check, pass, detail, severity, category: "dns", remediation: null };
}

export function dnsFindings(snapshot) {
  const findings = [];
  const unresolved = snapshot.unresolved || {};

  // --- SPF ---
  const spf = snapshot.txt.find((record) => /^v=spf1/i.test(record));
  if (unresolved.txt) {
    findings.push(finding("SPF record published", true, `Couldn't check - the TXT lookup for ${snapshot.root} failed (${unresolved.txt}).`, "info"));
  } else if (!spf) {
    findings.push(
      finding(
        "SPF record published",
        false,
        `No SPF record on ${snapshot.root}. Any server on the internet can send mail claiming to be from this domain and it won't be flagged for it.`,
        "medium"
      )
    );
  } else {
    // "+all" or a bare "all" passes everything, which is an SPF record
    // that exists purely to look like one. "~all" (softfail) and "-all"
    // (hardfail) are the two that actually assert something.
    const permissive = /[+ ]all\b/i.test(spf) && !/[~-]all\b/i.test(spf);
    findings.push(
      finding(
        "SPF record is restrictive",
        !permissive,
        permissive
          ? `SPF ends in +all, which authorizes every sender on the internet. Functionally the same as having no SPF at all: ${spf}`
          : `SPF published: ${spf.length > 100 ? `${spf.slice(0, 97)}...` : spf}`,
        "medium"
      )
    );
  }

  // --- DMARC ---
  const dmarc = snapshot.dmarc.find((record) => /^v=DMARC1/i.test(record));
  if (unresolved.dmarc) {
    findings.push(finding("DMARC record published", true, `Couldn't check - the TXT lookup for _dmarc.${snapshot.root} failed (${unresolved.dmarc}).`, "info"));
  } else if (!dmarc) {
    findings.push(
      finding(
        "DMARC record published",
        false,
        `No DMARC record at _dmarc.${snapshot.root}. Without it, receiving mail servers have no instruction on what to do with mail that fails SPF or DKIM, so spoofed mail from this domain generally gets delivered.`,
        "medium"
      )
    );
  } else {
    const policy = dmarc.match(/\bp\s*=\s*(none|quarantine|reject)/i)?.[1]?.toLowerCase();
    const enforcing = policy === "quarantine" || policy === "reject";
    findings.push(
      finding(
        "DMARC policy is enforcing",
        enforcing,
        enforcing
          ? `DMARC policy is p=${policy}.`
          : `DMARC exists but the policy is p=${policy || "unset"}, which means "monitor only" - receivers are told to do nothing about mail that fails. It's the right place to start, but it isn't protection until it moves to quarantine or reject.`,
        "medium"
      )
    );
  }

  // --- CAA ---
  if (unresolved.caa) {
    findings.push(finding("CAA record restricts certificate issuance", true, `Couldn't check - the CAA lookup failed (${unresolved.caa}).`, "info"));
  } else {
  findings.push(
    finding(
      "CAA record restricts certificate issuance",
      snapshot.caa.length > 0,
      snapshot.caa.length > 0
        ? `${snapshot.caa.length} CAA record${snapshot.caa.length === 1 ? "" : "s"} published, so only the named CAs can issue certificates for this domain.`
        : "No CAA record. Any certificate authority in the world is permitted to issue a certificate for this domain, which widens the blast radius of a compromised or tricked CA.",
      "low"
    )
  );
  }

  // --- Nameservers ---
  if (unresolved.ns) {
    findings.push(finding("Multiple nameservers", true, `Couldn't check - the NS lookup failed (${unresolved.ns}).`, "info"));
    return findings;
  }
  findings.push(
    finding(
      "Multiple nameservers",
      snapshot.ns.length >= 2,
      snapshot.ns.length >= 2
        ? `${snapshot.ns.length} nameservers: ${snapshot.ns.join(", ")}.`
        : `Only ${snapshot.ns.length} nameserver is published. That's a single point of failure for the entire domain.`,
      "low"
    )
  );

  return findings;
}

// ---------------------------------------------------------------------
// Dangling CNAME / subdomain takeover
// ---------------------------------------------------------------------

// A subdomain whose CNAME still points at a platform where the
// corresponding app, bucket or site has been deleted can often be
// claimed by whoever registers that name next - and they then serve
// content from a hostname the owner's users trust, with a valid
// certificate. The detection is: the CNAME target belongs to a known
// platform, and the platform answers with its characteristic
// "nothing is configured here" response.
const TAKEOVER_SIGNATURES = [
  { platform: "GitHub Pages", target: /\.github\.io$/i, marker: /There isn't a GitHub Pages site here/i },
  { platform: "Heroku", target: /\.herokuapp\.com$/i, marker: /No such app|no-such-app\.html/i },
  { platform: "AWS S3", target: /s3[.-][a-z0-9-]*\.amazonaws\.com$/i, marker: /NoSuchBucket|The specified bucket does not exist/i },
  { platform: "Netlify", target: /\.netlify\.(app|com)$/i, marker: /Not Found - Request ID|no such site/i },
  { platform: "Vercel", target: /\.vercel(-dns)?\.(app|com)$/i, marker: /DEPLOYMENT_NOT_FOUND|The deployment could not be found/i },
  { platform: "Shopify", target: /\.myshopify\.com$/i, marker: /Sorry, this shop is currently unavailable/i },
  { platform: "Fastly", target: /\.fastly\.net$/i, marker: /Fastly error: unknown domain/i },
  { platform: "Azure", target: /\.azurewebsites\.net$|\.cloudapp\.azure\.com$/i, marker: /Error 404 - Web app not found/i },
];

export async function checkDanglingCname(hostname, snapshot) {
  if (!snapshot.cname || snapshot.cname.length === 0) return null;

  for (const target of snapshot.cname) {
    const signature = TAKEOVER_SIGNATURES.find((entry) => entry.target.test(target));
    if (!signature) continue;

    // The CNAME points at a platform that has a takeover pattern. Ask the
    // hostname itself what it serves and look for that platform's
    // "unclaimed" page. A live, correctly configured site returns its own
    // content and matches nothing here.
    try {
      const response = await fetch(`https://${hostname}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
        headers: { "user-agent": "PulseSecurityScan/1.0 (+passive check by the site owner's uptime monitor)" },
      });
      const body = (await response.text()).slice(0, 20_000);
      if (signature.marker.test(body)) {
        return {
          platform: signature.platform,
          target,
          detail: `${hostname} still has a CNAME to ${target} (${signature.platform}), but that platform reports nothing is configured there. A dangling record like this can usually be claimed by anyone who registers the same name on ${signature.platform}, letting them serve their own content from your hostname with a valid certificate. Either remove the DNS record or reclaim the target.`,
        };
      }
    } catch {
      // Unreachable is inconclusive, not evidence of a takeover - a
      // dangling record and a temporarily down host look identical from
      // here, and reporting the second as the first would be a
      // frightening false positive.
      return null;
    }
  }
  return null;
}
