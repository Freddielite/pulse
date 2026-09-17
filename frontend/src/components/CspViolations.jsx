import { usePagedList } from "../hooks/usePagedList.js";

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

// Shortens a URL for display the same way the badge and share panels
// don't bother to - these can be long (a blocked third-party script URL
// with a full path), and the count/last-seen columns matter more than
// seeing every character of it inline.
function shorten(value, max = 60) {
  if (!value) return "-";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export default function CspViolations({ violations, onClear, clearing, canManage = true }) {
  const page = usePagedList(violations);
  if (!violations) return null;

  return (
    <>
      <div className="pl-section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span>CSP violations</span>
        {violations.length > 0 && canManage && (
          <button type="button" className="pl-btn pl-btn--ghost" style={{ fontSize: 10.5, padding: "2px 8px" }} onClick={onClear} disabled={clearing}>
            {clearing ? "Clearing…" : "Clear"}
          </button>
        )}
      </div>
      <div className="pl-panel">
        {violations.length === 0 ? (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>
            Nothing reported yet. This fills in once the monitored site's Content-Security-Policy points its
            report-to or report-uri at Pulse's report endpoint (see the "CSP violation reports" section under Share
            link) and a real visitor's browser actually blocks something. An empty list can mean either that it
            isn't wired up yet, or that it is and nothing has tripped it - it's not itself a pass/fail check.
          </div>
        ) : (
          page.visible.map((v, index) => (
            <div key={v.id} className="pl-finding-row" style={{ borderTop: index === 0 ? "none" : undefined }}>
              <div className="pl-finding-row__text">
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="pl-badge" style={{ background: "var(--alert-dim)", color: "var(--alert)", fontSize: 10, padding: "1px 7px" }}>
                    {v.violated_directive || "unknown directive"}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>
                    {v.count} time{v.count === 1 ? "" : "s"} · last {relativeTime(v.last_seen_at)}
                  </span>
                </div>
                <div className="pl-finding-row__detail">
                  Blocked: {shorten(v.blocked_uri)}
                  {v.source_file && (
                    <>
                      {" "}
                      · From: {shorten(v.source_file)}
                      {v.line_number ? `:${v.line_number}` : ""}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
        {page.hasMore && (
          <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" style={{ marginTop: 10 }} onClick={page.showMore}>
            Show {Math.min(10, page.remaining)} more ({page.remaining} hidden)
          </button>
        )}
      </div>
    </>
  );
}
