// Single source of truth for the notification_prefs shape (see the
// column comment in db.js). Every caller that decides whether to fire a
// push or Telegram send goes through wantsNotification() rather than
// reading user.notification_prefs directly, so a missing key (old
// account created before a given event kind existed, or a client that
// only ever sent one channel) always falls back to "on" instead of
// silently reading as opted out.

export const DEFAULT_NOTIFICATION_PREFS = {
  push: { down: true, degraded: true, contentChanged: true, expiring: true, security: true, digest: true },
  telegram: { down: true, degraded: true, contentChanged: true, expiring: true, security: true, digest: true },
};

const EVENT_KEYS = Object.keys(DEFAULT_NOTIFICATION_PREFS.push);
const CHANNELS = ["push", "telegram"];

export function wantsNotification(user, channel, eventKey) {
  const value = user?.notification_prefs?.[channel]?.[eventKey];
  return typeof value === "boolean" ? value : DEFAULT_NOTIFICATION_PREFS[channel]?.[eventKey] ?? true;
}

// Merges whatever the client sent onto the full default shape, so a
// PATCH that only tweaks one checkbox can't accidentally wipe the rest
// of the columns to "undefined" (which JSONB would store as literally
// missing, and the very code this feeds is designed to treat that as
// "on" - two defaults disagreeing would be worse than either alone).
export function normalizeNotificationPrefs(input) {
  const out = { push: { ...DEFAULT_NOTIFICATION_PREFS.push }, telegram: { ...DEFAULT_NOTIFICATION_PREFS.telegram } };
  for (const channel of CHANNELS) {
    const incoming = input?.[channel];
    if (incoming && typeof incoming === "object") {
      for (const key of EVENT_KEYS) {
        if (typeof incoming[key] === "boolean") out[channel][key] = incoming[key];
      }
    }
  }
  return out;
}
