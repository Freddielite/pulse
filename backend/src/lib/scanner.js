// Passive security scanner. Reads what a site voluntarily tells any
// visitor: response headers, cookie attributes, the HTML it serves, and
// whether a handful of well-known paths are readable without
// authentication. Nothing here attempts to exploit anything, submit
// anything, or authenticate as anyone - every request is a plain GET,
// OPTIONS or TRACE that a browser or a crawler could have made itself.
//
// Two things drove the rewrite of the original ported wyntek-status
// version:
//
// 1. Presence-only header checks pass a Content-Security-Policy of
//    `default-src *` and an HSTS of `max-age=1`. Those are worse than
//    useless as findings, because they read as green while providing no
//    protection. Every header check now grades the *value*.
// 2. The exposed-path checks treated any HTTP 200 as "this file is
//    public", which is wrong for every SPA on earth - a React app on
//    Vercel serves index.html with a 200 for /.env, /.git/config and
//    every other path that doesn't exist. That scored perfectly healthy
//    sites at zero on four checks. Paths are now judged against a
//    soft-404 baseline plus a content signature, so it takes an actual
//    .env-shaped response to fail the .env check.

import { SEVERITY, scoreFindings, gradeFor, sortFindings, summarize, severityRank } from "./severity.js";
import { assertPublicHttpUrl } from "./urlSafety.js";

// Hard ceiling on requests per scan. A scan runs unattended on a daily
// sweep across every monitor, on a free-tier box, against sites the user
// owns - it should be a light, predictable knock, not something that
// shows up in their access logs as a burst.
const MAX_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 8000;
const MAIN_REQUEST_TIMEOUT_MS = 12000;
// Cap on how much of a response body is read into memory. Enough for any
// realistic HTML document's head and script tags, and a hard limit so a
// monitor pointed at a large file can't balloon memory during a sweep.
const MAX_BODY_BYTES = 750_000;
// Sequential is needlessly slow across ~17 paths, but a wide fan-out at
// someone's free-tier app looks like a burst and can cause the very blip
// the rest of this app exists to detect.
const PROBE_CONCURRENCY = 4;

class RequestBudget {
  constructor(max) {
    this.remaining = max;
  }
  take() {
    if (this.remaining <= 0) return false;
    this.remaining -= 1;
    return true;
  }
}

// Reads at most MAX_BODY_BYTES of a response as text, then abandons the
// rest. Streamed rather than response.text() so a huge body is never
// fully buffered just to be sliced afterwards.
async function readLimitedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let bytes = 0;
  try {
    while (bytes < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // A truncated or aborted body is fine - whatever was read is still
    // usable for the analysis below.
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return text;
}

async function safeFetch(url, budget, options = {}) {
  if (!budget.take()) return null;
  const { timeoutMs = REQUEST_TIMEOUT_MS, readBody = false, headers, ...rest } = options;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      // Identifying as Pulse is the honest thing to do and keeps the
      // scan recognizable in the owner's own access logs, which matters
      // when they're looking at "who hit /.env on my server."
      headers: { "user-agent": "PulseSecurityScan/1.0 (+passive check by the site owner's uptime monitor)", ...(headers || {}) },
      ...rest,
    });
    const body = readBody ? await readLimitedText(response) : null;
    return { response, body };
  } catch (err) {
    return { error: err };
  }
}

export function finding(check, pass, detail, severity, category, remediation = null) {
  return { check, pass, detail, severity, category, remediation };
}

// Platform-specific copy-paste fixes. A finding that says "add a
// Content-Security-Policy header" is advice; one that says exactly what
// to paste into vercel.json is a fix. That's the difference between a
// report a client files away and one they act on.
function remediationFor(header, value) {
  return {
    header,
    value,
    nginx: `add_header ${header} "${value}" always;`,
    express: `app.use((req, res, next) => { res.setHeader(${JSON.stringify(header)}, ${JSON.stringify(value)}); next(); });`,
    vercel: `// vercel.json\n{ "headers": [{ "source": "/(.*)", "headers": [{ "key": "${header}", "value": "${value}" }] }] }`,
    netlify: `# _headers\n/*\n  ${header}: ${value}`,
    cloudflare: `Rules -> Transform Rules -> Modify Response Header -> set ${header} to: ${value}`,
  };
}

// A block-at-the-edge rule for a path that should never be served at
// all. This is a safety net, not the actual fix - the real fix is not
// shipping the file in the deployed output in the first place - but a
// WAF/proxy rule is the one piece of that a report can hand someone as
// a literal copy-paste action right now.
function pathRemediation(path) {
  return {
    nginx: `location = ${path} { deny all; return 404; }`,
    express: `app.use(${JSON.stringify(path)}, (req, res) => res.status(404).end());`,
    vercel: `// vercel.json\n{ "rewrites": [{ "source": "${path}", "destination": "/404" }] }`,
    netlify: `# _redirects\n${path}  /404  404`,
    cloudflare: `WAF -> Custom rules -> block requests where URI Path equals "${path}"`,
  };
}

// For fixes that live in application logic or build config rather than
// in a host's header/routing layer - a single platform-agnostic
// instruction, shown under its own "Fix" tab instead of a hosting
// platform name that wouldn't actually apply.
function generalRemediation(text) {
  return { general: text };
}

// ---------------------------------------------------------------------
// Header grading
// ---------------------------------------------------------------------

function gradeHsts(value) {
  if (!value) {
    return finding(
      "HSTS enabled",
      false,
      "No Strict-Transport-Security header. A visitor's first request over plain HTTP can be intercepted and downgraded before any redirect to HTTPS ever happens.",
      SEVERITY.HIGH,
      "transport",
      remediationFor("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    );
  }
  const maxAge = Number(value.match(/max-age\s*=\s*(\d+)/i)?.[1] ?? 0);
  const includesSubdomains = /includeSubDomains/i.test(value);
  const sixMonths = 15_552_000;

  if (maxAge < 300) {
    return finding(
      "HSTS enabled",
      false,
      `Strict-Transport-Security is present but max-age is ${maxAge}, short enough that browsers forget the policy almost immediately. This passes a presence check while providing no real protection.`,
      SEVERITY.HIGH,
      "transport",
      remediationFor("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    );
  }
  if (maxAge < sixMonths) {
    return finding(
      "HSTS max-age long enough",
      false,
      `max-age is ${maxAge}s, about ${Math.round(maxAge / 86400)} days. Six months (15552000) is the usual floor and what the preload list requires.`,
      SEVERITY.LOW,
      "transport",
      remediationFor("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    );
  }
  return finding(
    "HSTS enabled",
    true,
    includesSubdomains
      ? `Set for ${Math.round(maxAge / 86400)} days, including subdomains.`
      : `Set for ${Math.round(maxAge / 86400)} days. No includeSubDomains, so subdomains aren't covered by the policy.`,
    SEVERITY.HIGH,
    "transport"
  );
}

function gradeCsp(value) {
  if (!value) {
    return finding(
      "CSP present and meaningful",
      false,
      "No Content-Security-Policy header. CSP is the main thing limiting what an injected script can do once XSS gets past everything else.",
      SEVERITY.MEDIUM,
      "headers",
      remediationFor("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'")
    );
  }

  const weaknesses = [];
  if (/'unsafe-inline'/i.test(value) && !/'strict-dynamic'/i.test(value)) {
    weaknesses.push("'unsafe-inline', which permits exactly the injected inline scripts CSP exists to stop");
  }
  if (/'unsafe-eval'/i.test(value)) weaknesses.push("'unsafe-eval'");
  if (/(?:default|script)-src[^;]*(?:\s|:)\*(?:\s|;|$)/i.test(value)) weaknesses.push("a wildcard script or default source");
  if (/script-src[^;]*data:/i.test(value)) weaknesses.push("data: URIs as a script source");

  if (weaknesses.length > 0) {
    return finding(
      "CSP present and meaningful",
      false,
      `A CSP is set, but it allows ${weaknesses.join(", ")}. A policy this permissive passes a presence check while blocking very little in practice.`,
      SEVERITY.MEDIUM,
      "headers",
      remediationFor("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'")
    );
  }
  return finding("CSP present and meaningful", true, "CSP present, with no wildcard sources and no unsafe-inline or unsafe-eval.", SEVERITY.MEDIUM, "headers");
}

function gradeFrameOptions(xfo, csp) {
  const frameAncestors = csp?.match(/frame-ancestors\s+([^;]+)/i)?.[1]?.trim();
  if (frameAncestors) {
    const permissive = frameAncestors.includes("*") && !frameAncestors.includes("'none'");
    return finding(
      "Clickjacking protection",
      !permissive,
      permissive
        ? `CSP frame-ancestors is "${frameAncestors}", which lets any site frame this page.`
        : `CSP frame-ancestors is "${frameAncestors}". This supersedes X-Frame-Options and is the modern way to do it.`,
      SEVERITY.MEDIUM,
      "headers",
      permissive ? remediationFor("Content-Security-Policy", "frame-ancestors 'none'") : null
    );
  }
  if (!xfo) {
    return finding(
      "Clickjacking protection",
      false,
      "Neither X-Frame-Options nor a CSP frame-ancestors directive is set, so this page can be embedded in an iframe on any site.",
      SEVERITY.MEDIUM,
      "headers",
      remediationFor("X-Frame-Options", "DENY")
    );
  }
  const normalized = xfo.trim().toUpperCase();
  const valid = normalized === "DENY" || normalized === "SAMEORIGIN";
  return finding(
    "Clickjacking protection",
    valid,
    valid
      ? `X-Frame-Options: ${normalized}.`
      : `X-Frame-Options is "${xfo}", which browsers don't act on. ALLOW-FROM in particular is obsolete and ignored - use CSP frame-ancestors instead.`,
    SEVERITY.MEDIUM,
    "headers",
    valid ? null : remediationFor("Content-Security-Policy", "frame-ancestors 'none'")
  );
}

function gradeContentTypeOptions(value) {
  const ok = value?.trim().toLowerCase() === "nosniff";
  return finding(
    "MIME sniffing blocked",
    ok,
    ok
      ? "X-Content-Type-Options: nosniff."
      : value
        ? `X-Content-Type-Options is "${value}"; the only value browsers act on is "nosniff".`
        : "No X-Content-Type-Options header, so a browser may guess a response's type and execute an uploaded file as script.",
    SEVERITY.LOW,
    "headers",
    ok ? null : remediationFor("X-Content-Type-Options", "nosniff")
  );
}

const STRONG_REFERRER_POLICIES = ["no-referrer", "same-origin", "strict-origin", "strict-origin-when-cross-origin"];

function gradeReferrerPolicy(value) {
  if (!value) {
    return finding(
      "Referrer policy set",
      false,
      "No Referrer-Policy header. Full URLs, including any path or query string holding a token or an id, leak to third-party sites in the Referer header.",
      SEVERITY.LOW,
      "headers",
      remediationFor("Referrer-Policy", "strict-origin-when-cross-origin")
    );
  }
  const normalized = value.trim().toLowerCase();
  const strong = STRONG_REFERRER_POLICIES.some((policy) => normalized.includes(policy));
  return finding(
    "Referrer policy set",
    strong,
    strong ? `Referrer-Policy: ${value}.` : `Referrer-Policy is "${value}", which still leaks the full URL cross-origin.`,
    SEVERITY.LOW,
    "headers",
    strong ? null : remediationFor("Referrer-Policy", "strict-origin-when-cross-origin")
  );
}

function gradePermissionsPolicy(value) {
  const present = !!value;
  return finding(
    "Permissions policy set",
    present,
    present
      ? `Permissions-Policy: ${value.length > 120 ? `${value.slice(0, 117)}...` : value}`
      : "No Permissions-Policy header. Embedded third-party frames can request camera, microphone and geolocation access by default.",
    SEVERITY.LOW,
    "headers",
    present ? null : remediationFor("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
  );
}

// ---------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------

function parseCookie(raw) {
  const [nameValue, ...attrs] = raw.split(";");
  const name = nameValue.split("=")[0]?.trim() ?? "";
  const flags = new Set();
  const values = {};
  for (const attr of attrs) {
    const [key, value] = attr.split("=");
    const normalized = key.trim().toLowerCase();
    flags.add(normalized);
    if (value !== undefined) values[normalized] = value.trim();
  }
  return { name, flags, values };
}

function auditCookies(response, isHttps) {
  // getSetCookie() returns each Set-Cookie header separately. A plain
  // headers.get() joins them with commas, which is unparseable, because
  // a cookie's own Expires value contains a comma.
  const rawCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (rawCookies.length === 0) {
    return [finding("Cookie flags", true, "No cookies set on this response, so there's nothing to misconfigure.", SEVERITY.HIGH, "cookies")];
  }

  const cookies = rawCookies.map(parseCookie);
  const problems = [];
  for (const cookie of cookies) {
    const issues = [];
    if (isHttps && !cookie.flags.has("secure")) issues.push("no Secure flag, so it's sent over plain HTTP too");
    if (!cookie.flags.has("httponly")) issues.push("no HttpOnly flag, so JavaScript (and therefore any XSS) can read it");
    if (!cookie.flags.has("samesite")) issues.push("no SameSite attribute");
    else if (cookie.values.samesite?.toLowerCase() === "none" && !cookie.flags.has("secure")) issues.push("SameSite=None without Secure");
    if (issues.length > 0) problems.push(`${cookie.name} (${issues.join("; ")})`);
  }

  const findings = [
    finding(
      "Cookie flags",
      problems.length === 0,
      problems.length === 0
        ? `All ${cookies.length} cookie${cookies.length === 1 ? "" : "s"} set Secure, HttpOnly and SameSite appropriately.`
        : `${problems.length} of ${cookies.length} cookies are missing protective attributes: ${problems.join(", ")}.`,
      SEVERITY.HIGH,
      "cookies",
      problems.length === 0
        ? null
        : {
            header: "Set-Cookie",
            value: "Secure; HttpOnly; SameSite=Lax",
            express: `res.cookie(name, value, { httpOnly: true, secure: true, sameSite: "lax" });`,
            nginx: "Set these where the cookie is issued, in the application, not at the proxy.",
            vercel: "Set these where the cookie is issued, in the application.",
            netlify: "Set these where the cookie is issued, in the application.",
            cloudflare: "Set these where the cookie is issued, in the application.",
          }
    ),
  ];

  // A session cookie with a year-long lifetime is a different problem
  // from a missing flag, so it's its own finding rather than folded into
  // the one above.
  const longLived = cookies
    .filter((cookie) => /sess|sid|auth|token|login/i.test(cookie.name))
    .filter((cookie) => Number(cookie.values["max-age"] ?? 0) > 60 * 60 * 24 * 90);
  if (longLived.length > 0) {
    findings.push(
      finding(
        "Session cookie lifetime reasonable",
        false,
        `${longLived.map((c) => c.name).join(", ")} look like session cookies with a Max-Age over 90 days. A stolen cookie stays valid for that whole window.`,
        SEVERITY.LOW,
        "cookies",
        generalRemediation(
          `Shorten Max-Age/Expires on the cookie(s) named above to something measured in hours to a couple of weeks, depending on how sensitive the session is, and use a refresh-token/rotation flow for anything that needs to stay signed in longer than that rather than one long-lived cookie.`
        )
      )
    );
  }
  return findings;
}

// ---------------------------------------------------------------------
// Version disclosure
// ---------------------------------------------------------------------

function auditDisclosure(response) {
  const server = response.headers.get("server") ?? "";
  const poweredBy = response.headers.get("x-powered-by") ?? "";
  const aspNet = response.headers.get("x-aspnet-version") ?? "";

  const leaks = [];
  if (/\d/.test(server)) leaks.push(`Server: ${server}`);
  if (poweredBy) leaks.push(`X-Powered-By: ${poweredBy}`);
  if (aspNet) leaks.push(`X-AspNet-Version: ${aspNet}`);

  return [
    finding(
      "No software version disclosure",
      leaks.length === 0,
      leaks.length === 0
        ? "Response headers don't advertise a specific server or framework version."
        : `Headers name the exact stack in use (${leaks.join("; ")}). Not a vulnerability on its own, but it tells anyone scanning which published CVEs are worth trying first.`,
      SEVERITY.LOW,
      "disclosure",
      leaks.length === 0
        ? null
        : {
            header: "Server / X-Powered-By",
            value: "removed",
            express: `app.disable("x-powered-by");`,
            nginx: "server_tokens off;",
            vercel: "Remove X-Powered-By in the app with app.disable('x-powered-by').",
            netlify: "Remove X-Powered-By in the app.",
            cloudflare: "Transform Rules -> Modify Response Header -> Remove: X-Powered-By",
          }
    ),
  ];
}

// ---------------------------------------------------------------------
// HTML analysis: third-party inventory, SRI, mixed content
// ---------------------------------------------------------------------

export function analyzeHtml(html, finalUrl) {
  const findings = [];
  if (!html || !/<html|<!doctype/i.test(html.slice(0, 2000))) {
    // Not an HTML document - a JSON API, most likely. These checks don't
    // apply, and reporting them as passes would be misleading.
    return { findings, thirdPartyOrigins: [], firstPartyScripts: [] };
  }

  const origin = new URL(finalUrl).origin;
  const scriptTags = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)];
  const linkTags = [...html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)];
  const iframeTags = [...html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)];

  const thirdParty = new Set();
  const insecure = [];
  const missingSri = [];
  // First-party JS, kept separate from thirdParty (which classify() never
  // populates for these) so auditSourceMaps() below has something to work
  // from - source maps are only ever worth checking for scripts this site
  // actually serves itself.
  const firstPartyScripts = new Set();

  function classify(match, kind) {
    const [tag, src] = match;
    let resolved;
    try {
      resolved = new URL(src, finalUrl);
    } catch {
      return;
    }
    if (resolved.protocol === "http:") insecure.push(resolved.href);
    if (resolved.origin === origin) {
      if (kind === "script") firstPartyScripts.add(resolved.href);
      return;
    }
    if (resolved.protocol === "data:" || resolved.protocol === "blob:") return;
    thirdParty.add(resolved.origin);
    if (kind === "script" && !/\bintegrity\s*=/i.test(tag)) missingSri.push(resolved.href);
  }

  scriptTags.forEach((m) => classify(m, "script"));
  iframeTags.forEach((m) => classify(m, "iframe"));
  linkTags.filter((m) => /stylesheet/i.test(m[0])).forEach((m) => classify(m, "stylesheet"));

  const thirdPartyOrigins = [...thirdParty].sort();

  findings.push(
    finding(
      "No mixed content",
      insecure.length === 0,
      insecure.length === 0
        ? "Every subresource loads over HTTPS."
        : `${insecure.length} subresource${insecure.length === 1 ? "" : "s"} load over plain HTTP (${insecure.slice(0, 3).join(", ")}${insecure.length > 3 ? ", ..." : ""}). Browsers block these, so this is usually a visibly broken page as well as an interception risk.`,
      SEVERITY.HIGH,
      "supply-chain",
      insecure.length === 0
        ? null
        : generalRemediation(
            `Change each listed URL from http:// to https://, or to a protocol-relative/root-relative path so it always follows the page's own scheme. If a third-party asset genuinely has no HTTPS version, it needs to be dropped or replaced.`
          )
    )
  );

  if (thirdPartyOrigins.length > 0) {
    findings.push(
      finding(
        "Third-party scripts pinned with SRI",
        missingSri.length === 0,
        missingSri.length === 0
          ? "Every third-party script tag carries a Subresource Integrity hash."
          : `${missingSri.length} third-party script${missingSri.length === 1 ? "" : "s"} load with no integrity attribute. If one of those origins is compromised, whatever it serves next runs with full access to this page. SRI can't be used with scripts that are meant to change (tag managers, analytics loaders), so this is a judgment call rather than an automatic fix.`,
        SEVERITY.MEDIUM,
        "supply-chain",
        missingSri.length === 0
          ? null
          : generalRemediation(
              `Add integrity="sha384-..." and crossorigin="anonymous" to each script tag listed. Most CDNs (jsDelivr, cdnjs, unpkg) publish the exact hash right next to the script URL on their own site. Skip this for scripts that are meant to change on their own (tag managers, analytics loaders) - a hash mismatch would just break them.`
            )
      )
    );
    findings.push(
      finding(
        "Third-party origins",
        true,
        `${thirdPartyOrigins.length} third-party origin${thirdPartyOrigins.length === 1 ? "" : "s"} referenced: ${thirdPartyOrigins.join(", ")}.`,
        SEVERITY.INFO,
        "supply-chain"
      )
    );
  }

  const generator = html.match(/<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i)?.[1];
  if (generator && /\d/.test(generator)) {
    findings.push(
      finding(
        "No version disclosure in page metadata",
        false,
        `The generator meta tag names an exact version: "${generator}".`,
        SEVERITY.LOW,
        "disclosure",
        generalRemediation(
          `Remove or blank the <meta name="generator"> tag your framework/CMS injects automatically. Most (WordPress, various static site generators) have a documented setting to disable it, or it can be stripped in a build/post-processing step.`
        )
      )
    );
  }

  return { findings, thirdPartyOrigins, firstPartyScripts: [...firstPartyScripts] };
}

// ---------------------------------------------------------------------
// Exposed paths, judged against a soft-404 baseline
// ---------------------------------------------------------------------

// Each path carries a signature: a test the response body must also pass
// before the path counts as exposed. Status 200 alone is not evidence -
// an SPA returns 200 with index.html for every unknown path, and plenty
// of "helpful" 404 pages return 200 as well.
const EXPOSED_PATHS = [
  {
    path: "/.env",
    check: "No exposed .env file",
    severity: SEVERITY.CRITICAL,
    signature: (body) => /^[A-Z0-9_]+\s*=/m.test(body) && !/<html/i.test(body),
    detail: "Environment files hold database URLs, API keys and secrets in plain text.",
  },
  {
    path: "/.git/config",
    check: "No exposed .git config",
    severity: SEVERITY.CRITICAL,
    signature: (body) => /\[core\]|\[remote |repositoryformatversion/i.test(body),
    detail: "An exposed .git directory usually means the whole source history can be reconstructed, including every secret ever committed to it.",
  },
  {
    path: "/.git/HEAD",
    check: "No exposed .git HEAD",
    severity: SEVERITY.CRITICAL,
    signature: (body) => /^ref:\s+refs\//m.test(body.trim()),
    detail: "Same exposure as .git/config, reached through a different file.",
  },
  {
    path: "/.aws/credentials",
    check: "No exposed AWS credentials",
    severity: SEVERITY.CRITICAL,
    signature: (body) => /aws_access_key_id|aws_secret_access_key/i.test(body),
    detail: "Long-lived cloud credentials readable by anyone who asks for them.",
  },
  {
    path: "/.npmrc",
    check: "No exposed .npmrc",
    severity: SEVERITY.HIGH,
    signature: (body) => /_authToken|^registry\s*=/im.test(body),
    detail: "Frequently contains a private registry auth token.",
  },
  {
    path: "/docker-compose.yml",
    check: "No exposed docker-compose.yml",
    severity: SEVERITY.HIGH,
    signature: (body) => /^\s*(services|version)\s*:/m.test(body),
    detail: "Commonly holds database passwords and a map of internal services.",
  },
  {
    path: "/wp-config.php.bak",
    check: "No exposed backup config",
    severity: SEVERITY.CRITICAL,
    signature: (body) => /DB_PASSWORD|DB_NAME|define\s*\(/i.test(body),
    detail: "A .bak extension means the server sends it as plain text instead of executing it, so the database credentials inside are readable.",
  },
  {
    path: "/config.json",
    check: "No exposed config.json",
    severity: SEVERITY.HIGH,
    signature: (body) => {
      try {
        JSON.parse(body);
        return /password|secret|apikey|api_key|"token"|connectionstring/i.test(body);
      } catch {
        return false;
      }
    },
    detail: "A publicly readable config file containing credential-shaped keys.",
  },
  {
    path: "/.DS_Store",
    check: "No exposed .DS_Store",
    severity: SEVERITY.LOW,
    signature: (body) => body.includes("Bud1"),
    detail: "Leaks the directory listing of whatever was uploaded, mapping out paths that weren't meant to be discoverable.",
  },
  {
    path: "/phpinfo.php",
    check: "No exposed phpinfo()",
    severity: SEVERITY.HIGH,
    signature: (body) => /phpinfo\(\)|PHP Version/i.test(body),
    detail: "Dumps the full PHP configuration, loaded modules, filesystem paths and often environment variables.",
  },
  {
    path: "/server-status",
    check: "No exposed Apache server-status",
    severity: SEVERITY.MEDIUM,
    signature: (body) => /Apache Server Status|Server uptime/i.test(body),
    detail: "Exposes live request URLs from other visitors, including any token sitting in a query string.",
  },
  {
    path: "/actuator/env",
    check: "No exposed Spring actuator",
    severity: SEVERITY.CRITICAL,
    signature: (body) => /propertySources|activeProfiles/i.test(body),
    detail: "Spring Boot's /actuator/env dumps every environment property, credentials included.",
  },
  {
    path: "/.vscode/sftp.json",
    check: "No exposed editor deploy config",
    severity: SEVERITY.HIGH,
    signature: (body) => /"host"|"privateKeyPath"|"password"/i.test(body),
    detail: "Editor deploy configs routinely hold SSH or FTP credentials in plain text.",
  },
  {
    path: "/backup.sql",
    check: "No exposed database dump",
    severity: SEVERITY.CRITICAL,
    signature: (body) => /CREATE TABLE|INSERT INTO|MySQL dump|PostgreSQL database dump/i.test(body),
    detail: "A downloadable copy of the database.",
  },
];

// Documentation surfaces. Kept apart from the list above because finding
// one isn't automatically a failure - plenty of APIs publish their docs
// deliberately - so they're reported at low severity with wording that
// reflects that it's a judgment call.
const API_SURFACE_PATHS = [
  {
    path: "/.well-known/security.txt",
    check: "Publishes a security.txt",
    severity: SEVERITY.INFO,
    inverted: true,
    signature: (body) => /Contact:/i.test(body),
    detail: "Gives a security researcher a documented way to report something instead of guessing at an address.",
  },
  {
    path: "/openapi.json",
    check: "OpenAPI spec not publicly exposed",
    severity: SEVERITY.LOW,
    signature: (body) => /"openapi"\s*:|"swagger"\s*:/i.test(body),
    detail: "The full API surface, including endpoints that aren't linked anywhere, is enumerable from this file.",
  },
  {
    path: "/swagger-ui.html",
    check: "Swagger UI not publicly exposed",
    severity: SEVERITY.LOW,
    // Swagger UI is an HTML page, so this is the one exposure check that
    // has to accept HTML - which means the signature has to be specific
    // enough to stand on its own. SwaggerUIBundle and swagger-ui.css are
    // things only a real Swagger UI page contains; the bare word
    // "swagger" is not.
    allowHtml: true,
    signature: (body) => /SwaggerUIBundle|swagger-ui\.css|id=["']swagger-ui["']/i.test(body),
    detail: "Interactive API documentation reachable without authentication.",
  },
];

// Fingerprints the site's response to a path that definitely doesn't
// exist. Everything in the exposed-path list is judged relative to this,
// which is what stops an SPA's catch-all index.html from reading as
// fourteen separate critical findings.
async function establishBaseline(origin, budget) {
  const probe = `/pulse-scan-${Math.random().toString(36).slice(2, 12)}`;
  const result = await safeFetch(origin + probe, budget, { redirect: "manual", readBody: true });
  if (!result || result.error) return { status: null, bodyPrefix: null, length: null };
  return {
    status: result.response.status,
    // 200 characters is plenty to recognize "this is the same catch-all
    // page again" without storing whole documents.
    bodyPrefix: (result.body || "").slice(0, 200),
    length: (result.body || "").length,
  };
}

function looksLikeBaseline(body, response, baseline) {
  if (baseline.status === null) return false;
  if (response.status !== baseline.status) return false;
  const text = body || "";
  if (baseline.bodyPrefix && text.slice(0, 200) === baseline.bodyPrefix) return true;
  // Length within 5% of the baseline is the signature of a templated
  // catch-all page differing only by the path echoed into it.
  if (baseline.length && Math.abs(text.length - baseline.length) / baseline.length < 0.05) return true;
  return false;
}

async function probePaths(origin, budget, baseline, definitions) {
  const findings = [];
  const queue = [...definitions];

  async function worker() {
    while (queue.length > 0) {
      const def = queue.shift();
      const result = await safeFetch(origin + def.path, budget, { redirect: "manual", readBody: true });

      // Out of request budget. Reporting "couldn't check" as a pass would
      // be a quiet lie, so it's reported as unknown at info severity,
      // where it doesn't move the score in either direction.
      if (!result) {
        findings.push(finding(def.check, true, "Not checked - the scan's request budget was reached.", SEVERITY.INFO, "exposure"));
        continue;
      }
      if (result.error) {
        findings.push(finding(def.check, !def.inverted, `${def.path} could not be reached (${result.error.message}).`, def.severity, "exposure"));
        continue;
      }

      const { response, body } = result;
      // An HTML response can never be a real .env, .git/config, .sql dump
      // or JSON config, no matter what strings happen to appear inside
      // it. This one rule kills an entire class of false positive that
      // the baseline comparison alone doesn't catch: a site that routes
      // an unknown path to a *genuinely different* real page rather than
      // to one shared catch-all. github.com/swagger-ui.html, for
      // instance, is a real 200 profile page for a user named
      // "swagger-ui" - different length, different content, passes the
      // baseline test, and contains the word "swagger" in its title.
      const isHtml =
        /text\/html/i.test(response.headers.get("content-type") || "") || /^\s*<(?:!doctype|html)/i.test(body || "");
      const typeAllows = def.allowHtml === true || !isHtml;
      const present = response.status === 200 && typeAllows && def.signature(body || "") && !looksLikeBaseline(body, response, baseline);

      if (def.inverted) {
        findings.push(
          finding(
            def.check,
            present,
            present ? `${def.path} is published. ${def.detail}` : `No ${def.path} found. ${def.detail}`,
            def.severity,
            "exposure",
            present
              ? null
              : generalRemediation(
                  `Publish a ${def.path} with at least a Contact: field (an email or URL to report a vulnerability to) - a static text file at that path is the entire fix. See securitytxt.org for the format.`
                )
          )
        );
        continue;
      }

      findings.push(
        finding(
          def.check,
          !present,
          present
            ? `${def.path} is publicly readable and its contents match what that file normally looks like. ${def.detail}`
            : response.status === 200
              ? `${def.path} returns the site's catch-all page rather than a real file, so it isn't exposed.`
              : `${def.path} is not exposed (HTTP ${response.status}).`,
          def.severity,
          "exposure",
          present ? pathRemediation(def.path) : null
        )
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, definitions.length) }, worker));
  return findings;
}

// A real source map is a JSON document with a "mappings" or "sources"
// key. Checking that shape (rather than trusting a 200) is what keeps
// this from false-flagging a site whose catch-all page happens to answer
// /main.js.map with HTTP 200.
function looksLikeSourceMap(body) {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && ("mappings" in parsed || "sources" in parsed);
  } catch {
    return false;
  }
}

// Source maps map minified production JS back to original source -
// variable names, file layout, comments, sometimes whole modules that
// were never meant to ship. Bundlers emit them next to the script they
// describe (main.abc123.js -> main.abc123.js.map), so first-party script
// URLs already collected from the page are exactly what to check; there's
// no fixed well-known path the way there is for .env or .git/config.
//
// Capped at 6 scripts - deep chunked bundles can produce dozens of JS
// files, and this only needs to establish whether maps are being shipped
// at all, not enumerate every one.
async function auditSourceMaps(firstPartyScripts, budget) {
  const findings = [];
  const candidates = firstPartyScripts.filter((src) => !src.endsWith(".map")).slice(0, 6);
  if (candidates.length === 0) return findings;

  const exposed = [];
  let budgetExhausted = false;
  await Promise.all(
    candidates.map(async (src) => {
      const result = await safeFetch(`${src}.map`, budget, { redirect: "manual", readBody: true });
      if (!result) {
        budgetExhausted = true;
        return;
      }
      if (result.error) return;
      if (result.response.status === 200 && looksLikeSourceMap(result.body)) exposed.push(`${src}.map`);
    })
  );

  // Same reasoning as probePaths: running out of budget and finding
  // nothing are different outcomes, and only one of them is actually a
  // pass.
  if (exposed.length === 0 && budgetExhausted) {
    findings.push(finding("Source maps not publicly exposed", true, "Not checked - the scan's request budget was reached.", SEVERITY.INFO, "disclosure"));
    return findings;
  }

  findings.push(
    finding(
      "Source maps not publicly exposed",
      exposed.length === 0,
      exposed.length === 0
        ? `Checked ${candidates.length} first-party script${candidates.length === 1 ? "" : "s"} for a matching .map file - none found.`
        : `${exposed.length} source map${exposed.length === 1 ? "" : "s"} publicly readable, including ${exposed.slice(0, 2).join(", ")}${exposed.length > 2 ? ", ..." : ""}. These reconstruct close to the original, unminified source - variable names, file structure, and any comments left in. Most build tools (Vite, webpack, CRA) can be told not to emit maps in production, or to emit them without uploading to the public build output.`,
      SEVERITY.MEDIUM,
      "disclosure",
      exposed.length === 0
        ? null
        : generalRemediation(
            `Stop shipping source maps in the production build, or generate them for your own error-tracker upload without serving them publicly. Vite: build.sourcemap: false (or "hidden" to still generate without a //# sourceMappingURL comment). webpack: devtool: false, or "hidden-source-map" paired with uploading the map to your error tracker only. Next.js: productionBrowserSourceMaps: false (already the default).`
          )
    )
  );
  return findings;
}

// ---------------------------------------------------------------------
// Exposed secrets in shipped JS
// ---------------------------------------------------------------------

// Well-known, publicly documented key-format prefixes - the same kind
// of public pattern list gitleaks/truffleHog ship, not anything
// discovered by probing. Deliberately excludes formats a vendor itself
// documents as safe to expose client-side (Stripe's pk_ publishable
// keys, a domain-restricted Google Maps key) - flagging those would be
// noise, not signal. Only formats the vendor treats as a real secret
// are listed.
const SECRET_PATTERNS = [
  { name: "AWS access key ID", regex: /\bAKIA[0-9A-Z]{16}\b/g, severity: SEVERITY.CRITICAL },
  { name: "Stripe live secret key", regex: /\bsk_live_[0-9a-zA-Z]{20,}\b/g, severity: SEVERITY.CRITICAL },
  { name: "Stripe restricted key", regex: /\brk_live_[0-9a-zA-Z]{20,}\b/g, severity: SEVERITY.CRITICAL },
  { name: "Google OAuth client secret", regex: /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/g, severity: SEVERITY.CRITICAL },
  { name: "Slack token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,48}\b/g, severity: SEVERITY.CRITICAL },
  { name: "GitHub token", regex: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/g, severity: SEVERITY.CRITICAL },
  { name: "SendGrid API key", regex: /\bSG\.[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,}\b/g, severity: SEVERITY.HIGH },
  { name: "Mailgun API key", regex: /\bkey-[0-9a-f]{32}\b/g, severity: SEVERITY.HIGH },
  { name: "Square access token", regex: /\bsq0atp-[0-9A-Za-z_-]{20,}\b/g, severity: SEVERITY.HIGH },
  { name: "Private key block", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: SEVERITY.CRITICAL },
];

// Masks a matched secret for display - enough characters to identify
// which credential it is (so it can actually be found and rotated),
// nowhere near enough to reconstruct it from a report or a screenshot.
function maskSecret(value) {
  if (value.length <= 10) return "*".repeat(value.length);
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function scanForSecrets(text, source, seen) {
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text))) {
      // Same key committed to more than one bundle (a shared chunk, a
      // vendor file included twice) should count once, not once per file.
      const dedupeKey = `${pattern.name}:${match[0]}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      hits.push({ name: pattern.name, severity: pattern.severity, masked: maskSecret(match[0]), source });
    }
  }
  return hits;
}

// Passive by construction: this only reads the JS a browser already
// downloads to render the page, the same files auditSourceMaps() above
// fetches for the same reason. Nothing here sends a crafted request,
// authenticates as anyone, or tries a found credential against
// anything - it stops at "this looks like a live key and it's sitting
// in a public file," which is a fact anyone loading the page already
// has access to, not a probe of the site's own defenses.
async function auditSecrets(firstPartyScripts, budget) {
  const candidates = firstPartyScripts.slice(0, 6);
  if (candidates.length === 0) return [];

  const seen = new Set();
  const found = [];
  let budgetExhausted = false;

  await Promise.all(
    candidates.map(async (src) => {
      const result = await safeFetch(src, budget, { redirect: "follow", readBody: true });
      if (!result) {
        budgetExhausted = true;
        return;
      }
      if (result.error || !result.body) return;
      found.push(...scanForSecrets(result.body, src, seen));
    })
  );

  if (found.length === 0) {
    return [
      finding(
        "No exposed API keys/secrets in shipped JS",
        true,
        budgetExhausted
          ? "Not fully checked - the scan's request budget was reached."
          : `Checked ${candidates.length} first-party script${candidates.length === 1 ? "" : "s"} against known key formats (AWS, Stripe, GitHub, Slack, SendGrid, and others) - none found. This can't rule out formats the list doesn't cover, or a key assembled at runtime rather than sitting in the file as a literal string.`,
        SEVERITY.INFO,
        "supply-chain"
      ),
    ];
  }

  const worst = found.reduce((acc, f) => (severityRank(f.severity) < severityRank(acc.severity) ? f : acc));
  return [
    finding(
      "No exposed API keys/secrets in shipped JS",
      false,
      `${found.length} likely secret${found.length === 1 ? "" : "s"} found in shipped JavaScript: ${found.map((f) => `${f.name} (${f.masked})`).join(", ")}. Anything sent to the browser is public - these are not safe to ship client-side.`,
      worst.severity,
      "supply-chain",
      generalRemediation(
        `Rotate every key listed above now - it's already public, so rotation is the actual fix, not just removing it going forward. Move the real credential into a server-side environment variable and proxy whatever needs it through your own backend instead of calling the provider directly from the browser. If the provider offers a publishable or domain/scope-restricted key meant for client-side use (Stripe's pk_, a referrer-restricted Google API key), use that instead of the full secret.`
      )
    ),
  ];
}

// ---------------------------------------------------------------------
// API-shaped checks
// ---------------------------------------------------------------------

const CORS_PROBE_ORIGIN = "https://pulse-cors-probe.invalid";

async function probeApiSurface(url, origin, budget) {
  const findings = [];

  // CORS reflection: does the server echo an arbitrary Origin back, and
  // does it do so while allowing credentials? That combination means any
  // site a logged-in visitor lands on can read authenticated responses
  // from this API in their browser.
  //
  // Checked on both the OPTIONS preflight and a real GET with an Origin
  // header. Simple GETs never trigger a browser preflight at all, so some
  // servers only bother setting CORS headers on the actual response - a
  // preflight-only probe would call that a pass while the exposure is
  // real for exactly the requests that matter.
  const corsPreflight = await safeFetch(url, budget, {
    method: "OPTIONS",
    redirect: "manual",
    headers: { origin: CORS_PROBE_ORIGIN, "access-control-request-method": "GET" },
  });
  const corsActual = await safeFetch(url, budget, {
    method: "GET",
    redirect: "manual",
    headers: { origin: CORS_PROBE_ORIGIN },
  });

  function evaluateCors(result) {
    if (!result || result.error) return null;
    const allowOrigin = result.response.headers.get("access-control-allow-origin");
    const allowCredentials = (result.response.headers.get("access-control-allow-credentials") || "").toLowerCase() === "true";
    return { allowOrigin, allowCredentials, reflects: allowOrigin === CORS_PROBE_ORIGIN, wildcard: allowOrigin === "*" };
  }

  const preflightCors = evaluateCors(corsPreflight);
  const actualCors = evaluateCors(corsActual);
  const corsResults = [
    preflightCors && { ...preflightCors, via: "preflight" },
    actualCors && { ...actualCors, via: "actual response" },
  ].filter(Boolean);

  if (corsResults.length > 0) {
    const rank = (r) => (r.reflects && r.allowCredentials ? 0 : r.reflects ? 1 : r.wildcard && r.allowCredentials ? 2 : 3);
    const worst = corsResults.reduce((acc, r) => (rank(r) < rank(acc) ? r : acc));
    // Only worth calling out where the check found it if the two probes
    // actually disagreed - otherwise it's noise on top of a consistent
    // result.
    const disagreement =
      corsResults.length === 2 && (preflightCors.reflects !== actualCors.reflects || preflightCors.allowCredentials !== actualCors.allowCredentials)
        ? ` (seen on the ${worst.via} only - checked both since they can differ)`
        : "";

    if (worst.reflects && worst.allowCredentials) {
      findings.push(
        finding(
          "CORS policy not overly permissive",
          false,
          `The server reflected an arbitrary Origin back in Access-Control-Allow-Origin and set Access-Control-Allow-Credentials: true${disagreement}. Any website a logged-in user visits can read authenticated responses from this endpoint. This is usually a reflect-the-origin CORS config that was only ever meant to say "allow my own frontend".`,
          SEVERITY.CRITICAL,
          "api",
          generalRemediation(
            `Replace the reflect-any-origin logic with an explicit allowlist of the origin(s) that should actually be allowed, and only set Access-Control-Allow-Credentials: true for those. Express (cors package): cors({ origin: ["https://yourapp.com"], credentials: true }) instead of origin: true or a function that echoes req.headers.origin unconditionally.`
          )
        )
      );
    } else if (worst.reflects) {
      findings.push(
        finding(
          "CORS policy not overly permissive",
          false,
          `The server reflects any Origin it's given back in Access-Control-Allow-Origin${disagreement}. Much less serious without credentials allowed, but it means the allowlist isn't actually an allowlist.`,
          SEVERITY.MEDIUM,
          "api",
          generalRemediation(
            `Replace the reflect-any-origin logic with an explicit allowlist of the origin(s) that should actually be allowed. Express (cors package): cors({ origin: ["https://yourapp.com"] }) instead of origin: true or a function that echoes req.headers.origin unconditionally.`
          )
        )
      );
    } else if (worst.wildcard && worst.allowCredentials) {
      findings.push(
        finding(
          "CORS policy not overly permissive",
          false,
          `Access-Control-Allow-Origin is * alongside Allow-Credentials: true${disagreement}. Browsers reject that combination outright, so this is likely breaking your own frontend as well.`,
          SEVERITY.MEDIUM,
          "api",
          generalRemediation(
            `Replace the wildcard with an explicit allowlist of the origin(s) that need credentialed access - a wildcard can't legally be paired with Allow-Credentials: true anyway, so this is very likely already broken for whatever it was meant to serve. Express (cors package): cors({ origin: ["https://yourapp.com"], credentials: true }).`
          )
        )
      );
    } else {
      findings.push(
        finding(
          "CORS policy not overly permissive",
          true,
          worst.allowOrigin ? `An unknown origin got "${worst.allowOrigin}" back, not a reflection of itself.` : "The server didn't grant CORS access to an unknown origin.",
          SEVERITY.CRITICAL,
          "api"
        )
      );
    }
  }

  // TRACE is essentially never needed and has a history of being used to
  // read headers a script shouldn't be able to see.
  const trace = await safeFetch(url, budget, { method: "TRACE", redirect: "manual" });
  if (trace && !trace.error) {
    const enabled = trace.response.status === 200;
    findings.push(
      finding(
        "HTTP TRACE disabled",
        !enabled,
        enabled
          ? "The server answers TRACE requests, which echo the request back including its headers. There's no reason to leave this enabled."
          : `TRACE is rejected (HTTP ${trace.response.status}).`,
        SEVERITY.LOW,
        "api",
        enabled
          ? generalRemediation(
              `Disable the TRACE method wherever the request is being terminated. nginx: add a rule returning 405 for $request_method = TRACE. Most Node frameworks don't implement TRACE themselves, so if it's answering, it's most likely happening at a reverse proxy/load balancer in front of the app - check there first.`
            )
          : null
      )
    );
  }

  // GraphQL introspection. Only reported if something is actually
  // listening at /graphql, otherwise it would be noise on every site that
  // doesn't use GraphQL.
  //
  // The test is deliberately "does this parse as JSON with a populated
  // data.__schema", not "does the string __schema appear in the body."
  // The looser version false-positives on any site that echoes the
  // request URL back into its own HTML - github.com/graphql?query=...
  // renders a normal 200 page with the query string sitting in an
  // apple-itunes-app meta tag, which the string check happily read as a
  // live introspection endpoint.
  const graphql = await safeFetch(`${origin}/graphql?query=${encodeURIComponent("{__schema{queryType{name}}}")}`, budget, {
    redirect: "manual",
    readBody: true,
  });
  const introspectionOpen = (() => {
    if (!graphql || graphql.error || graphql.response.status !== 200) return false;
    if (!/application\/(graphql-response\+)?json/i.test(graphql.response.headers.get("content-type") || "")) return false;
    try {
      return !!JSON.parse(graphql.body || "")?.data?.__schema;
    } catch {
      return false;
    }
  })();
  if (introspectionOpen) {
    findings.push(
      finding(
        "GraphQL introspection disabled in production",
        false,
        "The /graphql endpoint answers introspection queries, which hands over the complete schema: every type, field and mutation, including ones no client is meant to call.",
        SEVERITY.MEDIUM,
        "api",
        generalRemediation(
          `Disable introspection in production. Apollo Server: introspection: false (or gate it behind NODE_ENV !== "production"). graphql-yoga / envelop: the disableIntrospection plugin. Keep it enabled in dev/staging where it's genuinely useful.`
        )
      )
    );
  }

  return findings;
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

export async function scanSite(url, options = {}) {
  const budget = new RequestBudget(MAX_REQUESTS);
  const findings = [];

  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    const failed = [finding("Site reachable", false, `Could not scan: ${err.message}`, SEVERITY.CRITICAL, "transport")];
    return { score: 0, grade: "F", findings: failed, summary: summarize(failed), meta: { scannedUrl: url, reachable: false } };
  }

  // An API that requires auth answers with a 401 whose headers may differ
  // from the real thing, so the monitor's own auth header is reused for
  // the main request when it has one. Only ever sent to the monitor's own
  // origin - never to any third party.
  const headers = {};
  if (options.authHeaderName && options.authHeaderValue) headers[options.authHeaderName] = options.authHeaderValue;

  const main = await safeFetch(url, budget, { redirect: "follow", readBody: true, timeoutMs: MAIN_REQUEST_TIMEOUT_MS, headers });
  if (!main || main.error) {
    const failed = [finding("Site reachable", false, `Could not connect: ${main?.error?.message ?? "no response"}`, SEVERITY.CRITICAL, "transport")];
    return { score: 0, grade: "F", findings: failed, summary: summarize(failed), meta: { scannedUrl: url, reachable: false } };
  }

  const { response, body } = main;
  const finalUrl = response.url || url;
  const isHttps = finalUrl.startsWith("https://");
  const origin = new URL(finalUrl).origin;

  // The URL given to scanSite() just passed the check above, but this
  // scan is about to fire dozens more requests (every path in
  // EXPOSED_PATHS/API_SURFACE_PATHS, CORS/TRACE/GraphQL probes) against
  // `origin` specifically, which can differ from `url` if the first
  // request redirected somewhere else. Re-checking origin here closes
  // that gap - a single accepted redirect to an internal address would
  // otherwise turn into the full scan's worth of requests landing there
  // instead of one.
  if (origin !== new URL(url).origin) {
    try {
      await assertPublicHttpUrl(origin);
    } catch (err) {
      const failed = [finding("Site reachable", false, `Redirects to an address this scan won't follow: ${err.message}`, SEVERITY.CRITICAL, "transport")];
      return { score: 0, grade: "F", findings: failed, summary: summarize(failed), meta: { scannedUrl: url, reachable: false } };
    }
  }

  findings.push(
    finding(
      "Serves over HTTPS",
      isHttps,
      isHttps
        ? "The site loads over HTTPS."
        : "The site does not serve over HTTPS. Everything sent to or from it, credentials and session cookies included, travels in plain text.",
      SEVERITY.CRITICAL,
      "transport",
      isHttps
        ? null
        : generalRemediation(
            `Put the site behind TLS. Every major host (Vercel, Netlify, Render, Cloudflare) issues and renews a free certificate automatically once a domain points at them; on self-managed infrastructure, Let's Encrypt via certbot is the free equivalent.`
          )
    )
  );

  // A site can serve HTTPS perfectly well and still answer on port 80
  // with a 200, which means anyone on the network path can serve their
  // own version instead.
  if (isHttps) {
    const plain = await safeFetch(origin.replace(/^https:/, "http:"), budget, { redirect: "manual" });
    if (plain && !plain.error) {
      const location = plain.response.headers.get("location") || "";
      const redirects = plain.response.status >= 300 && plain.response.status < 400 && location.startsWith("https://");
      findings.push(
        finding(
          "HTTP redirects to HTTPS",
          redirects,
          redirects
            ? `Plain HTTP returns ${plain.response.status} to the HTTPS version.`
            : `Plain HTTP returned ${plain.response.status} instead of redirecting to HTTPS, so the unencrypted version of the site is still being served.`,
          SEVERITY.HIGH,
          "transport",
          redirects
            ? null
            : generalRemediation(
                `Add a redirect from plain HTTP to the HTTPS version at whatever's terminating TLS. Most hosts with a "Force HTTPS" toggle (Vercel, Netlify, Cloudflare) already do this once it's turned on; self-managed nginx needs a "return 301 https://$host$request_uri;" server block on port 80.`
              )
        )
      );
    }
  }

  const csp = response.headers.get("content-security-policy");
  findings.push(gradeHsts(response.headers.get("strict-transport-security")));
  findings.push(gradeCsp(csp));
  findings.push(gradeFrameOptions(response.headers.get("x-frame-options"), csp));
  findings.push(gradeContentTypeOptions(response.headers.get("x-content-type-options")));
  findings.push(gradeReferrerPolicy(response.headers.get("referrer-policy")));
  findings.push(gradePermissionsPolicy(response.headers.get("permissions-policy")));
  findings.push(...auditCookies(response, isHttps));
  findings.push(...auditDisclosure(response));

  const { findings: htmlFindings, thirdPartyOrigins, firstPartyScripts } = analyzeHtml(body, finalUrl);
  findings.push(...htmlFindings);
  findings.push(...(await auditSourceMaps(firstPartyScripts, budget)));

  const baseline = await establishBaseline(origin, budget);
  findings.push(...(await probePaths(origin, budget, baseline, EXPOSED_PATHS)));
  findings.push(...(await probePaths(origin, budget, baseline, API_SURFACE_PATHS)));
  findings.push(...(await probeApiSurface(finalUrl, origin, budget)));
  // Runs last and deliberately gets whatever request budget is left
  // rather than a reserved slice of it - the checks above (exposed
  // files, header posture) are more established and more certain, so
  // they're never the ones that get squeezed on a script-heavy site.
  // auditSecrets already degrades to an honest "not fully checked"
  // rather than a false pass when it runs out of room.
  findings.push(...(await auditSecrets(firstPartyScripts, budget)));

  const sorted = sortFindings(findings);
  const score = scoreFindings(sorted);

  return {
    score,
    grade: gradeFor(score, sorted),
    findings: sorted,
    summary: summarize(sorted),
    meta: {
      scannedUrl: url,
      finalUrl,
      reachable: true,
      thirdPartyOrigins,
      requestsUsed: MAX_REQUESTS - budget.remaining,
    },
  };
}
