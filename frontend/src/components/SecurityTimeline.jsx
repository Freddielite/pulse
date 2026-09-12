import { SEVERITY_STYLE } from "./SecurityScanPanel.jsx";

// Human labels for each detector's event kind. Kept as a lookup rather
// than formatting the raw kind string, so a new detector shows up with a
// deliberate label instead of "third_party_origin_added" leaking into
// the UI.
const KIND_LABEL = {
  scan_regression: "Regression",
  scan_improvement: "Fixed",
  tls_fingerprint_changed: "Certificate",
  tls_posture: "TLS",
  dns_drift: "DNS",
  dangling_cname: "Takeover risk",
  ct_new_certificate: "CT log",
  auth_probe_failed: "Auth",
  auth_probe_recovered: "Auth",
  third_party_origin_added: "Supply chain",
  blacklist_flagged: "Blacklisted",
  blacklist_cleared: "Blacklist",
};

function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export default function SecurityTimeline({ events, onAcknowledge }) {
  if (!events) return null;

  const open = events.filter((event) => !event.acknowledged);

  return (
    <>
      <div className="pl-section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span>Security timeline</span>
        {open.length > 0 && (
          <span className="pl-badge" style={{ background: "var(--alert-dim)", color: "var(--alert)", fontSize: 10.5 }}>
            {open.length} unacknowledged
          </span>
        )}
      </div>
      <div className="pl-panel">
        {events.length === 0 ? (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>
            Nothing has changed since Pulse started watching this monitor. Certificate swaps, DNS record changes, new
            certificates in the public CT logs, and any security check that goes from passing to failing all show up
            here.
          </div>
        ) : (
          events.map((event, index) => {
            const style = SEVERITY_STYLE[event.severity] || SEVERITY_STYLE.medium;
            return (
              <div
                key={event.id}
                className="pl-finding-row"
                style={{ borderTop: index === 0 ? "none" : undefined, opacity: event.acknowledged ? 0.5 : 1 }}
              >
                <div className="pl-finding-row__text">
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span
                      className="pl-badge"
                      style={{ background: style.background, color: style.color, fontSize: 10, padding: "1px 7px" }}
                    >
                      {KIND_LABEL[event.kind] || event.kind}
                    </span>
                    <span style={{ color: event.acknowledged ? "var(--ink-dim)" : "var(--ink)" }}>{event.title}</span>
                    <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{relativeTime(event.created_at)}</span>
                  </div>
                  {event.detail && <div className="pl-finding-row__detail">{event.detail}</div>}
                </div>
                {!event.acknowledged && (
                  <button
                    type="button"
                    className="pl-btn pl-btn--ghost"
                    style={{ fontSize: 10.5, padding: "2px 8px", flexShrink: 0 }}
                    onClick={() => onAcknowledge(event.id)}
                  >
                    Acknowledge
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
