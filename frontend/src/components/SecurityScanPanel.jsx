import { useState } from "react";

// Severity presentation, in one place. The palette rule this app already
// follows is that red and amber are never decoration - they only ever
// appear when something actually means them - so critical and high get
// the alert color, medium gets amber, and low/info stay neutral rather
// than inventing two more colors that would dilute the first two.
const SEVERITY_STYLE = {
  critical: { label: "Critical", color: "var(--alert)", background: "var(--alert-dim)" },
  high: { label: "High", color: "var(--alert)", background: "var(--alert-dim)" },
  medium: { label: "Medium", color: "var(--amber)", background: "var(--amber-dim)" },
  low: { label: "Low", color: "var(--ink-dim)", background: "rgba(255,255,255,0.05)" },
  info: { label: "Info", color: "var(--ink-faint)", background: "rgba(255,255,255,0.04)" },
};

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

const PLATFORMS = [
  { key: "nginx", label: "nginx" },
  { key: "express", label: "Express" },
  { key: "vercel", label: "Vercel" },
  { key: "netlify", label: "Netlify" },
  { key: "cloudflare", label: "Cloudflare" },
  { key: "general", label: "Fix" },
];

function gradeColor(grade) {
  if (!grade) return "var(--ink-dim)";
  if (grade.startsWith("A")) return "var(--signal)";
  if (grade === "B" || grade === "C") return "var(--amber)";
  return "var(--alert)";
}

// A plain inline SVG rather than pulling recharts in for what is
// literally a polyline. ResponseTimeChart earns recharts because it has
// tooltips, axes and downsampling; a score trend has none of that.
function ScoreTrend({ history }) {
  if (!history || history.length < 2) return null;
  const width = 240;
  const height = 40;
  const scores = history.map((entry) => entry.score);
  const min = Math.min(...scores, 60);
  const max = 100;
  const points = history
    .map((entry, index) => {
      const x = (index / (history.length - 1)) * width;
      const y = height - ((entry.score - min) / (max - min || 1)) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const latest = scores[scores.length - 1];
  const first = scores[0];
  const trendColor = latest < first ? "var(--alert)" : latest > first ? "var(--signal)" : "var(--ink-dim)";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible" }} aria-hidden="true">
        <polyline points={points} fill="none" stroke={trendColor} strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
        {history.length} scans
        {latest !== first ? ` · ${latest > first ? "+" : ""}${latest - first} since the first` : " · no change"}
      </span>
    </div>
  );
}

function Remediation({ remediation }) {
  const [platform, setPlatform] = useState("nginx");
  const available = PLATFORMS.filter((entry) => remediation[entry.key]);
  if (available.length === 0) return null;
  const active = available.some((entry) => entry.key === platform) ? platform : available[0].key;

  return (
    <div style={{ marginTop: 8, padding: 10, background: "rgba(0,0,0,0.25)", borderRadius: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {available.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="pl-btn pl-btn--ghost"
            style={{
              fontSize: 10.5,
              padding: "2px 8px",
              color: entry.key === active ? "var(--ink)" : "var(--ink-faint)",
            }}
            onClick={() => setPlatform(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <code
        style={{
          fontSize: 11.5,
          fontFamily: "var(--font-mono)",
          color: "var(--ink-dim)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          display: "block",
        }}
      >
        {remediation[active]}
      </code>
    </div>
  );
}

function Finding({ finding }) {
  const [expanded, setExpanded] = useState(false);
  const style = SEVERITY_STYLE[finding.severity] || SEVERITY_STYLE.medium;
  const hasFix = !finding.pass && finding.remediation;

  return (
    <div className="pl-finding-row">
      <div className="pl-finding-row__text">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: finding.pass ? "var(--ink)" : style.color }}>{finding.check}</span>
          {!finding.pass && (
            <span
              className="pl-badge"
              style={{ background: style.background, color: style.color, fontSize: 10, padding: "1px 7px" }}
            >
              {style.label}
            </span>
          )}
        </div>
        <div className="pl-finding-row__detail">{finding.detail}</div>
        {hasFix && (
          <>
            <button
              type="button"
              className="pl-btn pl-btn--ghost"
              style={{ fontSize: 10.5, padding: "2px 8px", marginTop: 6 }}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Hide fix" : "Show fix"}
            </button>
            {expanded && <Remediation remediation={finding.remediation} />}
          </>
        )}
      </div>
      <div className="pl-finding-row__result" style={{ color: finding.pass ? "var(--signal)" : style.color }}>
        {finding.pass ? "Pass" : "Fail"}
      </div>
    </div>
  );
}

export default function SecurityScanPanel({ monitor, security, history, scanning, onRescan, onDownloadReport, canManage = true }) {
  // Failures first is already the server's sort order (see sortFindings
  // in lib/severity.js), but passes are collapsed by default here: a scan
  // now runs 30-odd checks, and a wall of green is exactly the thing that
  // stops people reading the four red ones at the top.
  const [showPasses, setShowPasses] = useState(false);

  const findings = security?.findings || [];
  const failures = findings.filter((finding) => !finding.pass);
  const passes = findings.filter((finding) => finding.pass);
  const summary = security?.summary || {};

  return (
    <>
      <div
        className="pl-section-label"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "6px 8px" }}
      >
        <span>Security scan</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {security && (
            <button type="button" className="pl-btn pl-btn--ghost" style={{ fontSize: 11, padding: "3px 10px" }} onClick={onDownloadReport}>
              Download report
            </button>
          )}
          {/* Downloading a report is read-only - open to any member,
              even one who can't trigger the scan that produced it. */}
          {canManage && (
            <button
              type="button"
              className="pl-btn pl-btn--ghost"
              style={{ fontSize: 11, padding: "3px 10px" }}
              onClick={onRescan}
              disabled={scanning}
            >
              {scanning ? "Scanning…" : "Rescan now"}
            </button>
          )}
        </div>
      </div>

      <div className="pl-panel">
        {!security ? (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>
            Not scanned yet. Runs automatically once a day, or hit "Rescan now."
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <span
                className="pl-badge"
                style={{
                  background: "rgba(255,255,255,0.05)",
                  color: gradeColor(security.grade),
                  fontSize: 15,
                  fontFamily: "var(--font-display)",
                  padding: "2px 12px",
                }}
              >
                {security.grade || "—"}
              </span>
              <span style={{ fontSize: 13, color: "var(--ink)" }}>{security.score}/100</span>
              <span style={{ color: "var(--ink-dim)", fontSize: 12 }}>Scanned {new Date(security.scanned_at).toLocaleString()}</span>
            </div>

            {/* Severity breakdown, so "82/100" can't hide a critical. */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {SEVERITY_ORDER.filter((severity) => summary[severity] > 0).map((severity) => (
                <span
                  key={severity}
                  className="pl-badge"
                  style={{
                    background: SEVERITY_STYLE[severity].background,
                    color: SEVERITY_STYLE[severity].color,
                    fontSize: 10.5,
                  }}
                >
                  {summary[severity]} {SEVERITY_STYLE[severity].label.toLowerCase()}
                </span>
              ))}
              {failures.length === 0 && (
                <span className="pl-badge pl-badge--signal" style={{ fontSize: 10.5 }}>
                  everything passing
                </span>
              )}
            </div>

            {history && history.length > 1 && (
              <div style={{ marginBottom: 14 }}>
                <ScoreTrend history={history} />
              </div>
            )}

            {failures.map((finding, index) => (
              <Finding key={`${finding.check}-${index}`} finding={finding} />
            ))}

            {passes.length > 0 && (
              <>
                <button
                  type="button"
                  className="pl-btn pl-btn--ghost"
                  style={{ fontSize: 11, padding: "3px 10px", marginTop: failures.length > 0 ? 12 : 0 }}
                  onClick={() => setShowPasses(!showPasses)}
                >
                  {showPasses ? "Hide" : "Show"} {passes.length} passing check{passes.length === 1 ? "" : "s"}
                </button>
                {showPasses && passes.map((finding, index) => <Finding key={`${finding.check}-pass-${index}`} finding={finding} />)}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

export { SEVERITY_STYLE, gradeColor };
