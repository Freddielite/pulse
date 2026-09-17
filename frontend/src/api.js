export const BASE = import.meta.env.VITE_API_URL || "/api";

async function apiFetch(path, options = {}) {
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      ...fetchOptions,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out. Check your connection and try again.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      // response wasn't JSON, keep the generic message
    }
    throw new Error(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const signup = (payload) => apiFetch("/auth/signup", { method: "POST", body: JSON.stringify(payload) });
export const verifyEmail = (token) => apiFetch("/auth/verify-email", { method: "POST", body: JSON.stringify({ token }) });
export const login = (payload) => apiFetch("/auth/login", { method: "POST", body: JSON.stringify(payload) });
export const logout = () => apiFetch("/auth/logout", { method: "POST" });
export const getMe = () => apiFetch("/auth/me");
export const updateMe = (payload) => apiFetch("/auth/me", { method: "PATCH", body: JSON.stringify(payload) });
export const changePassword = (payload) => apiFetch("/auth/change-password", { method: "POST", body: JSON.stringify(payload) });
export const verifyLoginTotp = (payload) => apiFetch("/auth/2fa/verify-login", { method: "POST", body: JSON.stringify(payload) });
export const setup2fa = () => apiFetch("/auth/2fa/setup", { method: "POST" });
export const confirm2fa = (code) => apiFetch("/auth/2fa/confirm", { method: "POST", body: JSON.stringify({ code }) });
export const disable2fa = (password) => apiFetch("/auth/2fa/disable", { method: "POST", body: JSON.stringify({ password }) });
export const testWebhook = () => apiFetch("/auth/webhook-test", { method: "POST" });

export const listMonitors = () => apiFetch("/monitors");
export const checkNow = () => apiFetch("/monitors/check-now", { method: "POST", timeoutMs: 40000 });
export const createMonitor = (payload) => apiFetch("/monitors", { method: "POST", body: JSON.stringify(payload) });
export const updateMonitor = (id, payload) => apiFetch(`/monitors/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const snoozeMonitor = (id, minutes) => apiFetch(`/monitors/${id}/snooze`, { method: "POST", body: JSON.stringify({ minutes }) });
export const unsnoozeMonitor = (id) => apiFetch(`/monitors/${id}/unsnooze`, { method: "POST" });
export const snoozeAllMonitors = (minutes) => apiFetch("/monitors/snooze-all", { method: "POST", body: JSON.stringify({ minutes }) });
export const unsnoozeAllMonitors = () => apiFetch("/monitors/unsnooze-all", { method: "POST" });
export const deleteMonitor = (id) => apiFetch(`/monitors/${id}`, { method: "DELETE" });
export const getMonitorChecks = (id, limit = 200) => apiFetch(`/monitors/${id}/checks?limit=${limit}`);
export const getMonitorIncidents = (id) => apiFetch(`/monitors/${id}/incidents`);
export const getMonitorUptime = (id) => apiFetch(`/monitors/${id}/uptime`);
export const getMonitorDailyUptime = (id, days = 90) => apiFetch(`/monitors/${id}/daily-uptime?days=${days}`);
export const getMonitorSecurity = (id) => apiFetch(`/monitors/${id}/security`);
// A full scan is up to ~32 requests against the target, several of them
// against endpoints that legitimately hang, so it needs a much longer
// client timeout than a normal read.
export const runSecurityScan = (id) => apiFetch(`/monitors/${id}/security/run`, { method: "POST", timeoutMs: 60000 });
export const getSecurityHistory = (id, limit = 60) => apiFetch(`/monitors/${id}/security/history?limit=${limit}`);
export const getSecurityEvents = (id, limit = 50) => apiFetch(`/monitors/${id}/security/events?limit=${limit}`);
export const acknowledgeSecurityEvent = (id, eventId) =>
  apiFetch(`/monitors/${id}/security/events/${eventId}/acknowledge`, { method: "POST" });
export const getCspViolations = (id) => apiFetch(`/monitors/${id}/csp-violations`);
export const clearCspViolations = (id) => apiFetch(`/monitors/${id}/csp-violations`, { method: "DELETE" });
export const updateAuthScanConfig = (id, payload) => apiFetch(`/monitors/${id}/auth-scan-config`, { method: "PATCH", body: JSON.stringify(payload) });
export const getAuthScan = (id) => apiFetch(`/monitors/${id}/auth-scan`);
export const runAuthScan = (id) => apiFetch(`/monitors/${id}/auth-scan`, { method: "POST" });

export const getMonitorTls = (id) => apiFetch(`/monitors/${id}/tls`);
export const getMonitorDns = (id) => apiFetch(`/monitors/${id}/dns`);
export const runDnsCheck = (id) => apiFetch(`/monitors/${id}/dns/run`, { method: "POST", timeoutMs: 30000 });
export const getMonitorCertificates = (id) => apiFetch(`/monitors/${id}/certificates`);
// crt.sh is regularly slow enough to need most of a minute.
export const runCertificateCheck = (id) => apiFetch(`/monitors/${id}/certificates/run`, { method: "POST", timeoutMs: 60000 });

export const getVapidPublicKey = () => apiFetch("/push/vapid-public-key");
export const subscribePush = (subscription) => apiFetch("/push/subscribe", { method: "POST", body: JSON.stringify(subscription) });
export const unsubscribePush = (endpoint) => apiFetch("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });

export const getTelegramStatus = () => apiFetch("/telegram/status");

export const listApiTokens = () => apiFetch("/tokens");
export const createApiToken = (name) => apiFetch("/tokens", { method: "POST", body: JSON.stringify({ name }) });
export const deleteApiToken = (id) => apiFetch(`/tokens/${id}`, { method: "DELETE" });

export const enableMonitorShare = (id) => apiFetch(`/monitors/${id}/share`, { method: "POST" });
export const regenerateMonitorShare = (id) => apiFetch(`/monitors/${id}/share/regenerate`, { method: "POST" });
export const revokeMonitorShare = (id) => apiFetch(`/monitors/${id}/share`, { method: "DELETE" });

export const listStatusPages = () => apiFetch("/status-pages");
export const createStatusPage = (payload) => apiFetch("/status-pages", { method: "POST", body: JSON.stringify(payload) });
export const updateStatusPage = (id, payload) => apiFetch(`/status-pages/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const regenerateStatusPage = (id) => apiFetch(`/status-pages/${id}/regenerate`, { method: "POST" });
export const deleteStatusPage = (id) => apiFetch(`/status-pages/${id}`, { method: "DELETE" });
export const getSharedStatusPage = (token) => apiFetch(`/public/status-pages/${token}`);
export const getStatusPageByDomain = (hostname) => apiFetch(`/public/status-pages/by-domain/${hostname}`);
export const verifyStatusPageDomain = (id) => apiFetch(`/status-pages/${id}/verify-domain`, { method: "POST" });

// Unauthenticated reads behind a monitor's share link - same apiFetch
// wrapper (sending a session cookie here is harmless, just unnecessary),
// just under the /public prefix the backend leaves outside requireAuth.
export const getSharedMonitor = (token) => apiFetch(`/public/monitors/${token}`);
export const getSharedMonitorChecks = (token, limit = 200) => apiFetch(`/public/monitors/${token}/checks?limit=${limit}`);
export const getSharedMonitorUptime = (token) => apiFetch(`/public/monitors/${token}/uptime`);
export const getSharedMonitorDailyUptime = (token, days = 90) => apiFetch(`/public/monitors/${token}/daily-uptime?days=${days}`);
export const getSharedMonitorSecurity = (token) => apiFetch(`/public/monitors/${token}/security`);

export const listOrganizations = () => apiFetch("/organizations");
export const createOrganization = (name) => apiFetch("/organizations", { method: "POST", body: JSON.stringify({ name }) });
export const getOrganization = (id) => apiFetch(`/organizations/${id}`);
export const updateOrganization = (id, payload) => apiFetch(`/organizations/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const deleteOrganization = (id) => apiFetch(`/organizations/${id}`, { method: "DELETE" });
export const inviteOrgMember = (id, email, role) => apiFetch(`/organizations/${id}/invite`, { method: "POST", body: JSON.stringify({ email, role }) });
export const updateOrgMemberRole = (id, memberId, role) => apiFetch(`/organizations/${id}/members/${memberId}`, { method: "PATCH", body: JSON.stringify({ role }) });
export const removeOrgMember = (id, memberId) => apiFetch(`/organizations/${id}/members/${memberId}`, { method: "DELETE" });
