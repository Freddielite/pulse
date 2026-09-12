import { useEffect, useState } from "react";
import {
  updateMe,
  changePassword,
  getTelegramStatus,
  listApiTokens,
  createApiToken,
  deleteApiToken,
  logout,
  testWebhook,
  setup2fa,
  confirm2fa,
  disable2fa,
} from "../api.js";
import { usePush } from "../hooks/usePush.js";

// Shared shape between the push and Telegram checkbox lists below - keep
// in sync with DEFAULT_NOTIFICATION_PREFS in the backend's
// lib/notificationPrefs.js.
const EVENT_TYPES = [
  { key: "down", label: "Downtime & recovery", desc: "A monitor goes down, stays down, or comes back up." },
  { key: "degraded", label: "Slow responses", desc: "Response time crosses the slow threshold, and when it clears." },
  { key: "contentChanged", label: "Content changes", desc: "A monitored page's content changes since the last check." },
  { key: "expiring", label: "Certificate & domain expiry", desc: "An SSL cert or domain registration is expiring soon." },
  { key: "security", label: "Security findings", desc: "A medium-or-higher severity security scan finding." },
];

function NotificationEventList({ prefs, onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--panel-border)" }}>
      {EVENT_TYPES.map(({ key, label, desc }) => (
        <label className="pl-checkbox-row" key={key} style={{ alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={prefs?.[key] !== false}
            onChange={(e) => onChange(key, e.target.checked)}
          />
          <span>
            <span style={{ color: "var(--ink)" }}>{label}</span>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--ink-faint)" }}>{desc}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

export default function SettingsView({ user, onUserUpdated, onLoggedOut, toast }) {
  const push = usePush();
  const [alertEmail, setAlertEmail] = useState(user.alert_email || "");
  const [savingEmail, setSavingEmail] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState(null); // { configured, ready, source }
  const [telegramChatId, setTelegramChatId] = useState(user.telegram_chat_id || "");
  const [savingTelegramChatId, setSavingTelegramChatId] = useState(false);
  const [digestBusy, setDigestBusy] = useState(false);
  const [breachBusy, setBreachBusy] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState(user.webhook_url || "");
  const [savingWebhookUrl, setSavingWebhookUrl] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);
  // 2FA setup is a short-lived wizard, not persisted state - null means
  // "not currently setting up" (whether 2FA is off, or already on and
  // nothing's in progress).
  const [totpSetup, setTotpSetup] = useState(null); // { secret, otpauth_url } | null
  const [totpConfirmCode, setTotpConfirmCode] = useState("");
  const [totpBackupCodes, setTotpBackupCodes] = useState(null); // shown once, right after confirming
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpDisablePassword, setTotpDisablePassword] = useState("");
  const [showTotpDisable, setShowTotpDisable] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [tokens, setTokens] = useState([]);
  const [newTokenName, setNewTokenName] = useState("");
  const [creatingToken, setCreatingToken] = useState(false);
  // Set once, right after creation, to the { token, ...row } response -
  // the raw value only ever exists in memory for this one render; it's
  // never stored anywhere it could be read back later.
  const [justCreatedToken, setJustCreatedToken] = useState(null);

  useEffect(() => {
    getTelegramStatus()
      .then(setTelegramStatus)
      .catch(() => setTelegramStatus({ configured: false, ready: false, source: null }));
    listApiTokens()
      .then(setTokens)
      .catch(() => {});
  }, []);

  async function handlePushToggle() {
    try {
      if (push.subscribed) {
        await push.unsubscribe();
        toast("Push notifications turned off.");
      } else {
        await push.subscribe();
        toast("Push notifications turned on.");
      }
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function handleSaveEmail(e) {
    e.preventDefault();
    setSavingEmail(true);
    try {
      const updated = await updateMe({ alert_email: alertEmail });
      onUserUpdated(updated);
      toast("Alert email saved.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSavingEmail(false);
    }
  }

  async function handleNotificationPrefChange(channel, key, value) {
    // Optimistic - flip it locally right away, then reconcile with
    // whatever the server actually saved (same shape as every other
    // toggle in this view).
    const prevPrefs = user.notification_prefs;
    const optimistic = {
      ...prevPrefs,
      [channel]: { ...prevPrefs?.[channel], [key]: value },
    };
    onUserUpdated({ ...user, notification_prefs: optimistic });
    try {
      const updated = await updateMe({ notification_prefs: { [channel]: { [key]: value } } });
      onUserUpdated(updated);
    } catch (err) {
      onUserUpdated({ ...user, notification_prefs: prevPrefs });
      toast(err.message, "error");
    }
  }

  async function handleDigestToggle() {
    setDigestBusy(true);
    try {
      const updated = await updateMe({ digest_enabled: !user.digest_enabled });
      onUserUpdated(updated);
      toast(updated.digest_enabled ? "Weekly digest turned on." : "Weekly digest turned off.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setDigestBusy(false);
    }
  }

  async function handleBreachToggle() {
    setBreachBusy(true);
    try {
      const updated = await updateMe({ breach_monitoring_enabled: !user.breach_monitoring_enabled });
      onUserUpdated(updated);
      toast(updated.breach_monitoring_enabled ? "Breach monitoring turned on." : "Breach monitoring turned off.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBreachBusy(false);
    }
  }

  async function handleSaveWebhookUrl(e) {
    e.preventDefault();
    setSavingWebhookUrl(true);
    try {
      const updated = await updateMe({ webhook_url: webhookUrl.trim() });
      onUserUpdated(updated);
      toast(webhookUrl.trim() ? "Webhook URL saved." : "Webhook disconnected.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSavingWebhookUrl(false);
    }
  }

  async function handleTestWebhook() {
    setTestingWebhook(true);
    try {
      await testWebhook();
      toast("Test webhook sent.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setTestingWebhook(false);
    }
  }

  async function handleStart2faSetup() {
    setTotpBusy(true);
    try {
      const result = await setup2fa();
      setTotpSetup(result);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleConfirm2fa(e) {
    e.preventDefault();
    setTotpBusy(true);
    try {
      const result = await confirm2fa(totpConfirmCode.trim());
      setTotpBackupCodes(result.backup_codes);
      setTotpSetup(null);
      setTotpConfirmCode("");
      onUserUpdated({ ...user, totp_enabled: true });
      toast("Two-factor authentication turned on.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleDisable2fa(e) {
    e.preventDefault();
    setTotpBusy(true);
    try {
      await disable2fa(totpDisablePassword);
      onUserUpdated({ ...user, totp_enabled: false });
      setShowTotpDisable(false);
      setTotpDisablePassword("");
      toast("Two-factor authentication turned off.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setTotpBusy(false);
    }
  }

  async function handleCancelTotpSetup() {
    setTotpSetup(null);
    setTotpConfirmCode("");
  }

  async function handleSaveTelegramChatId(e) {
    e.preventDefault();
    setSavingTelegramChatId(true);
    try {
      const updated = await updateMe({ telegram_chat_id: telegramChatId.trim() });
      onUserUpdated(updated);
      const status = await getTelegramStatus().catch(() => null);
      if (status) setTelegramStatus(status);
      toast("Telegram chat ID saved.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSavingTelegramChatId(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setChangingPassword(true);
    try {
      await changePassword({ current_password: currentPassword, new_password: newPassword });
      setCurrentPassword("");
      setNewPassword("");
      toast("Password changed.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setChangingPassword(false);
    }
  }

  async function handleLogout() {
    await logout();
    onLoggedOut();
  }

  async function handleCreateToken(e) {
    e.preventDefault();
    if (!newTokenName.trim()) return;
    setCreatingToken(true);
    try {
      const created = await createApiToken(newTokenName.trim());
      setJustCreatedToken(created);
      setTokens((prev) => [created, ...prev]);
      setNewTokenName("");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setCreatingToken(false);
    }
  }

  async function handleDeleteToken(id) {
    try {
      await deleteApiToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
      if (justCreatedToken?.id === id) setJustCreatedToken(null);
      toast("Token revoked.");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function handleCopyToken() {
    try {
      await navigator.clipboard.writeText(justCreatedToken.token);
      toast("Copied to clipboard.");
    } catch {
      toast("Couldn't copy automatically - select and copy it manually.", "error");
    }
  }

  return (
    <div>
      <div className="pl-panel">
        <div className="pl-settings-row">
          <div>
            <div className="pl-settings-row__title">Push notifications</div>
            <div className="pl-settings-row__desc">
              {push.supported ? "Get notified the moment something goes down." : "Not supported in this browser."}
            </div>
          </div>
          {push.supported && (
            <button className={`pl-toggle ${push.subscribed ? "on" : ""} ${push.busy ? "busy" : ""}`} onClick={handlePushToggle} disabled={push.busy}>
              <span className="pl-toggle__knob" />
            </button>
          )}
        </div>
        {push.subscribed && (
          <NotificationEventList
            prefs={user.notification_prefs?.push}
            onChange={(key, value) => handleNotificationPrefChange("push", key, value)}
          />
        )}
      </div>

      <div className="pl-section-label">Email alerts</div>
      <div className="pl-panel">
        <form onSubmit={handleSaveEmail} style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div className="pl-field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Send downtime alerts to</label>
            <input type="email" value={alertEmail} onChange={(e) => setAlertEmail(e.target.value)} required />
          </div>
          <button className="pl-btn pl-btn--sm" type="submit" disabled={savingEmail}>{savingEmail ? "Saving..." : "Save"}</button>
        </form>
      </div>

      <div className="pl-section-label">Weekly digest</div>
      <div className="pl-panel">
        <div className="pl-settings-row">
          <div>
            <div className="pl-settings-row__title">Weekly summary</div>
            <div className="pl-settings-row__desc">
              Once a week: uptime %, incident count, and any cert/domain expiring within 14 days, across every
              active monitor - sent over whichever alert channels you already have configured (push, email,
              Telegram). Doesn't replace real-time down alerts, just a heads-up if all you've heard from Pulse
              lately is silence.
              {user.digest_enabled && (
                <>
                  {" "}
                  {user.digest_sent_at ? `Last sent ${new Date(user.digest_sent_at).toLocaleDateString()}.` : "Not sent yet - due on the next cron tick."}
                </>
              )}
            </div>
          </div>
          <button className={`pl-toggle ${user.digest_enabled ? "on" : ""} ${digestBusy ? "busy" : ""}`} onClick={handleDigestToggle} disabled={digestBusy}>
            <span className="pl-toggle__knob" />
          </button>
        </div>
      </div>

      <div className="pl-section-label">Breach monitoring</div>
      <div className="pl-panel">
        <div className="pl-settings-row">
          <div>
            <div className="pl-settings-row__title">Data breach alerts</div>
            <div className="pl-settings-row__desc">
              Weekly check of your alert email against HaveIBeenPwned - if it turns up in a new breach, you'll hear
              about it over whichever alert channels you already have on.
              {user.breach_monitoring_enabled && (
                <>
                  {" "}
                  {user.breach_checked_at
                    ? `Last checked ${new Date(user.breach_checked_at).toLocaleDateString()}.`
                    : "Not checked yet - due on the next cron tick."}
                  {user.breach_last_result?.breaches?.length > 0 && (
                    <> Currently known in: {user.breach_last_result.breaches.join(", ")}.</>
                  )}
                </>
              )}
            </div>
          </div>
          <button
            className={`pl-toggle ${user.breach_monitoring_enabled ? "on" : ""} ${breachBusy ? "busy" : ""}`}
            onClick={handleBreachToggle}
            disabled={breachBusy}
          >
            <span className="pl-toggle__knob" />
          </button>
        </div>
      </div>

      <div className="pl-section-label">Webhook alerts</div>
      <div className="pl-panel">
        <div className="pl-settings-row__desc" style={{ marginBottom: 10 }}>
          Send alerts as a JSON POST to Slack, Discord, PagerDuty, or any other URL that accepts one.
        </div>
        <form onSubmit={handleSaveWebhookUrl} style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div className="pl-field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Webhook URL</label>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/..."
            />
          </div>
          <button className="pl-btn pl-btn--sm" type="submit" disabled={savingWebhookUrl}>
            {savingWebhookUrl ? "Saving..." : "Save"}
          </button>
          {user.webhook_url && (
            <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleTestWebhook} disabled={testingWebhook}>
              {testingWebhook ? "Sending..." : "Send test"}
            </button>
          )}
        </form>

        {user.webhook_url && (
          <NotificationEventList
            prefs={user.notification_prefs?.webhook}
            onChange={(key, value) => handleNotificationPrefChange("webhook", key, value)}
          />
        )}
      </div>

      {telegramStatus?.configured && (
        <>
          <div className="pl-section-label">Telegram alerts</div>
          <div className="pl-panel">
            <div className="pl-settings-row">
              <div>
                <div className="pl-settings-row__title">
                  {telegramStatus.ready ? "Connected" : "Not connected"}
                </div>
                <div className="pl-settings-row__desc">
                  {telegramStatus.ready
                    ? telegramStatus.source === "env"
                      ? "Alerts go to the chat ID set server-wide for this deployment."
                      : "Alerts go to the chat ID you've saved below."
                    : "Message your bot on Telegram, then paste your chat ID below - @userinfobot will tell you your ID if you're not sure how to find it."}
                </div>
              </div>
            </div>

            <form onSubmit={handleSaveTelegramChatId} style={{ display: "flex", gap: 10, alignItems: "flex-end", marginTop: 12 }}>
              <div className="pl-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Your chat ID</label>
                <input value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} placeholder="e.g. 123456789" />
              </div>
              <button className="pl-btn pl-btn--sm" type="submit" disabled={savingTelegramChatId}>
                {savingTelegramChatId ? "Saving..." : "Save"}
              </button>
            </form>
            {telegramStatus.source === "env" && (
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 8 }}>
                A server-wide chat ID takes priority over this one - saving one here only takes effect if that's ever removed.
              </div>
            )}

            {telegramStatus.ready && (
              <NotificationEventList
                prefs={user.notification_prefs?.telegram}
                onChange={(key, value) => handleNotificationPrefChange("telegram", key, value)}
              />
            )}
          </div>
        </>
      )}

      <div className="pl-section-label">API tokens</div>
      <div className="pl-panel">
        <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 10 }}>
          Bearer tokens for scripting against Pulse directly (cron jobs, other tools) instead of through the browser.
          Send one as <code>Authorization: Bearer &lt;token&gt;</code>.
        </div>

        {justCreatedToken && (
          <div style={{ background: "var(--bg)", border: "1px solid var(--signal)", borderRadius: 8, padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 12.5, marginBottom: 6 }}>
              Copy this now - it won't be shown again:
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <code style={{ fontSize: 12.5, wordBreak: "break-all", flex: 1 }}>{justCreatedToken.token}</code>
              <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleCopyToken}>Copy</button>
            </div>
          </div>
        )}

        <form onSubmit={handleCreateToken} style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: tokens.length ? 14 : 0 }}>
          <div className="pl-field" style={{ flex: 1, marginBottom: 0 }}>
            <label>New token name</label>
            <input value={newTokenName} onChange={(e) => setNewTokenName(e.target.value)} placeholder="e.g. cron script, laptop" />
          </div>
          <button className="pl-btn pl-btn--sm" type="submit" disabled={creatingToken || !newTokenName.trim()}>
            {creatingToken ? "Creating..." : "Create"}
          </button>
        </form>

        {tokens.map((t) => (
          <div className="pl-settings-row" key={t.id}>
            <div>
              <div className="pl-settings-row__title">{t.name}</div>
              <div className="pl-settings-row__desc">
                {t.token_prefix}… · {t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleDateString()}` : "never used"}
              </div>
            </div>
            <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => handleDeleteToken(t.id)}>Revoke</button>
          </div>
        ))}
      </div>

      <div className="pl-section-label">Two-factor authentication</div>
      <div className="pl-panel">
        {totpBackupCodes ? (
          <div>
            <div style={{ fontSize: 12.5, marginBottom: 8 }}>
              Save these backup codes somewhere safe - each works once, and this is the only time they're shown.
              Use one to log in if you ever lose access to your authenticator app.
            </div>
            <div style={{ background: "var(--bg)", border: "1px solid var(--signal)", borderRadius: 8, padding: 12, fontFamily: "monospace", fontSize: 13, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {totpBackupCodes.map((c) => <span key={c}>{c}</span>)}
            </div>
            <button className="pl-btn pl-btn--sm" style={{ marginTop: 12 }} onClick={() => setTotpBackupCodes(null)}>
              Done, I've saved them
            </button>
          </div>
        ) : totpSetup ? (
          <form onSubmit={handleConfirm2fa} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12.5 }}>
              Scan this into your authenticator app (Google Authenticator, Authy, 1Password, etc.), or enter the
              secret manually:
            </div>
            <div style={{ background: "var(--bg)", border: "1px solid var(--panel-border)", borderRadius: 8, padding: 10, fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>
              {totpSetup.secret}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
              Or open this URI directly on a device with an authenticator app installed: <br />
              <span style={{ wordBreak: "break-all" }}>{totpSetup.otpauth_url}</span>
            </div>
            <div className="pl-field" style={{ marginBottom: 0 }}>
              <label>6-digit code from the app</label>
              <input value={totpConfirmCode} onChange={(e) => setTotpConfirmCode(e.target.value)} inputMode="numeric" autoFocus required />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="pl-btn pl-btn--sm" type="submit" disabled={totpBusy}>
                {totpBusy ? "Verifying..." : "Confirm"}
              </button>
              <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleCancelTotpSetup}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="pl-settings-row">
            <div>
              <div className="pl-settings-row__title">{user.totp_enabled ? "Enabled" : "Not enabled"}</div>
              <div className="pl-settings-row__desc">
                Require a 6-digit code from an authenticator app in addition to your password when logging in.
              </div>
            </div>
            {user.totp_enabled ? (
              <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => setShowTotpDisable((v) => !v)}>
                Disable
              </button>
            ) : (
              <button className="pl-btn pl-btn--sm" onClick={handleStart2faSetup} disabled={totpBusy}>
                {totpBusy ? "Starting..." : "Enable"}
              </button>
            )}
          </div>
        )}

        {showTotpDisable && (
          <form onSubmit={handleDisable2fa} style={{ display: "flex", gap: 10, alignItems: "flex-end", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--panel-border)" }}>
            <div className="pl-field" style={{ flex: 1, marginBottom: 0 }}>
              <label>Confirm your password to disable</label>
              <input type="password" value={totpDisablePassword} onChange={(e) => setTotpDisablePassword(e.target.value)} autoComplete="current-password" required />
            </div>
            <button className="pl-btn pl-btn--sm" type="submit" disabled={totpBusy}>
              {totpBusy ? "Working..." : "Confirm disable"}
            </button>
          </form>
        )}
      </div>

      <div className="pl-section-label">Security</div>
      <div className="pl-panel">
        <form onSubmit={handleChangePassword} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="pl-field" style={{ marginBottom: 0 }}>
            <label>Current password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <div className="pl-field" style={{ marginBottom: 0 }}>
            <label>New password</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </div>
          <button className="pl-btn pl-btn--sm" type="submit" disabled={changingPassword} style={{ alignSelf: "flex-start" }}>
            {changingPassword ? "Saving..." : "Change password"}
          </button>
        </form>
      </div>

      <div className="pl-section-label">Account</div>
      <div className="pl-panel">
        <div className="pl-settings-row">
          <div>
            <div className="pl-settings-row__title">{user.email}</div>
            <div className="pl-settings-row__desc">Logged in</div>
          </div>
          <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleLogout}>Log out</button>
        </div>
      </div>
    </div>
  );
}

