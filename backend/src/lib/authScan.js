import { finding, scanSite } from "./scanner.js";
import { SEVERITY, sortFindings, scoreFindings, gradeFor, summarize } from "./severity.js";
import { assertPublicHttpUrl } from "./urlSafety.js";
import { decryptCredential } from "./credentialCrypto.js";

const REQUEST_TIMEOUT_MS = 10000;

// Two credential shapes, both things a person can copy out of their own
// browser's dev tools after logging in themselves - never a username/
// password pair this app would submit through a login form on their
// behalf. Automating an actual login is fragile (every site's form is
// different) and a bigger trust step than this feature needs: a
// provided session cookie or bearer token proves the same thing
// (someone with legitimate access chose to hand it over) without Pulse
// ever touching a password.
function toAuthHeader(credential) {
  if (credential.type === "bearer") return { name: "Authorization", value: `Bearer ${credential.value}` };
  if (credential.type === "cookie") return { name: "Cookie", value: `${credential.name}=${credential.value}` };
  return null;
}

// Fetches a path with NO credential attached and reports whether it
// looks protected - this is the entire authenticated-scan feature's
// safety boundary. It only ever checks paths the monitor owner
// themselves typed in as "this should require login," and it only ever
// asks "does removing my credential get me rejected," never anything
// that resembles guessing, fuzzing, or trying to get further than an
// anonymous visitor should. Confirming a stated protection is real is a
// fundamentally different (and safe) kind of check than looking for new
// ones that were never claimed to exist.
async function checkPathRequiresAuth(origin, path) {
  let url;
  try {
    url = new URL(path, origin).toString();
    await assertPublicHttpUrl(url);
  } catch (err) {
    return { path, looksProtected: null, error: err.message };
  }
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const location = response.headers.get("location") || "";
    const looksProtected =
      response.status === 401 ||
      response.status === 403 ||
      ((response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) &&
        /login|signin|sign-in|auth/i.test(location));
    return { path, looksProtected, status: response.status };
  } catch (err) {
    return { path, looksProtected: null, error: err.message };
  }
}

// monitor.auth_scan_credential is the encrypted blob from db.js;
// decrypted here (right before use) rather than by the caller, so a
// caller that only needs findings never has the plaintext credential
// pass through its hands at all.
export async function runAuthenticatedScan(monitor) {
  const findings = [];
  const protectedPaths = monitor.auth_scan_protected_paths || [];
  let origin;
  try {
    origin = new URL(monitor.url).origin;
  } catch {
    return {
      score: 0,
      grade: "F",
      findings: [finding("Authenticated scan completed", false, "Monitor URL isn't a valid URL.", SEVERITY.LOW, "access-control")],
      summary: summarize([]),
    };
  }

  for (const path of protectedPaths) {
    const result = await checkPathRequiresAuth(origin, path);
    if (result.looksProtected === false) {
      findings.push(
        finding(
          `${path} requires authentication`,
          false,
          `Listed as requiring authentication, but an anonymous request got HTTP ${result.status} instead of being rejected. Anyone can reach this without logging in.`,
          SEVERITY.CRITICAL,
          "access-control"
        )
      );
    } else if (result.looksProtected === true) {
      findings.push(
        finding(`${path} requires authentication`, true, `Correctly rejects an anonymous request (HTTP ${result.status}).`, SEVERITY.INFO, "access-control")
      );
    }
    // looksProtected === null (couldn't even complete the request) is
    // deliberately not scored either way - an unreachable path is not
    // the same fact as an unprotected one, and shouldn't move the grade
    // as if it were.
  }

  let credential;
  try {
    credential = JSON.parse(decryptCredential(monitor.auth_scan_credential));
  } catch (err) {
    findings.push(finding("Authenticated scan completed", false, `Could not decrypt the stored credential: ${err.message}`, SEVERITY.LOW, "access-control"));
    const scored = sortFindings(findings);
    return { score: scoreFindings(scored), grade: gradeFor(scoreFindings(scored), scored), findings: scored, summary: summarize(scored) };
  }

  const header = toAuthHeader(credential);
  // Re-runs the exact same passive checks the anonymous scan already
  // does (header grading, exposed paths, secret scanning, and the
  // rest), just with the credential attached - the one thing an
  // anonymous scan structurally cannot do is see what's actually on an
  // authenticated page, since it never gets past login. Deliberately
  // the same check set and the same severity scale as the free scan,
  // not a separate "authenticated-only" rulebook - a logged-in page
  // that ships a secret in its JS is exactly as bad as a public one
  // doing the same thing.
  if (header) {
    try {
      const authScan = await scanSite(monitor.url, { authHeaderName: header.name, authHeaderValue: header.value });
      findings.push(...authScan.findings);
    } catch (err) {
      findings.push(finding("Authenticated scan completed", false, `Could not complete the authenticated portion: ${err.message}`, SEVERITY.LOW, "access-control"));
    }
  }

  const scored = sortFindings(findings);
  const score = scoreFindings(scored);
  return { score, grade: gradeFor(score, scored), findings: scored, summary: summarize(scored) };
}
