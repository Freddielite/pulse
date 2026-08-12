import { SECURITY_HEADERS } from "./scanner.js";
import { getDefaultBranch, getFile, createBranch, putFile, openPullRequest } from "./github.js";

// What Pulse is willing to write into someone else's repo, and how each
// one behaves if it's wrong. The other five are safe defaults - at worst
// a no-op if a site doesn't need them. CSP is different: too strict a
// value can genuinely break a site (block a script or font tag it
// actually loads), not just fail to help. It stays in the fixable set
// (it's a real, common finding) but every caller here treats it as the
// one to call out explicitly before a PR gets merged, not bundle in
// silently with the rest.
export const HEADER_FIXES = {
  "strict-transport-security": { value: "max-age=63072000; includeSubDomains; preload", risky: false },
  "content-security-policy": { value: "default-src 'self'", risky: true },
  "x-frame-options": { value: "DENY", risky: false },
  "x-content-type-options": { value: "nosniff", risky: false },
  "referrer-policy": { value: "strict-origin-when-cross-origin", risky: false },
  "permissions-policy": { value: "geolocation=(), microphone=(), camera=()", risky: false },
};

const CHECK_TO_HEADER = Object.fromEntries(SECURITY_HEADERS.map((h) => [h.check, h.header]));

export function headerForCheck(checkName) {
  return CHECK_TO_HEADER[checkName] || null;
}

// "x-frame-options" -> "X-Frame-Options" - how a human reviewing the PR
// expects to see it written, even though the wire format is
// case-insensitive either way.
function headerNameCase(header) {
  return header.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("-");
}

async function detectStack(token, repo, branch) {
  if (await getFile(token, repo, "vercel.json", branch)) return "vercel";
  const renderYaml = await getFile(token, repo, "render.yaml", branch);
  if (renderYaml && /type:\s*static/.test(renderYaml.content)) return "render-static";
  if (await getFile(token, repo, "package.json", branch)) return "node";
  return null;
}

function buildVercelPatch(existingJson, headersToAdd) {
  const config = existingJson ? JSON.parse(existingJson) : {};
  config.headers = config.headers || [];
  // Extend an existing catch-all rule rather than adding a second one
  // that'd just fight it for precedence.
  let rule = config.headers.find((h) => h.source === "/(.*)");
  if (!rule) {
    rule = { source: "/(.*)", headers: [] };
    config.headers.push(rule);
  }
  const existingKeys = new Set(rule.headers.map((h) => h.key.toLowerCase()));
  for (const [header, { value }] of Object.entries(headersToAdd)) {
    if (existingKeys.has(header)) continue;
    rule.headers.push({ key: headerNameCase(header), value });
  }
  return JSON.stringify(config, null, 2) + "\n";
}

// Heuristic text patch, not a real YAML parse: finds the first
// top-level "headers:" list under the static site definition and
// appends to it, or inserts a fresh one right after "type: static" if
// there isn't one yet. This is exactly the kind of edit that's fine to
// get roughly right because a human reviews the diff before merging -
// not something to trust unreviewed.
function patchRenderYaml(yamlText, headersToAdd) {
  const additions = Object.entries(headersToAdd)
    .map(([h, { value }]) => `      - path: /*\n        name: ${headerNameCase(h)}\n        value: ${JSON.stringify(value)}`)
    .join("\n");
  if (/headers:\s*\n/.test(yamlText)) {
    return yamlText.replace(/headers:\s*\n/, (m) => `${m}${additions}\n`);
  }
  return yamlText.replace(/(type:\s*static.*\n)/, (m) => `${m}    headers:\n${additions}\n`);
}

function buildNodeMiddleware(headersToAdd) {
  const lines = Object.entries(headersToAdd)
    .map(([header, { value }]) => `  res.setHeader(${JSON.stringify(headerNameCase(header))}, ${JSON.stringify(value)});`)
    .join("\n");
  return `// Added by Pulse - see the PR this shipped in for which finding(s)
// this addresses. This file alone doesn't do anything until it's
// mounted - add the line below near your other app.use(...) calls,
// before your routes:
//
//   app.use(require('./security-headers'));
//
module.exports = function securityHeaders(req, res, next) {
${lines}
  next();
};
`;
}

function listMd(headers) {
  return Object.entries(headers).map(([h, { value }]) => `- \`${headerNameCase(h)}: ${value}\``).join("\n");
}

function baseBody(headers, riskyList) {
  let body = `Opened automatically by Pulse from a failing security scan.\n\nHeaders added:\n${listMd(headers)}`;
  if (riskyList.length) {
    body += `\n\n**Review before merging:** ${riskyList.map(headerNameCase).join(", ")} can change site behavior (e.g. a strict Content-Security-Policy can block a script or font tag your site actually uses) - this is a reasonable starting value, not guaranteed to fit this site as-is.`;
  }
  return body;
}

// Runs the whole fix flow for one monitor: detect (or reuse a cached)
// stack, build the right file change for whichever findings were
// requested, commit it to a new branch, open a PR. Never touches the
// default branch directly - the PR is always the artifact, merging it
// is a decision left to whoever reviews it.
export async function runRemediation({ token, repo, checkNames, cachedStack }) {
  const defaultBranch = await getDefaultBranch(token, repo);
  const stack = cachedStack || (await detectStack(token, repo, defaultBranch));
  if (!stack) {
    const err = new Error("Couldn't detect a supported stack in this repo (looked for vercel.json, a static render.yaml, or package.json).");
    err.code = "UNSUPPORTED_STACK";
    throw err;
  }

  const headers = Object.fromEntries(
    checkNames
      .map((name) => headerForCheck(name))
      .filter((header) => header && HEADER_FIXES[header])
      .map((header) => [header, HEADER_FIXES[header]])
  );
  if (Object.keys(headers).length === 0) {
    const err = new Error("None of the requested findings are ones Pulse knows how to fix.");
    err.code = "NOTHING_TO_FIX";
    throw err;
  }
  const riskyList = Object.entries(headers).filter(([, h]) => h.risky).map(([header]) => header);

  const branchName = `pulse/security-headers-${Date.now()}`;
  await createBranch(token, repo, branchName, defaultBranch);

  let filePath, prBody;
  if (stack === "vercel") {
    filePath = "vercel.json";
    const existing = await getFile(token, repo, filePath, branchName);
    const content = buildVercelPatch(existing?.content, headers);
    await putFile(token, repo, filePath, branchName, content, "Add missing security headers (via Pulse)", existing?.sha);
    prBody = baseBody(headers, riskyList) + `\n\nAdded/extended the catch-all rule in \`vercel.json\`.`;
  } else if (stack === "render-static") {
    filePath = "render.yaml";
    const existing = await getFile(token, repo, filePath, branchName);
    const content = patchRenderYaml(existing.content, headers);
    await putFile(token, repo, filePath, branchName, content, "Add missing security headers (via Pulse)", existing.sha);
    prBody = baseBody(headers, riskyList) + `\n\nAdded to the \`headers\` list in \`render.yaml\`. This is a best-effort text patch on YAML, not a full parse - please double-check it landed in the right place before merging.`;
  } else {
    filePath = "security-headers.js";
    const content = buildNodeMiddleware(headers);
    await putFile(token, repo, filePath, branchName, content, "Add security-headers middleware (via Pulse)");
    prBody = baseBody(headers, riskyList) + `\n\nAdded a new \`security-headers.js\` file. **It doesn't do anything until it's mounted** - see the comment at the top of the file for the one line to add.`;
  }

  const prUrl = await openPullRequest(token, repo, {
    title: "Add missing security headers",
    head: branchName,
    base: defaultBranch,
    body: prBody,
  });

  return { prUrl, stack };
}
