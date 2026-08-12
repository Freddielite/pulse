import { useEffect, useState } from "react";
import { getMe, listMonitors } from "./api.js";
import { useToast } from "./hooks/useToast.js";
import AuthRoot from "./AuthRoot.jsx";
import PulseLine from "./components/PulseLine.jsx";
import Dashboard from "./components/Dashboard.jsx";
import MonitorDetail from "./components/MonitorDetail.jsx";
import MonitorForm from "./components/MonitorForm.jsx";
import SettingsView from "./components/SettingsView.jsx";
import StatusPagesView from "./components/StatusPagesView.jsx";

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = logged out
  const [monitors, setMonitors] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [adding, setAdding] = useState(false);
  const { toasts, push: toast } = useToast();

  useEffect(() => {
    getMe().then(setUser).catch(() => setUser(null));
  }, []);

  async function loadMonitors() {
    try {
      setMonitors(await listMonitors());
    } catch (err) {
      toast(err.message, "error");
    }
  }

  useEffect(() => {
    if (user) {
      loadMonitors();
      // Poll for status changes so the dashboard reflects new checks
      // without a manual refresh - the tick interval on the backend is
      // typically a few minutes, so this doesn't need to be aggressive.
      const id = window.setInterval(loadMonitors, 30000);
      return () => window.clearInterval(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (user === undefined) return null;
  if (!user) return <AuthRoot onAuthed={setUser} />;

  const selected = monitors.find((m) => m.id === selectedId);
  const existingGroups = [...new Set(monitors.map((m) => m.group_name).filter(Boolean))].sort();

  return (
    <div className="pl-shell">
      <div className="pl-header">
        <div className="pl-brand">
          <svg className="pl-brand__mark" viewBox="0 0 100 100">
            <rect width="100" height="100" rx="20" fill="#0a0f0d" />
            <path d="M8 50 H32 L40 28 L54 72 L64 50 H92" fill="none" stroke="#3ddc84" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Pulse
        </div>
        <div className="pl-nav">
          <button className={tab === "dashboard" ? "active" : ""} onClick={() => { setTab("dashboard"); setSelectedId(null); }}>Monitors</button>
          <button className={tab === "status-pages" ? "active" : ""} onClick={() => { setTab("status-pages"); setSelectedId(null); }}>Status pages</button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => { setTab("settings"); setSelectedId(null); }}>Settings</button>
        </div>
      </div>
      <PulseLine />

      {tab === "dashboard" && !selected && (
        <Dashboard monitors={monitors} onSelect={(m) => setSelectedId(m.id)} onAdd={() => setAdding(true)} onChanged={loadMonitors} toast={toast} />
      )}

      {tab === "dashboard" && selected && (
        <MonitorDetail monitor={selected} existingGroups={existingGroups} onBack={() => setSelectedId(null)} onChanged={loadMonitors} toast={toast} />
      )}

      {tab === "status-pages" && (
        <StatusPagesView monitors={monitors} existingGroups={existingGroups} toast={toast} />
      )}

      {tab === "settings" && (
        <SettingsView user={user} onUserUpdated={setUser} onLoggedOut={() => setUser(null)} toast={toast} />
      )}

      {adding && (
        <MonitorForm
          existingGroups={existingGroups}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            loadMonitors();
          }}
          toast={toast}
        />
      )}

      <div className="pl-toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`pl-toast ${t.type === "error" ? "pl-toast--error" : ""}`}>{t.message}</div>
        ))}
      </div>
    </div>
  );
}
