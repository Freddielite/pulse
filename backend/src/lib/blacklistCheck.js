// Google Safe Browsing v4 "lookup" check - is this URL currently on
// Google's lists for malware, phishing (social engineering), unwanted
// software, or potentially harmful applications. Free, but unlike crt.sh
// or a plain DNS lookup, there's no keyless anonymous path for it - a
// GOOGLE_SAFE_BROWSING_API_KEY is required. The check is skipped
// entirely (never scored, never alerted, monitors.blacklist_status stays
// NULL) when the key isn't set, so a deployment without it reads as
// "not checked" rather than a false "clean".

const API_ROOT = "https://safebrowsing.googleapis.com/v4/threatMatches:find";
const REQUEST_TIMEOUT_MS = 8000;

export function blacklistCheckConfigured() {
  return !!process.env.GOOGLE_SAFE_BROWSING_API_KEY;
}

export async function checkBlacklist(url) {
  const apiKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY;
  if (!apiKey) return { status: "unknown", threats: [], reason: "Safe Browsing not configured" };

  const body = {
    client: { clientId: "pulse-uptime-monitor", clientVersion: "1.0" },
    threatInfo: {
      threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
      platformTypes: ["ANY_PLATFORM"],
      threatEntryTypes: ["URL"],
      threatEntries: [{ url }],
    },
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(`${API_ROOT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      console.error(`Safe Browsing returned ${response.status}`);
      return { status: "unknown", threats: [], reason: `API returned ${response.status}` };
    }
    const data = await response.json();
    const matches = data.matches || [];
    if (matches.length === 0) return { status: "clean", threats: [] };
    return { status: "flagged", threats: [...new Set(matches.map((m) => m.threatType))] };
  } catch (err) {
    console.error("Safe Browsing lookup failed:", err.message);
    return { status: "unknown", threats: [], reason: err.message };
  }
}
