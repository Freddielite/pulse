import { useEffect, useState } from "react";
import { updateMe, testPush, testTelegram, getTelegramStatus, logout } from "../api.js";
import { usePush } from "../hooks/usePush.js";

export default function SettingsView({ user, onUserUpdated, onLoggedOut, toast }) {
  const push = usePush();
  const [alertEmail, setAlertEmail] = useState(user.alert_email || "");
  const [savingEmail, setSavingEmail] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState(null); // { configured, ready, source }

  useEffect(() => {
    getTelegramStatus()
      .then(setTelegramStatus)
      .catch(() => setTelegramStatus({ configured: false, ready: false, source: null }));
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
