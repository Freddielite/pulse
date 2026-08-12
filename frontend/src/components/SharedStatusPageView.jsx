import { useEffect, useState } from "react";
import { getSharedStatusPage } from "../api.js";

function timeAgo(iso) {
  if (!iso) return "never checked";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
// is a combined status page link (#/status/<token>) - same no-session
// shape as SharedMonitorView, just fanned out over several monitors from
// one /public/status-pages/:token call instead of one monitor from
// several calls.
export default function SharedStatusPageView({ token }) {
  const [page, setPage] = useState(undefined); // undefined = loading, null = invalid/revoked
  const [error, setError] = useState(null);

  useEffect(() => {
    let ignore = false;
    getSharedStatusPage(token)
      .then((p) => {
        if (!ignore) setPage(p);
      })
      .catch((err) => {
        if (ignore) return;
        setError(err.message);
        setPage(null);
      });
    return () => {
      ignore = true;
    };
  }, [token]);

  if (page === undefined) return null;

  if (page === null) {
    return (
      <div className="pl-auth">
        <div className="pl-panel pl-auth__card">
          <div className="pl-auth__brand">
            <BrandMark />
            Pulse
          </div>
          <div className="pl-auth__tagline">{error || "This status page link is invalid or has been revoked."}</div>
        </div>
      </div>
    );
  }

  const allUp = page.monitors.every((m) => m.current_status === "up");

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
          <div className="pl-detail-title">{page.name}</div>
        </div>
        <span
          className={`pl-badge ${allUp ? "pl-badge--signal" : "pl-badge--amber"}`}
          style={!allUp ? { background: "var(--alert-dim)", color: "var(--alert)" } : undefined}
        >
          {allUp ? "All systems operational" : "Attention needed"}
        </span>
      </div>

      {page.monitors.length === 0 ? (
        <div className="pl-panel" style={{ marginTop: 14, color: "var(--ink-dim)", fontSize: 13 }}>
          Nothing to show yet.
        </div>
      ) : (
        page.monitors.map((m) => (
          <div className="pl-panel" key={m.id} style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className={`pl-status-dot ${m.current_status === "up" ? "pl-status-dot--up" : m.current_status === "degraded" ? "pl-status-dot--degraded" : m.current_status === "down" ? "pl-status-dot--down" : ""}`} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{m.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>Checked {timeAgo(m.last_checked_at)}</div>
              </div>
            </div>
            <div className="pl-status-page-row__stats" style={{ display: "flex" }}>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{m.uptime["24h"] != null ? `${m.uptime["24h"]}%` : "N/A"}</div>
                <div style={{ fontSize: 10, color: "var(--ink-faint)", textTransform: "uppercase" }}>24h</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{m.uptime["7d"] != null ? `${m.uptime["7d"]}%` : "N/A"}</div>
                <div style={{ fontSize: 10, color: "var(--ink-faint)", textTransform: "uppercase" }}>7d</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{m.uptime["30d"] != null ? `${m.uptime["30d"]}%` : "N/A"}</div>
                <div style={{ fontSize: 10, color: "var(--ink-faint)", textTransform: "uppercase" }}>30d</div>
              </div>
            </div>
          </div>
        ))
      )}

      <div style={{ textAlign: "center", fontSize: 11, color: "var(--ink-faint)", margin: "24px 0 8px" }}>Powered by Pulse</div>
    </div>
  );
}
