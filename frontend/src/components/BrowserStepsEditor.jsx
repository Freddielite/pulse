// Editor for the ordered browser-action list a "browser" monitor runs
// (see backend/src/lib/browserCheck.js for what actually executes these).
// Deliberately a different step shape from SyntheticStepsEditor.jsx: a
// browser action is (selector, value) or (url), not (method, url, body) -
// forcing both into one shared editor would mean half the fields on
// screen never applying to whichever type is active, so this is its own
// small component instead.
import Dropdown from "./Dropdown.jsx";

const ACTIONS = [
  { value: "click", label: "Click" },
  { value: "fill", label: "Fill input" },
  { value: "waitForSelector", label: "Wait for element" },
  { value: "assertVisible", label: "Assert element visible" },
  { value: "assertText", label: "Assert page contains text" },
  { value: "goto", label: "Go to URL" },
  { value: "wait", label: "Wait (ms)" },
];

const NEEDS_SELECTOR = new Set(["click", "fill", "waitForSelector", "assertVisible"]);
const NEEDS_VALUE = new Set(["fill", "assertText", "goto", "wait"]);

function valueLabel(action) {
  if (action === "fill") return "Value to type";
  if (action === "assertText") return "Text that should be on the page";
  if (action === "goto") return "URL";
  if (action === "wait") return "Milliseconds";
  return "Value";
}

export default function BrowserStepsEditor({ steps, onChange }) {
  function updateStep(i, patch) {
    onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function addStep() {
    onChange([...steps, { action: "click", selector: "", value: "" }]);
  }

  function removeStep(i) {
    onChange(steps.filter((_, idx) => idx !== i));
  }

  return (
    <div>
      <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 10 }}>
        The monitor's own URL is loaded first, as a real page in a headless browser. Each step below then runs in
        order against that page - clicks execute, forms submit, JS runs, same as a visitor's browser would.
      </div>
      {steps.map((step, i) => (
        <div key={i} style={{ border: "1px solid var(--panel-border)", borderRadius: 9, padding: 12, marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "var(--ink-dim)", fontWeight: 600 }}>Step {i + 1}</div>
            {steps.length > 1 && (
              <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => removeStep(i)}>Remove</button>
            )}
          </div>

          <div className="pl-field" style={{ marginBottom: 8 }}>
            <label>Action</label>
            <Dropdown value={step.action || "click"} onChange={(v) => updateStep(i, { action: v })} options={ACTIONS} />
          </div>

          {NEEDS_SELECTOR.has(step.action) && (
            <div className="pl-field" style={{ marginBottom: 8 }}>
              <label>CSS selector</label>
              <input
                value={step.selector || ""}
                onChange={(e) => updateStep(i, { selector: e.target.value })}
                placeholder='e.g. #email, button[type="submit"], .dashboard-header'
              />
            </div>
          )}

          {NEEDS_VALUE.has(step.action) && (
            <div className="pl-field" style={{ marginBottom: 0 }}>
              <label>{valueLabel(step.action)}</label>
              <input
                value={step.value || ""}
                onChange={(e) => updateStep(i, { value: e.target.value })}
                placeholder={step.action === "goto" ? "https://example.com/dashboard" : step.action === "wait" ? "1000" : ""}
              />
            </div>
          )}
        </div>
      ))}
      <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={addStep}>+ Add step</button>
    </div>
  );
}
