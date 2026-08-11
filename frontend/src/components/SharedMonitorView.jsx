import { useEffect, useState } from "react";
import { getSharedMonitor, getSharedMonitorUptime, getSharedMonitorDailyUptime, getSharedMonitorSecurity } from "../api.js";
import MonitorHeatmap from "./MonitorHeatmap.jsx";

function formatDateTime(iso) {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function BrandMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="20" fill="#0a0f0d" />
      <path d="M8 50 H32 L40 28 L54 72 L64 50 H92" fill="none" stroke="#3ddc84" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Rendered from main.jsx in place of the whole authed App when the URL
// is a share link (#/share/<token>) - it never touches getMe() or the
// session, and only ever talks to the /public/* endpoints, which are
// themselves scoped to exactly the one monitor this token points at.
export default function SharedMonitorView({ token }) {
  const [monitor, setMonitor] = useState(undefined); // undefined = loading, null = invalid/revoked
  const [uptime, setUptime] = useState(null);
  const [dailyUptime, setDailyUptime] = useState([]);
  const [security, setSecurity] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let ignore = false;
    Promise.all([
      getSharedMonitor(token),
      getSharedMonitorUptime(token),
      getSharedMonitorDailyUptime(token),
      getSharedMonitorSecurity(token),
    ])
      .then(([m, u, d, s]) => {
        if (ignore) return;
        setMonitor(m);
        setUptime(u);
        setDailyUptime(d);
        setSecurity(s);
      })
      .catch((err) => {
        if (ignore) return;
        setError(err.message);
        setMonitor(null);
      });
    return () => {
      ignore = true;
    };
  }, [token]);

  if (monitor === undefined) return null;

  if (monitor === null) {
    return (
      <div className="pl-auth">
        <div className="pl-panel pl-auth__card">
          <div className="pl-auth__brand">
            <BrandMark />
            Pulse
          </div>
          <div className="pl-auth__tagline">{error || "This share link is invalid or has been revoked."}</div>
        </div>
      </div>
    );
  }

  const statusLabel = monitor.current_status === "up" ? "Operational" : monitor.current_status === "down" ? "Down" : "Unknown";

  return (
    <div className="pl-shell">
      <div className="pl-header">
        <div className="pl-brand">
          <BrandMark />
          Pulse
        </div>
      </div>

      <div className="pl-detail-head">
        <div>
          <div className="pl-detail-title">{monitor.name}</div>
          <div className="pl-detail-url">{monitor.url}</div>
        </div>
        <span
          className={`pl-badge ${monitor.current_status === "up" ? "pl-badge--signal" : monitor.current_status === "down" ? "" : "pl-badge--muted"}`}
          style={monitor.current_status === "down" ? { background: "var(--alert-dim)", color: "var(--alert)" } : undefined}
        >
          {statusLabel}
        </span>
      </div>

      <div style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: -8, marginBottom: 14 }}>
        Last checked {formatDateTime(monitor.last_checked_at)}
      </div>

      {uptime && (
        <div className="pl-uptime-grid">
          <div className="pl-panel pl-uptime-cell">
            <div className="pl-uptime-cell__value">{uptime["24h"].uptime_pct != null ? `${uptime["24h"].uptime_pct}%` : "N/A"}</div>
            <div className="pl-uptime-cell__label">24 hours</div>
          </div>
          <div className="pl-panel pl-uptime-cell">
            <div className="pl-uptime-cell__value">{uptime["7d"].uptime_pct != null ? `${uptime["7d"].uptime_pct}%` : "N/A"}</div>
            <div className="pl-uptime-cell__label">7 days</div>
          </div>
          <div className="pl-panel pl-uptime-cell">
            <div className="pl-uptime-cell__value">{uptime["30d"].uptime_pct != null ? `${uptime["30d"].uptime_pct}%` : "N/A"}</div>
            <div className="pl-uptime-cell__label">30 days</div>
          </div>
        </div>
      )}

      <div className="pl-section-label">Uptime history</div>
      <div className="pl-panel">
        {dailyUptime.length > 0 ? (
          <MonitorHeatmap dailyData={dailyUptime} createdAt={monitor.created_at} days={90} />
        ) : (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>Not enough history yet.</div>
        )}
      </div>

      <div className="pl-section-label">Security scan</div>
      <div className="pl-panel">
        {security ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pl-badge" style={security.score < 70 ? { background: "var(--alert-dim)", color: "var(--alert)" } : undefined}>
              {security.score}/100
            </span>
            <span style={{ color: "var(--ink-dim)", fontSize: 12 }}>Last scanned {formatDateTime(security.scanned_at)}</span>
          </div>
        ) : (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>Not scanned yet.</div>
        )}
      </div>

      <div style={{ textAlign: "center", fontSize: 11, color: "var(--ink-faint)", margin: "24px 0 8px" }}>Powered by Pulse</div>
    </div>
  );
}
