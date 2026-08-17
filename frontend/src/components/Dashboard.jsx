import { useState } from "react";
import MonitorCard from "./MonitorCard.jsx";
import MonitorCardSkeleton from "./MonitorCardSkeleton.jsx";
import { checkNow, snoozeAllMonitors, unsnoozeAllMonitors } from "../api.js";

const SNOOZE_OPTIONS = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "4h", minutes: 240 },
  { label: "24h", minutes: 1440 },
];

export default function Dashboard({ monitors, loading, onSelect, onAdd, onChanged, toast }) {
  const [checking, setChecking] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const upCount = monitors.filter((m) => m.current_status === "up").length;
  const downCount = monitors.filter((m) => m.current_status === "down").length;
  const anySnoozed = monitors.some((m) => m.snoozed_until && new Date(m.snoozed_until).getTime() > Date.now());

  async function handleCheckNow() {
    setChecking(true);
    try {
      const result = await checkNow();
      toast(`Checked ${result.checked} monitor${result.checked === 1 ? "" : "s"}.`);
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setChecking(false);
    }
  }

  async function handleSnoozeAll(minutes) {
    setSnoozing(true);
    try {
      const result = await snoozeAllMonitors(minutes);
      toast(`Snoozed ${result.snoozed} monitor${result.snoozed === 1 ? "" : "s"}.`);
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSnoozing(false);
    }
  }

  async function handleUnsnoozeAll() {
    setSnoozing(true);
    try {
      const result = await unsnoozeAllMonitors();
      toast(`Unsnoozed ${result.unsnoozed} monitor${result.unsnoozed === 1 ? "" : "s"}.`);
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSnoozing(false);
    }
  }

  return (
    <div>
      <div className="pl-panel pl-dashboard-toolbar">
        <div className="pl-dashboard-stats">
          {loading ? (
            <>
              <div className="pl-skeleton" style={{ width: 60, height: 34 }} />
              <div className="pl-skeleton" style={{ width: 60, height: 34 }} />
              <div className="pl-skeleton" style={{ width: 60, height: 34 }} />
            </>
          ) : (
            <>
              <div>
                <div className="pl-stat__value" style={{ fontSize: 20 }}>{monitors.length}</div>
                <div className="pl-stat__label">Monitoring</div>
              </div>
              <div>
                <div className="pl-stat__value" style={{ fontSize: 20, color: downCount > 0 ? "var(--alert)" : "inherit" }}>{downCount}</div>
                <div className="pl-stat__label">Down now</div>
              </div>
              <div>
                <div className="pl-stat__value" style={{ fontSize: 20, color: "var(--signal)" }}>{upCount}</div>
                <div className="pl-stat__label">Up now</div>
              </div>
            </>
          )}
        </div>
        <div className="pl-dashboard-actions">
          <button className="pl-btn pl-btn--ghost" onClick={handleCheckNow} disabled={checking || monitors.length === 0}>
            {checking ? "Checking..." : "Check now"}
          </button>
          <button className="pl-btn" onClick={onAdd}>Add monitor</button>
        </div>
      </div>

      {monitors.length > 0 && (
        <div className="pl-panel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
          {anySnoozed ? (
            <>
              <span style={{ fontSize: 13, color: "var(--ink-dim)" }}>Some monitors are snoozed.</span>
              <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={handleUnsnoozeAll} disabled={snoozing}>Unsnooze all</button>
            </>
          ) : (
            <>
              <span style={{ fontSize: 13, color: "var(--ink-dim)" }}>Snooze all monitors</span>
              <div style={{ display: "flex", gap: 6 }}>
                {SNOOZE_OPTIONS.map((opt) => (
                  <button key={opt.minutes} className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => handleSnoozeAll(opt.minutes)} disabled={snoozing}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {monitors.length === 0 ? (
        loading ? (
          <div className="pl-monitor-grid">
            <MonitorCardSkeleton />
            <MonitorCardSkeleton />
            <MonitorCardSkeleton />
          </div>
        ) : (
          <div className="pl-panel pl-empty">
            <div className="pl-empty__title">Nothing being watched yet</div>
            <div>Add the first app or API you want kept alive and alerted on.</div>
          </div>
        )
      ) : (
        <GroupedMonitorList monitors={monitors} onSelect={onSelect} />
      )}
    </div>
  );
}

// Only bothers grouping when there's actually more than one group present.
// A single flat list is simpler to scan than a UI with one lonely group
// header on it, so that case renders exactly like it always did.
function GroupedMonitorList({ monitors, onSelect }) {
  const groupNames = [...new Set(monitors.map((m) => m.group_name).filter(Boolean))].sort();
  if (groupNames.length === 0) {
    return (
      <div className="pl-monitor-grid">
        {monitors.map((m) => (
          <MonitorCard key={m.id} monitor={m} onClick={() => onSelect(m)} />
        ))}
      </div>
    );
  }

  const ungrouped = monitors.filter((m) => !m.group_name);
  return (
    <div>
      {ungrouped.length > 0 && (
        <div className="pl-monitor-grid" style={{ marginBottom: 20 }}>
          {ungrouped.map((m) => (
            <MonitorCard key={m.id} monitor={m} onClick={() => onSelect(m)} />
          ))}
        </div>
      )}
      {groupNames.map((group) => (
        <div key={group} style={{ marginBottom: 20 }}>
          <div className="pl-section-label" style={{ margin: "0 0 10px" }}>{group}</div>
          <div className="pl-monitor-grid">
            {monitors
              .filter((m) => m.group_name === group)
              .map((m) => (
                <MonitorCard key={m.id} monitor={m} onClick={() => onSelect(m)} />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
