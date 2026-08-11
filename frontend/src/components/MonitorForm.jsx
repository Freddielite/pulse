import { useState } from "react";
import { createMonitor, updateMonitor } from "../api.js";
import SyntheticStepsEditor from "./SyntheticStepsEditor.jsx";
import Dropdown from "./Dropdown.jsx";

const DEFAULT_STEP = { method: "GET", url: "", expected_status: 200, body: "", body_contains: "", extract: null };

export default function MonitorForm({ monitor, existingGroups = [], onClose, onSaved, toast }) {
  const editing = !!monitor;
  const [name, setName] = useState(monitor?.name || "");
  const [url, setUrl] = useState(monitor?.url || "");
  const [monitorType, setMonitorType] = useState(monitor?.monitor_type === "synthetic" ? "synthetic" : "http");
  const [steps, setSteps] = useState(monitor?.synthetic_steps?.length ? monitor.synthetic_steps : [DEFAULT_STEP]);
  const [method, setMethod] = useState(monitor?.method || "GET");
  const [expectedStatus, setExpectedStatus] = useState(monitor?.expected_status || 200);
  const [interval, setInterval] = useState(monitor?.check_interval_min || 5);
  const [authHeaderName, setAuthHeaderName] = useState(monitor?.auth_header_name || "");
  const [authHeaderValue, setAuthHeaderValue] = useState(monitor?.auth_header_value || "");
  const [keepAlive, setKeepAlive] = useState(monitor?.keep_alive_target || false);
  const [groupName, setGroupName] = useState(monitor?.group_name || "");
  const [bodyContains, setBodyContains] = useState(monitor?.body_contains || "");
  const [alertAfterFailures, setAlertAfterFailures] = useState(monitor?.alert_after_failures || 1);
  const [contentDiffEnabled, setContentDiffEnabled] = useState(monitor?.content_diff_enabled || false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (monitorType === "synthetic" && steps.some((s) => !s.url?.trim())) {
      setError("Every step needs a URL.");
      return;
    }
    setBusy(true);
    const payload = {
      name: name.trim(),
      url: url.trim(),
      monitor_type: monitorType,
      synthetic_steps: monitorType === "synthetic" ? steps : undefined,
      method,
      expected_status: Number(expectedStatus),
      check_interval_min: Number(interval),
      auth_header_name: authHeaderName.trim() || null,
      auth_header_value: authHeaderValue.trim() || null,
      keep_alive_target: keepAlive,
      group_name: groupName.trim() || null,
      body_contains: bodyContains.trim() || null,
      alert_after_failures: Number(alertAfterFailures) || 1,
      content_diff_enabled: monitorType === "http" ? contentDiffEnabled : false,
    };
    try {
      if (editing) {
        await updateMonitor(monitor.id, payload);
        toast("Monitor updated.");
      } else {
        await createMonitor(payload);
        toast("Monitor added.");
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pl-overlay" onClick={onClose}>
      <div className="pl-panel pl-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pl-modal__title">{editing ? "Edit monitor" : "Add a monitor"}</div>
        <form onSubmit={handleSubmit}>
          <div className="pl-field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Wyntek API" required autoFocus />
          </div>
          <div className="pl-field">
            <label>URL{monitorType === "synthetic" ? " (for the SSL/domain check and the list - not itself one of the steps below)" : ""}</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/health" required />
          </div>
          <div className="pl-field">
            <label>Check type</label>
            <Dropdown
              value={monitorType}
              onChange={setMonitorType}
              options={[
                { value: "http", label: "Single request" },
                { value: "synthetic", label: "Multi-step (login flow, multi-hop API check)" },
              ]}
            />
            {monitorType === "synthetic" && (
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                Runs each step as a plain HTTP request in order, carrying cookies forward - no JS execution, so it
                won't catch a page that loads but is broken client-side, but it will catch a login-gated flow that
                stops returning what you expect partway through.
              </div>
            )}
          </div>
          {monitorType === "http" ? (
            <div className="pl-field-row">
              <div className="pl-field">
                <label>Method</label>
                <Dropdown
                  value={method}
                  onChange={setMethod}
                  options={[
                    { value: "GET", label: "GET" },
                    { value: "HEAD", label: "HEAD" },
                    { value: "POST", label: "POST" },
                  ]}
                />
              </div>
              <div className="pl-field">
                <label>Expected status</label>
                <input type="number" value={expectedStatus} onChange={(e) => setExpectedStatus(e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="pl-field">
              <label>Steps</label>
              <SyntheticStepsEditor steps={steps} onChange={setSteps} />
            </div>
          )}
          <div className="pl-field">
            <label>Check interval (minutes)</label>
            <input type="number" min={1} value={interval} onChange={(e) => setInterval(e.target.value)} />
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
              This is a minimum spacing, not a guarantee: actual checks can never happen faster than your external cron job calls /api/cron/tick.
            </div>
            {keepAlive && Number(interval) > 10 && (
              <div style={{ fontSize: 11.5, color: "var(--amber)" }}>
                Render free-tier apps sleep after 15 minutes idle. An interval this long may not keep it awake.
              </div>
            )}
          </div>
          <div className="pl-field-row">
            <div className="pl-field">
              <label>Auth header name (optional)</label>
              <input value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} placeholder="Authorization" />
            </div>
            <div className="pl-field">
              <label>Auth header value (optional)</label>
              <input value={authHeaderValue} onChange={(e) => setAuthHeaderValue(e.target.value)} placeholder="Bearer ..." />
            </div>
          </div>
          <div className="pl-field">
            <label>Group (optional)</label>
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="e.g. Wyntek clients, Personal"
              list="pulse-group-suggestions"
            />
            <datalist id="pulse-group-suggestions">
              {existingGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
          {monitorType === "http" && (
            <div className="pl-field">
              <label>Response should contain (optional)</label>
              <input
                value={bodyContains}
                onChange={(e) => setBodyContains(e.target.value)}
                placeholder='e.g. "ok" or a version string'
              />
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                Fails the check if a 200 response doesn't actually contain this text.
              </div>
            </div>
          )}
          <div className="pl-field">
            <label>Alert after this many consecutive failures</label>
            <input
              type="number"
              min={1}
              value={alertAfterFailures}
              onChange={(e) => setAlertAfterFailures(e.target.value)}
            />
            <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
              Default of 1 alerts on the first failed check (after its own automatic retry). Raise this to ride out
              flaky connections that fail a check or two before recovering on their own.
            </div>
          </div>
          <div className="pl-toggle-row">
            <span>This is a Render free-tier app I want to keep awake</span>
            <button type="button" className={`pl-toggle ${keepAlive ? "on" : ""}`} onClick={() => setKeepAlive(!keepAlive)}>
              <span className="pl-toggle__knob" />
            </button>
          </div>
          {monitorType === "http" && (
            <div className="pl-toggle-row">
              <div>
                <span>Alert me if this page's content changes unexpectedly</span>
                <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginTop: 2 }}>
                  Hashes the response body each check. A change fires one alert and becomes the new baseline - a
                  deploy earns a single nudge, not a repeat alert on every check after.
                </div>
              </div>
              <button
                type="button"
                className={`pl-toggle ${contentDiffEnabled ? "on" : ""}`}
                onClick={() => setContentDiffEnabled(!contentDiffEnabled)}
              >
                <span className="pl-toggle__knob" />
              </button>
            </div>
          )}
          {error && <div className="pl-error">{error}</div>}
          <div className="pl-modal__actions">
            <button type="button" className="pl-btn pl-btn--ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="pl-btn" disabled={busy}>{busy ? "Saving..." : "Save"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
