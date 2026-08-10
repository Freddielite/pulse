import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getMonitorChecks, getMonitorIncidents, getMonitorUptime, getMonitorDailyUptime, getMonitorSecurity, runSecurityScan, getMonitorTraffic, deleteMonitor, snoozeMonitor, unsnoozeMonitor } from "../api.js";
import ConfirmDialog from "./ConfirmDialog.jsx";
import MonitorForm from "./MonitorForm.jsx";
import MonitorHeatmap from "./MonitorHeatmap.jsx";

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
  const [scanning, setScanning] = useState(false);
  const [traffic, setTraffic] = useState(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [snoozing, setSnoozing] = useState(false);

  const snoozed = !!monitor.snoozed_until && new Date(monitor.snoozed_until).getTime() > Date.now();

  async function load() {
    const [c, i, u, d, s, t] = await Promise.all([
      getMonitorChecks(monitor.id),
      getMonitorIncidents(monitor.id),
      getMonitorUptime(monitor.id),
      getMonitorDailyUptime(monitor.id),
      getMonitorSecurity(monitor.id),
      getMonitorTraffic(monitor.id),
    ]);
    setChecks(c);
    setIncidents(i);
    setUptime(u);
    setDailyUptime(d);
    setSecurity(s);
    setTraffic(t);
  }

  useEffect(() => {
    load();
    // Light auto-refresh so the detail view reflects new checks without
    // needing a manual reload while you're sitting on the page.
    const id = window.setInterval(load, 30000);
    return () => window.clearInterval(id);
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
      toast(`Scan complete: ${result.score}/100.`);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setScanning(false);
    }
  }

  const chartData = checks.map((c) => ({
    time: new Date(c.checked_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    ms: c.status === "up" ? c.response_ms : null,
  }));

  return (
    <div>
      <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={onBack} style={{ marginBottom: 16 }}>Back</button>

      <div className="pl-detail-head">
        <div>
          <div className="pl-detail-title">{monitor.name}</div>
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
          <MonitorHeatmap dailyData={dailyUptime} days={90} />
        ) : (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>Not enough history yet.</div>
        )}
      </div>

      <div className="pl-section-label">Response time</div>
      <div className="pl-panel" style={{ height: 200, padding: "16px 10px 6px" }}>
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--ink-faint)" }} axisLine={false} tickLine={false} minTickGap={40} />
              <YAxis tick={{ fontSize: 10, fill: "var(--ink-faint)" }} axisLine={false} tickLine={false} unit="ms" width={44} />
              <Tooltip
                contentStyle={{ background: "#0e1512", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "var(--ink-dim)" }}
              />
              <Line type="monotone" dataKey="ms" stroke="#3ddc84" strokeWidth={1.75} dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ color: "var(--ink-dim)", fontSize: 13, textAlign: "center", paddingTop: 70 }}>
            Not enough checks yet to plot a trend.
          </div>
        )}
      </div>

      <div className="pl-section-label">Certificate &amp; domain</div>
      <div className="pl-panel">
        <div className="pl-expiry-row">
          <span className="pl-expiry-row__label">SSL certificate expires</span>
          <span>{monitor.ssl_expires_at ? formatDate(monitor.ssl_expires_at) : "Not checked yet"}</span>
        </div>
        <div className="pl-expiry-row">
          <span className="pl-expiry-row__label">Domain registration expires</span>
          <span>{monitor.domain_expires_at ? formatDate(monitor.domain_expires_at) : "Unknown (best-effort lookup)"}</span>
        </div>
      </div>

      <div className="pl-section-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Security scan</span>
        <button
          type="button"
          className="pl-btn pl-btn--ghost"
          style={{ fontSize: 11, padding: "3px 10px" }}
          onClick={handleRunScan}
          disabled={scanning}
        >
          {scanning ? "Scanning…" : "Rescan now"}
        </button>
      </div>
      <div className="pl-panel">
        {!security ? (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>
            Not scanned yet. Runs automatically once a day, or hit "Rescan now."
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <span
                className={`pl-badge ${
                  security.score >= 90 ? "pl-badge--signal" : security.score >= 70 ? "pl-badge--amber" : "pl-badge--amber"
                }`}
                style={security.score < 70 ? { background: "var(--alert-dim)", color: "var(--alert)" } : undefined}
              >
                {security.score}/100
              </span>
              <span style={{ color: "var(--ink-dim)", fontSize: 12 }}>
                Last scanned {formatDateTime(security.scanned_at)}
              </span>
            </div>
            {security.findings.map((f, i) => (
              <div key={i} className="pl-incident-row" style={{ borderTop: i === 0 ? "none" : undefined }}>
                <div>
                  <div style={{ color: f.pass ? "var(--ink)" : "var(--alert)" }}>{f.check}</div>
                  <div className="pl-incident-row__error">{f.detail}</div>
                </div>
                <div style={{ color: f.pass ? "var(--signal)" : "var(--alert)", fontSize: 12, fontWeight: 600 }}>
                  {f.pass ? "Pass" : "Fail"}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="pl-section-label">Traffic</div>
      <div className="pl-panel">
        <div style={{ display: "flex", gap: 24, marginBottom: traffic?.topPaths?.length ? 16 : 0 }}>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 20 }}>{traffic?.views24h ?? 0}</div>
            <div style={{ color: "var(--ink-dim)", fontSize: 11 }}>visits (24h)</div>
          </div>
        </div>

        {traffic?.topPaths?.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: "var(--ink-dim)", fontSize: 11, marginBottom: 6 }}>Top pages (7d)</div>
            {traffic.topPaths.map((p) => (
              <div key={p.path} className="pl-expiry-row">
                <span className="pl-expiry-row__label" style={{ fontFamily: "var(--font-mono)" }}>{p.path}</span>
                <span>{p.views}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ color: "var(--ink-dim)", fontSize: 11, marginBottom: 6 }}>Embed on this site to start collecting</div>
        <code
          style={{
            display: "block",
            fontFamily: "var(--font-mono)",
            fontSize: 11.5,
            color: "var(--ink-dim)",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid var(--panel-border)",
            borderRadius: 6,
            padding: "8px 10px",
            wordBreak: "break-all",
          }}
        >
          {`<script src="${(import.meta.env.VITE_API_URL || "/api")}/beacon.js" data-site="${monitor.id}"></script>`}
        </code>
        <div style={{ color: "var(--ink-faint)", fontSize: 11, marginTop: 6 }}>
          No cookies, no IP address stored. Just page path, referrer domain, and coarse browser/OS.
        </div>
      </div>

      <div className="pl-section-label">Incident history</div>
      <div className="pl-panel">
        {incidents.length === 0 ? (
          <div style={{ color: "var(--ink-dim)", fontSize: 13 }}>No incidents recorded. That's the goal.</div>
        ) : (
          incidents.map((inc) => (
            <div className="pl-incident-row" key={inc.id}>
              <div>
                <div>{formatDate(inc.started_at)}</div>
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
