// Passive security scanner: header inspection and GETs of well-known paths
// to see if something's publicly exposed that shouldn't be. Nothing here
// attempts to exploit anything, it only reads response status/headers.
// Ported from the wyntek-status Cloudflare Worker's scanner.ts, kept
// deliberately identical in checks/scoring so results stay comparable if
// you ever run both.

const SECURITY_HEADERS = [
  { header: "strict-transport-security", check: "HSTS enabled", advice: "Add Strict-Transport-Security header to force HTTPS." },
  { header: "content-security-policy", check: "CSP present", advice: "Add a Content-Security-Policy header to reduce XSS risk." },
  { header: "x-frame-options", check: "Clickjacking protection", advice: "Add X-Frame-Options or frame-ancestors CSP directive." },
  { header: "x-content-type-options", check: "MIME sniffing blocked", advice: "Add X-Content-Type-Options: nosniff." },
  { header: "referrer-policy", check: "Referrer policy set", advice: "Add a Referrer-Policy header to limit referrer leakage." },
  { header: "permissions-policy", check: "Permissions policy set", advice: "Add a Permissions-Policy header to restrict browser features." },
];

// Common paths that should never return 200 on a production site.
const EXPOSED_PATH_CHECKS = [
  { path: "/.env", check: "No exposed .env file" },
  { path: "/.git/config", check: "No exposed .git directory" },
  { path: "/wp-config.php.bak", check: "No exposed backup config" },
  { path: "/.aws/credentials", check: "No exposed AWS credentials file" },
];

export async function scanSite(url) {
  const findings = [];

  // --- HTTPS check ---
  let mainRes = null;
  try {
    mainRes = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000) });
    const finalIsHttps = mainRes.url.startsWith("https://");
    findings.push({
      check: "Serves over HTTPS",
      pass: finalIsHttps,
      detail: finalIsHttps ? "Site loads over HTTPS." : "Site does not enforce HTTPS.",
    });
  } catch (e) {
    findings.push({ check: "Site reachable", pass: false, detail: `Could not connect: ${e.message}` });
    return { score: 0, findings };
  }

  // --- Security headers ---
  for (const { header, check, advice } of SECURITY_HEADERS) {
    const present = mainRes.headers.has(header);
    findings.push({ check, pass: present, detail: present ? `${header} header present.` : advice });
  }

  // --- Server header disclosure ---
  const serverHeader = mainRes.headers.get("server") ?? "";
  const leaksVersion = /\d/.test(serverHeader);
  findings.push({
    check: "No version info in Server header",
    pass: !leaksVersion,
    detail: leaksVersion
      ? `Server header reveals version info: "${serverHeader}"`
      : "Server header does not disclose version details.",
  });

  // --- Exposed sensitive paths ---
  const base = new URL(url).origin;
  for (const { path, check } of EXPOSED_PATH_CHECKS) {
    try {
      const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(6_000) });
      const exposed = res.status === 200;
      findings.push({
        check,
        pass: !exposed,
        detail: exposed ? `${path} is publicly accessible (HTTP 200), should be blocked.` : `${path} is not exposed.`,
      });
    } catch {
      // Network error fetching the path just means we can't confirm, treat as pass, not a finding worth flagging.
      findings.push({ check, pass: true, detail: `${path} not reachable (fine).` });
    }
  }

  const passed = findings.filter((f) => f.pass).length;
  const score = Math.round((passed / findings.length) * 100);

  return { score, findings };
}
