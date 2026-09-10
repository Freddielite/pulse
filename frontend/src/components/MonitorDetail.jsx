import { useEffect, useState } from "react";
import { getMonitorChecks, getMonitorIncidents, getMonitorUptime, getMonitorDailyUptime, getMonitorSecurity, runSecurityScan, deleteMonitor, snoozeMonitor, unsnoozeMonitor, enableMonitorShare, regenerateMonitorShare, revokeMonitorShare, getSecurityHistory, getSecurityEvents, acknowledgeSecurityEvent, getMonitorTls, getMonitorDns, runDnsCheck, getMonitorCertificates, runCertificateCheck, createMonitor } from "../api.js";
import ConfirmDialog from "./ConfirmDialog.jsx";
import MonitorForm from "./MonitorForm.jsx";
import MonitorHeatmap from "./MonitorHeatmap.jsx";
import ResponseTimeChart from "./ResponseTimeChart.jsx";
import SecurityScanPanel from "./SecurityScanPanel.jsx";
import SecurityTimeline from "./SecurityTimeline.jsx";
import { TlsPanel, DnsPanel, CertificatesPanel } from "./DomainPanels.jsx";

const SNOOZE_OPTIONS = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "4h", minutes: 240 },
  { label: "24h", minutes: 1440 },
];

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return `${hours}h ${rem}m`;
}

function formatDate(iso) {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso) {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function MonitorDetail({ monitor, existingGroups = [], onBack, onChanged, toast }) {
  const [checks, setChecks] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [uptime, setUptime] = useState(null);
  const [dailyUptime, setDailyUptime] = useState([]);
  const [security, setSecurity] = useState(null);
  const [securityHistory, setSecurityHistory] = useState([]);
  const [securityEvents, setSecurityEvents] = useState([]);
  const [tls, setTls] = useState(null);
  const [dns, setDns] = useState(null);
  const [certificates, setCertificates] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [dnsRefreshing, setDnsRefreshing] = useState(false);
  const [ctRefreshing, setCtRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);

  // #/share/<token> - resolves through main.jsx's hash router, which
  // renders SharedMonitorView with no session at all.
  const shareUrl = monitor.share_token ? `${window.location.origin}${window.location.pathname}#/share/${monitor.share_token}` : null;

  const snoozed = !!monitor.snoozed_until && new Date(monitor.snoozed_until).getTime() > Date.now();

  async function load(ignore) {
    // A TCP monitor has no HTTP surface to scan and no certificate or DNS
    // panel rendered for it, so those reads are skipped rather than
    // fetched and discarded.
    const httpish = monitor.monitor_type !== "tcp";
    const [c, i, u, d, s, sh, se, t, dn, ct] = await Promise.all([
      getMonitorChecks(monitor.id),
      getMonitorIncidents(monitor.id),
      getMonitorUptime(monitor.id),
      getMonitorDailyUptime(monitor.id),
      getMonitorSecurity(monitor.id),
      httpish ? getSecurityHistory(monitor.id) : Promise.resolve([]),
      getSecurityEvents(monitor.id),
      httpish ? getMonitorTls(monitor.id) : Promise.resolve(null),
      httpish ? getMonitorDns(monitor.id) : Promise.resolve(null),
      httpish ? getMonitorCertificates(monitor.id) : Promise.resolve(null),
    ]);
    // Guards against a slow response from a monitor you've since navigated
    // away from landing after the fact and overwriting whatever's actually
    // on screen now. Without this, switching monitors quickly enough could
    // let an older monitor's in-flight fetch "leak" its data onto whichever
    // monitor you're viewing by the time it resolves.
    if (ignore?.current) return;
    setChecks(c);
    setIncidents(i);
    setUptime(u);
    setDailyUptime(d);
    setSecurity(s);
    setSecurityHistory(sh || []);
    setSecurityEvents(se || []);
    setTls(t);
    setDns(dn);
    setCertificates(ct);
  }

  useEffect(() => {
    const ignore = { current: false };
    load(ignore);
    // Light auto-refresh so the detail view reflects new checks without
    // needing a manual reload while you're sitting on the page.
    const id = window.setInterval(() => load(ignore), 30000);
    return () => {
      ignore.current = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitor.id]);

  async function handleDelete() {
    await deleteMonitor(monitor.id);
    toast("Monitor deleted.");
    onChanged();
    onBack();
  }

  async function handleSnooze(minutes) {
    setSnoozing(true);
    try {
      await snoozeMonitor(monitor.id, minutes);
      toast(`Snoozed for ${minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}.`);
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSnoozing(false);
    }
  }

  async function handleUnsnooze() {
    setSnoozing(true);
    try {
      await unsnoozeMonitor(monitor.id);
      toast("Snooze cleared.");
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSnoozing(false);
    }
  }

  async function handleRunScan() {
    setScanning(true);
    try {
      const result = await runSecurityScan(monitor.id);
      setSecurity(result);
      // A scan can produce regression events, so the timeline and the
      // trend both need re-reading - not just the scan itself.
      const [history, events] = await Promise.all([getSecurityHistory(monitor.id), getSecurityEvents(monitor.id)]);
      setSecurityHistory(history || []);
      setSecurityEvents(events || []);
      toast(`Scan complete: ${result.score}/100 (${result.grade}).`);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setScanning(false);
    }
  }

  async function handleAcknowledgeEvent(eventId) {
    try {
      const updated = await acknowledgeSecurityEvent(monitor.id, eventId);
      setSecurityEvents((events) => events.map((event) => (event.id === updated.id ? updated : event)));
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function handleRefreshDns() {
    setDnsRefreshing(true);
    try {
      await runDnsCheck(monitor.id);
      const [nextDns, events] = await Promise.all([getMonitorDns(monitor.id), getSecurityEvents(monitor.id)]);
      setDns(nextDns);
      setSecurityEvents(events || []);
      toast("DNS records refreshed.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setDnsRefreshing(false);
    }
  }

  async function handleRefreshCertificates() {
    setCtRefreshing(true);
    try {
      await runCertificateCheck(monitor.id);
      const [next, events] = await Promise.all([getMonitorCertificates(monitor.id), getSecurityEvents(monitor.id)]);
      setCertificates(next);
      setSecurityEvents(events || []);
      toast("Certificate transparency logs checked.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setCtRefreshing(false);
    }
  }

  // One-click "monitor this too" on a subdomain discovered in the CT
  // logs. Inherits this monitor's group and interval, since a subdomain
  // found this way almost always belongs with the monitor that found it.
  async function handleMonitorSubdomain(hostname) {
    try {
      await createMonitor({
        name: hostname,
        url: `https://${hostname}`,
        group_name: monitor.group_name || null,
        check_interval_min: monitor.check_interval_min,
      });
      const next = await getMonitorCertificates(monitor.id);
      setCertificates(next);
      onChanged();
      toast(`Now monitoring ${hostname}.`);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function handleEnableShare() {
    setShareBusy(true);
    try {
      await enableMonitorShare(monitor.id);
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function handleRegenerateShare() {
    setShareBusy(true);
    try {
      await regenerateMonitorShare(monitor.id);
      toast("New link generated - the old one no longer works.");
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function handleRevokeShare() {
    setShareBusy(true);
    try {
      await revokeMonitorShare(monitor.id);
      toast("Share link revoked.");
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setShareBusy(false);
    }
  }

  async function handleCopyShareLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast("Copied to clipboard.");
    } catch {
      toast("Couldn't copy automatically - select and copy it manually.", "error");
    }
  }

  function handleDownloadReport() {
    if (!security) return;

    const findings = security.findings || [];
    const failures = findings.filter((finding) => !finding.pass);
    const passes = findings.filter((finding) => finding.pass);
    const summary = security.summary || {};
    const posture = tls?.tls_posture;

    // This is the artifact a client actually reads, so it leads with the
    // grade and the failures rather than dumping every check in scan
    // order. Each failure carries its severity and, where there is one,
    // the exact configuration change that fixes it - a report that says
    // "add a Content-Security-Policy header" gets filed; one that says
    // what to paste into vercel.json gets acted on.
    const lines = [
      `SECURITY REPORT`,
      `${monitor.name} - ${monitor.url}`,
      `Generated ${new Date().toLocaleString()}`,
      `Scan taken ${formatDateTime(security.scanned_at)}`,
      ``,
      `OVERALL: ${security.grade || "-"} (${security.score}/100)`,
      Object.entries(summary)
        .filter(([, count]) => count > 0)
        .map(([severity, count]) => `${count} ${severity}`)
        .join(", ") || `No failing checks.`,
      ``,
    ];

    if (posture) {
      lines.push(
        `TLS`,
        `---`,
        `Issuer: ${posture.issuer || "unknown"}`,
        `Protocol: ${posture.protocol || "unknown"}${posture.cipherName ? ` (${posture.cipherName})` : ""}`,
        `Key: ${posture.keyType || "unknown"}${posture.keyBits ? ` ${posture.keyBits}-bit` : ""}`,
        `Chain: ${posture.chainLength} certificate(s) sent`,
        `Expires: ${monitor.ssl_expires_at ? formatDate(monitor.ssl_expires_at) : "unknown"}`,
        `SHA-256: ${posture.fingerprint256 || "unknown"}`,
        ``
      );
    }

    if (failures.length > 0) {
      lines.push(`ISSUES FOUND (${failures.length})`, `${"=".repeat(24)}`, ``);
      failures.forEach((finding, index) => {
        lines.push(`${index + 1}. [${String(finding.severity || "medium").toUpperCase()}] ${finding.check}`);
        lines.push(`   ${finding.detail}`);
        if (finding.remediation) {
          const fix = finding.remediation.nginx || finding.remediation.express;
          if (fix) lines.push(`   Fix (nginx): ${fix}`);
          if (finding.remediation.vercel) lines.push(`   Fix (Vercel): ${finding.remediation.vercel.replace(/\n/g, " ")}`);
        }
        lines.push(``);
      });
    } else {
      lines.push(`No failing checks.`, ``);
    }

    const openEvents = (securityEvents || []).filter((event) => !event.acknowledged);
    if (openEvents.length > 0) {
      lines.push(`RECENT CHANGES (${openEvents.length} unacknowledged)`, `${"=".repeat(24)}`, ``);
      for (const event of openEvents) {
        lines.push(`- [${String(event.severity).toUpperCase()}] ${new Date(event.created_at).toLocaleString()} - ${event.title}`);
        if (event.detail) lines.push(`  ${event.detail}`);
      }
      lines.push(``);
    }

    lines.push(`PASSING CHECKS (${passes.length})`, `${"=".repeat(24)}`, ...passes.map((finding) => `[PASS] ${finding.check}`), ``);
    lines.push(
      `Scope note: every check in this report is a passive, outside-in observation.`,
      `Nothing was exploited, submitted, or authenticated against.`,
      ``,
      `Generated by Pulse`
    );

    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const datePart = new Date(security.scanned_at).toISOString().slice(0, 10);
    a.href = url;
    a.download = `${monitor.name.replace(/[^a-z0-9]+/gi, "-")}-security-report-${datePart}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={onBack} style={{ marginBottom: 16 }}>Back</button>

      <div className="pl-detail-head">
        <div>
          <div className="pl-detail-title">
            {monitor.name}
            {monitor.monitor_type === "synthetic" && (
              <span className="pl-badge pl-badge--muted">
                multi-step - {(monitor.synthetic_steps || []).length} step{(monitor.synthetic_steps || []).length === 1 ? "" : "s"}
              </span>
            )}
            {monitor.monitor_type === "tcp" && <span className="pl-badge pl-badge--muted">TCP / port</span>}
            {monitor.current_status === "degraded" && <span className="pl-badge pl-badge--amber">slow</span>}
          </div>
          <div className="pl-detail-url">{monitor.url}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => setEditing(true)}>Edit</button>
          <button className="pl-btn pl-btn--danger pl-btn--sm" onClick={() => setConfirmingDelete(true)}>Delete</button>
        </div>
      </div>

      <div className="pl-panel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
        {snoozed ? (
          <>
            <span style={{ fontSize: 13, color: "var(--ink-dim)" }}>
              Snoozed until {formatDateTime(monitor.snoozed_until)}, checks are paused.
            </span>
            <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleUnsnooze} disabled={snoozing}>Unsnooze</button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 13, color: "var(--ink-dim)" }}>Snooze checks</span>
            <div style={{ display: "flex", gap: 6 }}>
              {SNOOZE_OPTIONS.map((opt) => (
                <button key={opt.minutes} className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => handleSnooze(opt.minutes)} disabled={snoozing}>
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {uptime ? (
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
      ) : (
        <div className="pl-uptime-grid">
          <div className="pl-panel pl-uptime-cell">
            <div className="pl-skeleton" style={{ width: "60%", height: 21, margin: "0 auto" }} />
          </div>
          <div className="pl-panel pl-uptime-cell">
            <div className="pl-skeleton" style={{ width: "60%", height: 21, margin: "0 auto" }} />
          </div>
          <div className="pl-panel pl-uptime-cell">
            <div className="pl-skeleton" style={{ width: "60%", height: 21, margin: "0 auto" }} />
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

      <ResponseTimeChart checks={checks} />

      {monitor.monitor_type !== "tcp" && <TlsPanel monitor={monitor} tls={tls} />}

      {monitor.content_diff_enabled && (
        <>
          <div className="pl-section-label">Content monitoring</div>
          <div className="pl-panel">
            <div className="pl-expiry-row">
              <span className="pl-expiry-row__label">Last content change detected</span>
              <span>{monitor.content_changed_at ? formatDateTime(monitor.content_changed_at) : "No change since monitoring started"}</span>
            </div>
          </div>
        </>
      )}

      {monitor.auth_probe_enabled && monitor.auth_probe_status && (
        <>
          <div className="pl-section-label">Authentication assertion</div>
          <div className="pl-panel">
            <div className="pl-expiry-row">
              <span className="pl-expiry-row__label">Unauthenticated requests are refused</span>
              <span
                style={{
                  color:
                    monitor.auth_probe_status === "pass"
                      ? "var(--signal)"
                      : monitor.auth_probe_status === "fail"
                        ? "var(--alert)"
                        : "var(--ink-dim)",
                }}
              >
                {monitor.auth_probe_status === "pass"
                  ? `Yes (expects ${monitor.auth_probe_expect})`
                  : monitor.auth_probe_status === "fail"
                    ? "No - this endpoint is answering anonymous callers"
                    : "Couldn't determine"}
              </span>
            </div>
            {monitor.auth_probe_checked_at && (
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 8 }}>
                Checked {formatDateTime(monitor.auth_probe_checked_at)}, on every check cycle.
              </div>
            )}
          </div>
        </>
      )}

      {monitor.monitor_type !== "tcp" && (
        <SecurityScanPanel
          monitor={monitor}
          security={security}
          history={securityHistory}
          scanning={scanning}
          onRescan={handleRunScan}
          onDownloadReport={handleDownloadReport}
        />
      )}

      <SecurityTimeline events={securityEvents} onAcknowledge={handleAcknowledgeEvent} />

      {monitor.monitor_type !== "tcp" && (
        <DnsPanel dns={dns} onRefresh={handleRefreshDns} refreshing={dnsRefreshing} />
      )}

      {monitor.monitor_type !== "tcp" && monitor.ct_enabled !== false && (
        <CertificatesPanel
          data={certificates}
          onRefresh={handleRefreshCertificates}
          refreshing={ctRefreshing}
          onMonitorSubdomain={handleMonitorSubdomain}
        />
      )}

      <div className="pl-section-label">Share link</div>
      <div className="pl-panel">
        <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 10 }}>
          A read-only link scoped to this monitor's status, uptime, and security score - no login, no visibility into any other monitor.
        </div>
        {monitor.share_token ? (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <code style={{ fontSize: 12.5, wordBreak: "break-all", flex: 1 }}>{shareUrl}</code>
              <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleCopyShareLink}>Copy</button>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleRegenerateShare} disabled={shareBusy}>Regenerate</button>
              <button type="button" className="pl-btn pl-btn--danger pl-btn--sm" onClick={handleRevokeShare} disabled={shareBusy}>Revoke</button>
            </div>
          </>
        ) : (
          <button type="button" className="pl-btn pl-btn--sm" onClick={handleEnableShare} disabled={shareBusy}>
            {shareBusy ? "Creating…" : "Create share link"}
          </button>
        )}
      </div>

      <div className="pl-section-label">Incident history</div>
      <div className="pl-panel">
        {incidents.length === 0 ? (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>No incidents recorded. That's the goal.</div>
        ) : (
          incidents.map((inc) => (
            <div className="pl-incident-row" key={inc.id}>
              <div className="pl-incident-row__main">
                <div>{formatDateTime(inc.started_at)}</div>
                <div className="pl-incident-row__error">{inc.error_message}</div>
              </div>
              <div className="pl-incident-row__duration">
                {inc.resolved_at
                  ? formatDuration(new Date(inc.resolved_at) - new Date(inc.started_at))
                  : "Ongoing"}
              </div>
            </div>
          ))
        )}
      </div>

      {editing && (
        <MonitorForm
          monitor={monitor}
          existingGroups={existingGroups}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          toast={toast}
        />
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete this monitor?"
          body={`${monitor.name} and its full check history will be removed. This can't be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={handleDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
