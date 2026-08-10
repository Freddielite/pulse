import { useEffect, useState } from "react";
import { updateMe, testPush, testTelegram, getTelegramStatus, logout } from "../api.js";
import { usePush } from "../hooks/usePush.js";

export default function SettingsView({ user, onUserUpdated, onLoggedOut, toast }) {
  const push = usePush();
  const [alertEmail, setAlertEmail] = useState(user.alert_email || "");
  const [savingEmail, setSavingEmail] = useState(false);
  const [telegramChatId, setTelegramChatId] = useState(user.telegram_chat_id || "");
  const [savingTelegram, setSavingTelegram] = useState(false);
  const [telegramConfigured, setTelegramConfigured] = useState(false);

  useEffect(() => {
    getTelegramStatus()
      .then((s) => setTelegramConfigured(s.configured))
      .catch(() => setTelegramConfigured(false));
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
      await testPush();
      toast("Test notification sent.");
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

  async function handleSaveTelegram(e) {
    e.preventDefault();
    setSavingTelegram(true);
    try {
      const updated = await updateMe({ telegram_chat_id: telegramChatId });
      onUserUpdated(updated);
      toast(telegramChatId.trim() ? "Telegram chat ID saved." : "Telegram alerts turned off.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSavingTelegram(false);
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

      {telegramConfigured && (
        <>
          <div className="pl-section-label">Telegram alerts</div>
          <div className="pl-panel">
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 10 }}>
              Message this Pulse instance's bot (ask whoever runs it for the bot's @username, or check the
              deploy's <code>TELEGRAM_BOT_TOKEN</code>), send it anything, then open{" "}
              <code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</code> in a browser to find your chat ID
              in the response. Paste it below.
            </div>
            <form onSubmit={handleSaveTelegram} style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
              <div className="pl-field" style={{ flex: 1, marginBottom: 0 }}>
                <label>Telegram chat ID</label>
                <input
                  value={telegramChatId}
                  onChange={(e) => setTelegramChatId(e.target.value)}
                  placeholder="e.g. 123456789"
                />
              </div>
              <button className="pl-btn pl-btn--sm" type="submit" disabled={savingTelegram}>
                {savingTelegram ? "Saving..." : "Save"}
              </button>
            </form>
            {user.telegram_chat_id && (
              <div className="pl-settings-row">
                <div className="pl-settings-row__desc">Send a test message</div>
                <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleTestTelegram}>Send test</button>
              </div>
            )}
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
