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

function timeUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function daysUntil(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function isSnoozed(monitor) {
  return !!monitor.snoozed_until && new Date(monitor.snoozed_until).getTime() > Date.now();
}

// Thresholds are deliberately generous for a personal-app use case (most
// of what's being watched here is a small Render/Vercel backend, not a
// latency-sensitive trading API): comfortably fast, tolerably slow, and
// "something's actually wrong" - not fine-grained percentile bands.
function latencyColor(monitor) {
  // Snoozed means nothing has been checked recently on purpose, so the
  // last reading is stale by design - color it neutral rather than red or
  // green, since either would misrepresent it as current information.
  if (isSnoozed(monitor)) return "var(--ink-dim)";
  if (monitor.current_status === "down") return "var(--alert)";
  const ms = monitor.last_response_ms;
  if (ms == null) return "var(--ink)";
  if (ms < 300) return "var(--signal)";
  if (ms < 1500) return "var(--amber)";
  return "var(--alert)";
}

export default function MonitorCard({ monitor, onClick }) {
  const sslDays = daysUntil(monitor.ssl_expires_at);
  const domainDays = daysUntil(monitor.domain_expires_at);
  const expiringSoon = (sslDays !== null && sslDays < 14) || (domainDays !== null && domainDays < 14);
  const snoozed = isSnoozed(monitor);
  const dotClass = snoozed
    ? "" // neutral, no color modifier
    : monitor.current_status === "up"
    ? "pl-status-dot--up"
    : monitor.current_status === "down"
    ? "pl-status-dot--down"
    : "";

  return (
    <div className="pl-panel pl-monitor-card" onClick={onClick}>
      <div className={`pl-status-dot ${dotClass}`} />
      <div className="pl-monitor-card__main">
        <div className="pl-monitor-card__name">
          {monitor.name}
          {snoozed && <span className="pl-badge pl-badge--muted" style={{ marginLeft: 8 }}>snoozed {timeUntil(monitor.snoozed_until)}</span>}
          {monitor.keep_alive_target && <span className="pl-badge pl-badge--signal" style={{ marginLeft: 8 }}>keep-alive</span>}
          {expiringSoon && <span className="pl-badge pl-badge--amber" style={{ marginLeft: 8 }}>expiring soon</span>}
        </div>
      </div>
      <div className="pl-monitor-card__stats">
        <div className="pl-stat">
          <div className="pl-stat__value" style={{ color: latencyColor(monitor) }}>
            {monitor.last_response_ms != null ? `${monitor.last_response_ms}ms` : "N/A"}
          </div>
          <div className="pl-stat__label">latency</div>
        </div>
        <div className="pl-stat">
          <div className="pl-stat__value">{timeAgo(monitor.last_checked_at)}</div>
          <div className="pl-stat__label">checked</div>
        </div>
      </div>
    </div>
  );
}
