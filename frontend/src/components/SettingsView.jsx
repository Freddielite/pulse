import { useEffect, useState } from "react";
import { updateMe, testPush, testTelegram, getTelegramStatus, listApiTokens, createApiToken, deleteApiToken, logout } from "../api.js";
import { usePush } from "../hooks/usePush.js";

export default function SettingsView({ user, onUserUpdated, onLoggedOut, toast }) {
  const push = usePush();
  const [alertEmail, setAlertEmail] = useState(user.alert_email || "");
  const [savingEmail, setSavingEmail] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState(null); // { configured, ready, source }
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

  async function handleTestPush() {
    try {
      const result = await testPush();
      if (result.failed > 0) {
        toast(`Delivered to ${result.sent} of ${result.sent + result.failed} device(s) - one or more subscriptions may be stale.`, "error");
      } else {
        toast(result.sent > 1 ? `Test notification sent to ${result.sent} devices.` : "Test notification sent.");
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

  async function handleTestTelegram() {
    try {
      await testTelegram();
      toast("Test message sent.");
    } catch (err) {
      toast(err.message, "error");
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
            <button className={`pl-toggle ${push.subscribed ? "on" : ""}`} onClick={handlePushToggle} disabled={push.busy}>
              <span className="pl-toggle__knob" />
            </button>
          )}
        </div>
        {push.subscribed && (
          <div className="pl-settings-row">
            <div className="pl-settings-row__desc">Send a test notification</div>
            <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleTestPush}>Send test</button>
          </div>
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
                    ? "Alerts will be sent to the chat ID configured on the server."
                    : "Set TELEGRAM_CHAT_ID in the backend's environment variables to turn this on."}
                </div>
              </div>
              {telegramStatus.ready && (
                <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleTestTelegram}>Send test</button>
              )}
            </div>
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
