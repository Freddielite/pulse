// Deliberately not the octokit SDK - remediation.js only ever needs six
// calls, and plain fetch against the REST API keeps this dependency-free
// (everything else in backend/ that talks HTTP out, like scanner.js and
// syntheticCheck.js, already just uses fetch directly too).
const API = "https://api.github.com";

async function gh(token, path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`GitHub API ${options.method || "GET"} ${path} failed: ${res.status} ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function getDefaultBranch(token, repo) {
  const data = await gh(token, `/repos/${repo}`);
  return data.default_branch;
}

// { content: <decoded utf8 string>, sha } or null if the file doesn't
// exist at that ref - null (not a thrown 404) because "the file isn't
// there yet" is an expected, normal case for detectStack() and for a
// first-time vercel.json, not an error condition.
export async function getFile(token, repo, path, ref) {
  try {
    const data = await gh(token, `/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
    return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

export async function createBranch(token, repo, newBranch, fromBranch) {
  const base = await gh(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`);
  await gh(token, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: base.object.sha }),
  });
}

// sha is required when overwriting an existing file, omitted when
// creating a new one - GitHub's contents API uses its presence/absence
// to tell the two apart.
export async function putFile(token, repo, path, branch, content, message, sha) {
  await gh(token, `/repos/${repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
}

export async function openPullRequest(token, repo, { title, head, base, body }) {
  const data = await gh(token, `/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body }),
  });
  return data.html_url;
}
