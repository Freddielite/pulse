import { useState } from "react";
import { updateAuthScanConfig, runAuthScan } from "../api.js";
import { SEVERITY_STYLE, gradeColor } from "./SecurityScanPanel.jsx";

function FindingRow({ finding }) {
  const style = SEVERITY_STYLE[finding.severity] || SEVERITY_STYLE.info;
  return (
    <div className="pl-finding-row">
      <div className="pl-finding-row__text">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{finding.check}</span>
          <span className="pl-badge" style={{ background: style.background, color: style.color, fontSize: 10, padding: "1px 7px" }}>
            {style.label}
          </span>
        </div>
        <div className="pl-finding-row__detail">{finding.detail}</div>
      </div>
      <div className="pl-finding-row__result" style={{ color: finding.pass ? "var(--signal)" : "var(--alert)" }}>
        {finding.pass ? "Pass" : "Fail"}
      </div>
    </div>
  );
}

// Opt-in per monitor, off by default, and this panel is the entire
// consent flow - see db.js's auth_scan_* columns and lib/authScan.js for
// what actually happens once it's on. Nothing here is shown unless
// canManage, same as every other configuration surface on a monitor.
export default function AuthenticatedScanPanel({ monitor, latestScan, onChanged, canManage = true }) {
  const [expanded, setExpanded] = useState(false);
  const [credentialType, setCredentialType] = useState("cookie");
  const [cookieName, setCookieName] = useState("");
  const [cookieValue, setCookieValue] = useState("");
  const [bearerValue, setBearerValue] = useState("");
  const [protectedPathsText, setProtectedPathsText] = useState((monitor.auth_scan_protected_paths || []).join("\n"));
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);

  const enabled = !!monitor.auth_scan_enabled;

  async function handleEnable(e) {
    e.preventDefault();
    setError(null);
    const credential =
      credentialType === "bearer" ? { type: "bearer", value: bearerValue.trim() } : { type: "cookie", name: cookieName.trim(), value: cookieValue.trim() };
    const protected_paths = protectedPathsText
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      await updateAuthScanConfig(monitor.id, { enabled: true, credential, protected_paths });
      setCookieValue("");
      setBearerValue("");
      setExpanded(false);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDisable() {
    setSaving(true);
    try {
      await updateAuthScanConfig(monitor.id, { enabled: false });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePaths() {
    const protected_paths = protectedPathsText
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    setSaving(true);
    setError(null);
    try {
      await updateAuthScanConfig(monitor.id, { protected_paths });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRunNow() {
    setScanning(true);
    setError(null);
    try {
      await runAuthScan(monitor.id);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  }

  return (
    <>
      <div className="pl-section-label">Authenticated scan</div>
      <div className="pl-panel">
        {!enabled ? (
          !expanded ? (
            <div>
              <div style={{ fontSize: 13, color: "var(--ink-dim)", marginBottom: 10 }}>
                The regular scan can only see what an anonymous visitor sees. This checks a logged-in area too, using a session cookie or bearer
                token you provide - never a username or password. Pulse stores it encrypted and only ever sends it back to this monitor's own URL.
              </div>
              {canManage && (
                <button type="button" className="pl-btn pl-btn--sm" onClick={() => setExpanded(true)}>
                  Set up authenticated scan
                </button>
              )}
            </div>
          ) : (
            <form onSubmit={handleEnable}>
              <div style={{ fontSize: 12.5, color: "var(--ink-dim)", marginBottom: 12 }}>
                Copy a session cookie or bearer token from your own browser's dev tools after logging in yourself. This credential will be sent
                back to <strong>{monitor.url}</strong> on a schedule, and nowhere else.
              </div>
              <div className="pl-field">
                <label>Credential type</label>
                <div style={{ display: "flex", gap: 12 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input type="radio" checked={credentialType === "cookie"} onChange={() => setCredentialType("cookie")} /> Session cookie
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                    <input type="radio" checked={credentialType === "bearer"} onChange={() => setCredentialType("bearer")} /> Bearer token
                  </label>
                </div>
              </div>
              {credentialType === "cookie" ? (
                <>
                  <div className="pl-field">
                    <label>Cookie name</label>
                    <input value={cookieName} onChange={(e) => setCookieName(e.target.value)} placeholder="e.g. session, connect.sid" required />
                  </div>
                  <div className="pl-field">
                    <label>Cookie value</label>
                    <input value={cookieValue} onChange={(e) => setCookieValue(e.target.value)} type="password" required />
                  </div>
                </>
              ) : (
                <div className="pl-field">
                  <label>Bearer token</label>
                  <input value={bearerValue} onChange={(e) => setBearerValue(e.target.value)} type="password" required />
                </div>
              )}
              <div className="pl-field">
                <label>Paths that should require login (optional, one per line)</label>
                <textarea
                  value={protectedPathsText}
                  onChange={(e) => setProtectedPathsText(e.target.value)}
                  placeholder={"/admin\n/api/account"}
                  rows={3}
                />
                <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 4 }}>
                  Each one is checked without your credential - if any of them answer anyway, that's flagged as critical.
                </div>
              </div>
              {error && <div className="pl-error">{error}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="button" className="pl-btn pl-btn--ghost" onClick={() => setExpanded(false)} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="pl-btn" disabled={saving}>
                  {saving ? "Saving..." : "Enable"}
                </button>
              </div>
            </form>
          )
        ) : (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 13, color: "var(--ink-dim)" }}>
                Enabled{monitor.auth_scan_consent_at ? ` since ${new Date(monitor.auth_scan_consent_at).toLocaleDateString()}` : ""}.
                {latestScan ? ` Last run ${new Date(latestScan.scanned_at).toLocaleString()}.` : " Not run yet."}
              </div>
              {latestScan && (
                <div style={{ fontSize: 20, fontWeight: 700, color: gradeColor(latestScan.grade), flexShrink: 0 }}>{latestScan.score}</div>
              )}
            </div>
            {canManage && (
              <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <button type="button" className="pl-btn pl-btn--sm" onClick={handleRunNow} disabled={scanning}>
                  {scanning ? "Scanning..." : "Run now"}
                </button>
                <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? "Hide settings" : "Edit paths / credential"}
                </button>
                <button type="button" className="pl-btn pl-btn--danger pl-btn--sm" onClick={handleDisable} disabled={saving}>
                  Disable
                </button>
              </div>
            )}
            {expanded && canManage && (
              <div style={{ borderTop: "1px solid var(--panel-border)", paddingTop: 12, marginBottom: 12 }}>
                <div className="pl-field">
                  <label>Paths that should require login (one per line)</label>
                  <textarea value={protectedPathsText} onChange={(e) => setProtectedPathsText(e.target.value)} rows={3} />
                </div>
                <button type="button" className="pl-btn pl-btn--sm" onClick={handleSavePaths} disabled={saving}>
                  {saving ? "Saving..." : "Save paths"}
                </button>
                <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 10 }}>
                  To replace the stored credential, disable and set it up again - it's never shown back to you once saved.
                </div>
              </div>
            )}
            {error && <div className="pl-error">{error}</div>}
            {latestScan?.findings?.length > 0 && (
              <div>
                {latestScan.findings.map((finding, i) => (
                  <FindingRow key={i} finding={finding} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
