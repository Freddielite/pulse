// Editor for the ordered request list a synthetic monitor runs (see
// backend/src/lib/syntheticCheck.js for what actually executes these).
// Kept intentionally plain: method/URL/body/expected-status/body-contains
// per step, plus one optional "save a value from this response" extract -
// no per-step custom headers in this UI. Anything needing per-step auth
// beyond the monitor's single auth header (applied to every step) or a
// captured {{var}} isn't served by this editor; it's a scope line drawn
// to keep the form usable rather than a mini HTTP client.
import Dropdown from "./Dropdown.jsx";

export default function SyntheticStepsEditor({ steps, onChange }) {
  function updateStep(i, patch) {
    onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function updateExtract(i, patch) {
    const step = steps[i];
    const extract = { name: step.extract?.name || "", regex: step.extract?.regex || "", ...patch };
    updateStep(i, { extract: extract.name.trim() || extract.regex.trim() ? extract : null });
  }

  function addStep() {
    onChange([...steps, { method: "GET", url: "", expected_status: 200, body: "", body_contains: "", extract: null }]);
  }

  function removeStep(i) {
    onChange(steps.filter((_, idx) => idx !== i));
  }

  return (
    <div>
      {steps.map((step, i) => (
        <div key={i} style={{ border: "1px solid var(--panel-border)", borderRadius: 9, padding: 12, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "var(--ink-dim)", fontWeight: 600 }}>Step {i + 1}</div>
            {steps.length > 1 && (
              <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => removeStep(i)}>Remove</button>
            )}
          </div>

          <div className="pl-field-row">
            <div className="pl-field" style={{ marginBottom: 8 }}>
              <label>Method</label>
              <Dropdown
                value={step.method || "GET"}
                onChange={(v) => updateStep(i, { method: v })}
                options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))}
              />
            </div>
            <div className="pl-field" style={{ marginBottom: 8 }}>
              <label>Expected status</label>
              <input type="number" value={step.expected_status || 200} onChange={(e) => updateStep(i, { expected_status: Number(e.target.value) })} />
            </div>
          </div>

          <div className="pl-field" style={{ marginBottom: 8 }}>
            <label>URL</label>
            <input
              value={step.url || ""}
              onChange={(e) => updateStep(i, { url: e.target.value })}
              placeholder={i === 0 ? "https://example.com/login" : "https://example.com/dashboard - or use {{varName}} from an earlier step"}
            />
          </div>

          {(step.method || "GET") !== "GET" && (
            <div className="pl-field" style={{ marginBottom: 8 }}>
              <label>Request body (optional)</label>
              <textarea
                rows={2}
                value={step.body || ""}
                onChange={(e) => updateStep(i, { body: e.target.value })}
                placeholder='e.g. {"email":"you@example.com","password":"..."}'
              />
            </div>
          )}

          <div className="pl-field" style={{ marginBottom: 8 }}>
            <label>Response should contain (optional)</label>
            <input
              value={step.body_contains || ""}
              onChange={(e) => updateStep(i, { body_contains: e.target.value })}
              placeholder='e.g. "Welcome back"'
            />
          </div>

          <div className="pl-field-row">
            <div className="pl-field" style={{ marginBottom: 0 }}>
              <label>Save a value for later steps (optional)</label>
              <input
                value={step.extract?.name || ""}
                onChange={(e) => updateExtract(i, { name: e.target.value })}
                placeholder="variable name, e.g. token"
              />
            </div>
            <div className="pl-field" style={{ marginBottom: 0 }}>
              <label>...matching this regex (group 1)</label>
              <input
                value={step.extract?.regex || ""}
                onChange={(e) => updateExtract(i, { regex: e.target.value })}
                placeholder='e.g. "token":"([^"]+)"'
              />
            </div>
          </div>
        </div>
      ))}
      <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={addStep}>+ Add step</button>
    </div>
  );
}
