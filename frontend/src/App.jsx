import { useEffect, useState } from "react";
import { getMe, listMonitors, listStatusPages } from "./api.js";
import { useToast } from "./hooks/useToast.js";
import { useIsMobile } from "./hooks/useIsMobile.js";
import AuthRoot from "./AuthRoot.jsx";
import PulseLine from "./components/PulseLine.jsx";
import Dashboard from "./components/Dashboard.jsx";
import MonitorDetail from "./components/MonitorDetail.jsx";
import MonitorForm from "./components/MonitorForm.jsx";
import SettingsView from "./components/SettingsView.jsx";
import StatusPagesView from "./components/StatusPagesView.jsx";
import InstallPrompt from "./components/InstallPrompt.jsx";

// Bottom tab bar icons, hand-drawn rather than pulling in an icon
// library for three glyphs. Monitors reuses the app's own pulse-line
// motif instead of a generic grid/list icon, so the tab bar echoes
// the brand mark rather than looking like a stock template.
const ICONS = {
  monitors: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l2-7 4 14 3-10 2 3h3" />
    </svg>
  ),
  statusPages: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="7" y1="14" x2="17" y2="14" />
      <line x1="7" y1="17" x2="13" y2="17" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="15" cy="6" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="9" cy="12" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="17" cy="18" r="2" fill="currentColor" stroke="none" />
    </svg>
  ),
};

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = logged out
  const [monitors, setMonitors] = useState([]);
  const [monitorsLoading, setMonitorsLoading] = useState(true);
  const [statusPages, setStatusPages] = useState([]);
  const [statusPagesLoading, setStatusPagesLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [adding, setAdding] = useState(false);
  // Tracks *why* the view just changed, so the page transition below
  // can play a direction that actually matches what happened: pushing
  // into a monitor's detail, popping back out of it, or switching a
  // top-level tab (which isn't really a "direction" at all).
  const [navAction, setNavAction] = useState("tab");
  const { toasts, push: toast } = useToast();
  const isMobile = useIsMobile();

  useEffect(() => {
    getMe().then(setUser).catch(() => setUser(null));
  }, []);

  async function loadMonitors() {
    try {
      setMonitors(await listMonitors());
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setMonitorsLoading(false);
    }
  }

  // Held here (not inside StatusPagesView) specifically so switching
  // to that tab doesn't refetch and re-show a loading state every
  // single time - same reasoning as monitors living up here. Fetched
  // once on login; StatusPagesView asks for a refresh explicitly via
  // onReload after it actually changes something.
  async function loadStatusPages() {
    try {
      setStatusPages(await listStatusPages());
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setStatusPagesLoading(false);
    }
  }

  useEffect(() => {
    if (user) {
      loadMonitors();
      loadStatusPages();
      // Poll for status changes so the dashboard reflects new checks
      // without a manual refresh - the tick interval on the backend is
      // typically a few minutes, so this doesn't need to be aggressive.
      const id = window.setInterval(loadMonitors, 30000);
      return () => window.clearInterval(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // App icon badge: mirrors the "down now" count from the dashboard
  // onto the home-screen icon itself, so a problem is visible without
  // even opening the app. Feature-detected because the Badging API
  // isn't universal (notably: not on desktop Firefox), and wrapped in
  // try/catch since some browsers throw rather than reject.
  useEffect(() => {
    if (!("setAppBadge" in navigator)) return;
    const downCount = monitors.filter((m) => m.current_status === "down").length;
    try {
      if (downCount > 0) navigator.setAppBadge(downCount);
      else navigator.clearAppBadge();
    } catch {
      // Badging just won't reflect this update - not worth surfacing.
    }
  }, [monitors]);

  if (user === undefined) return null;
  if (!user) return <AuthRoot onAuthed={setUser} />;

  const selected = monitors.find((m) => m.id === selectedId);
  const existingGroups = [...new Set(monitors.map((m) => m.group_name).filter(Boolean))].sort();

  function goToTab(t) {
    setNavAction("tab");
    setTab(t);
    setSelectedId(null);
  }

  function openMonitor(m) {
    setNavAction("push");
    setSelectedId(m.id);
  }

  function closeMonitor() {
    setNavAction("pop");
    setSelectedId(null);
  }

  const pageKey = `${tab}:${selected ? "detail" : "list"}`;

  return (
    <div className={`pl-shell${isMobile ? " pl-shell--with-tabbar" : ""}`}>
      <div className="pl-header">
        <div className="pl-brand">
          <svg className="pl-brand__mark" viewBox="0 0 100 100">
            <rect width="100" height="100" rx="20" fill="#0a0f0d" />
            <path d="M8 50 H32 L40 28 L54 72 L64 50 H92" fill="none" stroke="#3ddc84" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Pulse
        </div>
        <div className="pl-nav">
          <button className={tab === "dashboard" ? "active" : ""} onClick={() => goToTab("dashboard")}>Monitors</button>
          <button className={tab === "status-pages" ? "active" : ""} onClick={() => goToTab("status-pages")}>Status pages</button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => goToTab("settings")}>Settings</button>
        </div>
      </div>
      <PulseLine />
      <InstallPrompt />

      <div key={pageKey} className={`pl-page pl-page--${navAction}`}>
        {tab === "dashboard" && !selected && (
          <Dashboard monitors={monitors} loading={monitorsLoading} onSelect={openMonitor} onAdd={() => setAdding(true)} onChanged={loadMonitors} toast={toast} />
        )}

        {tab === "dashboard" && selected && (
          <MonitorDetail monitor={selected} existingGroups={existingGroups} onBack={closeMonitor} onChanged={loadMonitors} toast={toast} />
        )}

        {tab === "status-pages" && (
          <StatusPagesView
            monitors={monitors}
            existingGroups={existingGroups}
            pages={statusPages}
            loading={statusPagesLoading}
            onReload={loadStatusPages}
            toast={toast}
          />
        )}

        {tab === "settings" && (
          <SettingsView
            user={user}
            onUserUpdated={setUser}
            onLoggedOut={() => {
              if ("clearAppBadge" in navigator) {
                navigator.clearAppBadge().catch(() => {});
              }
              setUser(null);
            }}
            toast={toast}
          />
        )}
      </div>

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

      {isMobile && (
        <nav className="pl-tabbar">
          <button className={tab === "dashboard" ? "active" : ""} onClick={() => goToTab("dashboard")}>
            {ICONS.monitors}
            Monitors
          </button>
          <button className={tab === "status-pages" ? "active" : ""} onClick={() => goToTab("status-pages")}>
            {ICONS.statusPages}
            Status
          </button>
          <button className={tab === "settings" ? "active" : ""} onClick={() => goToTab("settings")}>
            {ICONS.settings}
            Settings
          </button>
        </nav>
      )}

      <div className="pl-toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`pl-toast ${t.type === "error" ? "pl-toast--error" : ""}`}>{t.message}</div>
        ))}
      </div>
    </div>
  );
}
