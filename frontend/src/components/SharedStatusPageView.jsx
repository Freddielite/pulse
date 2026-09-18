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

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

// 90 thin bars, one per day, oldest to newest - the same "history at a
// glance" visual every major status page uses. Degraded isn't a color
// here on purpose - see the backend's comment on dailyHistory for why
// the daily bucket only distinguishes down/not-down rather than
// approximating a stateful "N consecutive slow checks" concept after
// the fact.
function UptimeBar({ history }) {
  if (!history || history.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 2 }}>
        {history.map((day) => (
          <div
            key={day.date}
            title={`${day.date}: ${day.status === "down" ? "Outage" : day.status === "up" ? "Operational" : "No data"}`}
            style={{
              flex: 1,
              height: 22,
              borderRadius: 2,
              background: day.status === "down" ? "var(--alert)" : day.status === "up" ? "var(--signal)" : "var(--panel-border)",
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--ink-faint)", marginTop: 4 }}>
        <span>{history.length} days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}

// Deliberately just date + duration, matching the backend's own
// redaction (see routes/public.js) - no raw error text on a page a
// monitor's own visitors or clients might see.
function IncidentList({ incidents }) {
  if (!incidents || incidents.length === 0) return null;
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--panel-border)" }}>
      <div style={{ fontSize: 10.5, color: "var(--ink-faint)", textTransform: "uppercase", marginBottom: 6 }}>Recent incidents</div>
      {incidents.map((inc, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0", color: "var(--ink-dim)" }}>
          <span>{new Date(inc.started_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
          <span>{inc.resolved_at ? `Down for ${formatDuration(new Date(inc.resolved_at) - new Date(inc.started_at))}` : "Ongoing"}</span>
        </div>
      ))}
    </div>
  );
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
  const brand = page.branding;

  return (
    <div className="pl-shell">
      <div className="pl-header">
        <div className="pl-brand">
          {brand?.brand_logo_url ? (
            <img src={brand.brand_logo_url} alt="" width={24} height={24} style={{ borderRadius: 6, objectFit: "cover" }} />
          ) : (
            <BrandMark />
          )}
          {brand?.brand_name?.trim() || "Pulse"}
        </div>
      </div>

      <div className="pl-detail-head">
        <div>
          <div className="pl-detail-title">{page.name}</div>
        </div>
        <span
          className={`pl-badge ${allUp ? "pl-badge--signal" : "pl-badge--amber"}`}
          style={
            !allUp
              ? { background: "var(--alert-dim)", color: "var(--alert)" }
              : brand?.brand_accent_color
                ? { background: `${brand.brand_accent_color}22`, color: brand.brand_accent_color }
                : undefined
          }
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
          <div className="pl-panel" key={m.id} style={{ marginTop: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                <div className={`pl-status-dot ${m.current_status === "up" ? "pl-status-dot--up" : m.current_status === "degraded" ? "pl-status-dot--degraded" : m.current_status === "down" ? "pl-status-dot--down" : ""}`} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                    {m.last_response_ms != null ? `${m.last_response_ms}ms · ` : ""}Checked {timeAgo(m.last_checked_at)}
                  </div>
                </div>
              </div>
              <div className="pl-status-page-row__stats" style={{ display: "flex", flexShrink: 0 }}>
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
            <UptimeBar history={m.dailyHistory} />
            <IncidentList incidents={m.recentIncidents} />
          </div>
        ))
      )}

      {!brand?.brand_name && (
        <div style={{ textAlign: "center", fontSize: 11, color: "var(--ink-faint)", margin: "24px 0 8px" }}>Powered by Pulse</div>
      )}
    </div>
  );
}
