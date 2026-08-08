import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { getMonitorChecks, getMonitorIncidents, getMonitorUptime, getMonitorDailyUptime, deleteMonitor, snoozeMonitor, unsnoozeMonitor } from "../api.js";
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
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [snoozing, setSnoozing] = useState(false);

  const snoozed = !!monitor.snoozed_until && new Date(monitor.snoozed_until).getTime() > Date.now();

  async function load() {
    const [c, i, u, d] = await Promise.all([
      getMonitorChecks(monitor.id),
      getMonitorIncidents(monitor.id),
      getMonitorUptime(monitor.id),
      getMonitorDailyUptime(monitor.id),
    ]);
    setChecks(c);
    setIncidents(i);
    setUptime(u);
    setDailyUptime(d);
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
