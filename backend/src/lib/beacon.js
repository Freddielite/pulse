// Privacy-first pageview beacon: no cookies, no localStorage, no IP stored,
// no cross-site tracking. Just which monitor, which page, the referrer's
// domain only, and a coarse browser/OS guess from the user-agent.
// Ported from wyntek-status's analytics.ts.

export const BEACON_SCRIPT = `
(function () {
  var siteId = document.currentScript.getAttribute('data-site');
  if (!siteId) return;
  var payload = JSON.stringify({
    site_id: siteId,
    path: location.pathname,
    referrer: document.referrer ? new URL(document.referrer).hostname : '',
    ua: navigator.userAgent
  });
  var url = document.currentScript.src.replace('/beacon.js', '/collect');
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
  } else {
    fetch(url, { method: 'POST', body: payload, keepalive: true });
  }
})();
`.trim();

export function parseUserAgent(ua) {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Other";

  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "Other";

  return { browser, os };
}
