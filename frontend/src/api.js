const BASE = import.meta.env.VITE_API_URL || "/api";

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
export const login = (payload) => apiFetch("/auth/login", { method: "POST", body: JSON.stringify(payload) });
export const logout = () => apiFetch("/auth/logout", { method: "POST" });
export const getMe = () => apiFetch("/auth/me");
export const updateMe = (payload) => apiFetch("/auth/me", { method: "PATCH", body: JSON.stringify(payload) });

export const listMonitors = () => apiFetch("/monitors");
export const checkNow = () => apiFetch("/monitors/check-now", { method: "POST", timeoutMs: 40000 });
export const createMonitor = (payload) => apiFetch("/monitors", { method: "POST", body: JSON.stringify(payload) });
export const updateMonitor = (id, payload) => apiFetch(`/monitors/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const snoozeMonitor = (id, minutes) => apiFetch(`/monitors/${id}/snooze`, { method: "POST", body: JSON.stringify({ minutes }) });
export const unsnoozeMonitor = (id) => apiFetch(`/monitors/${id}/unsnooze`, { method: "POST" });
export const deleteMonitor = (id) => apiFetch(`/monitors/${id}`, { method: "DELETE" });
export const getMonitorChecks = (id, limit = 200) => apiFetch(`/monitors/${id}/checks?limit=${limit}`);
export const getMonitorIncidents = (id) => apiFetch(`/monitors/${id}/incidents`);
export const getMonitorUptime = (id) => apiFetch(`/monitors/${id}/uptime`);
export const getMonitorDailyUptime = (id, days = 90) => apiFetch(`/monitors/${id}/daily-uptime?days=${days}`);
export const getMonitorSecurity = (id) => apiFetch(`/monitors/${id}/security`);
export const runSecurityScan = (id) => apiFetch(`/monitors/${id}/security/run`, { method: "POST", timeoutMs: 20000 });

export const getVapidPublicKey = () => apiFetch("/push/vapid-public-key");
export const subscribePush = (subscription) => apiFetch("/push/subscribe", { method: "POST", body: JSON.stringify(subscription) });
export const unsubscribePush = (endpoint) => apiFetch("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) });
export const testPush = () => apiFetch("/push/test", { method: "POST" });
