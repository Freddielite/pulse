import dns from "node:dns/promises";

// Vercel's own documented, stable custom-domain CNAME target - the same
// value for any Vercel project, not something specific to this app's
// deployment. A status page's custom domain is expected to be a
// subdomain (status.client.com), which is why this only checks CNAME -
// a bare apex domain would need Vercel's A records instead, and isn't
// supported here (nobody points a bare root domain at a single status
// page in practice).
const VERCEL_CNAME_TARGET = "cname.vercel-dns.com";

export async function verifyCustomDomain(hostname) {
  try {
    const records = await dns.resolveCname(hostname);
    const pointsAtVercel = records.some((r) => r.toLowerCase().replace(/\.$/, "") === VERCEL_CNAME_TARGET);
    if (pointsAtVercel) return { verified: true };
    return { verified: false, reason: `That domain's CNAME points at ${records.join(", ")}, not ${VERCEL_CNAME_TARGET}.` };
  } catch (err) {
    const notFound = err.code === "ENODATA" || err.code === "ENOTFOUND";
    return { verified: false, reason: notFound ? "No CNAME record found for that domain yet." : `Couldn't check DNS: ${err.message}` };
  }
}

// The one step DNS verification alone can't replace: Vercel only
// terminates TLS and actually serves traffic for a hostname once the
// PROJECT itself has claimed that domain via its dashboard or API -
// pointing DNS at Vercel isn't enough by itself, regardless of how
// correctly it's pointed. This automates that claim when credentials
// are configured; without them, the caller falls back to telling the
// org owner to add it in the Vercel dashboard themselves (Project ->
// Settings -> Domains) - this feature works either way, just with a
// manual step in one case and not the other.
export async function registerDomainWithVercel(hostname) {
  const token = process.env.VERCEL_API_TOKEN?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (!token || !projectId) return { attempted: false };

  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  const url = `https://api.vercel.com/v10/projects/${projectId}/domains${teamId ? `?teamId=${teamId}` : ""}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: hostname }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return { attempted: true, added: true };
    // Vercel's response when the domain is already registered to this
    // exact project - a no-op, not a failure (this happens on every
    // re-verification after the first successful one).
    if (body?.error?.code === "domain_already_in_use" && String(body?.error?.projectId) === String(projectId)) {
      return { attempted: true, added: true };
    }
    return { attempted: true, added: false, error: body?.error?.message || `Vercel API returned ${response.status}` };
  } catch (err) {
    return { attempted: true, added: false, error: err.message };
  }
}
