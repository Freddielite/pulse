import { createPortal } from "react-dom";

// Rendered via a portal straight to <body> rather than in place: this
// is a position:fixed overlay, and several places that use it (e.g.
// MonitorDetail) sit inside .pl-page, which applies a CSS transform
// for the page-transition animation. Any transform on an ancestor -
// even a finished one left behind by animation-fill-mode - creates a
// new containing block, which would reposition/clip a fixed overlay
// relative to that ancestor instead of the actual viewport. A portal
// sidesteps the whole problem regardless of where this gets used.
export default function ConfirmDialog({ title, body, confirmLabel = "Confirm", danger, onConfirm, onCancel }) {
  return createPortal(
    <div className="pl-overlay" onClick={onCancel}>
      <div className="pl-panel pl-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
        <div className="pl-modal__title">{title}</div>
        <div style={{ fontSize: 13.5, color: "var(--ink-dim)" }}>{body}</div>
        <div className="pl-modal__actions">
          <button className="pl-btn pl-btn--ghost" onClick={onCancel}>Cancel</button>
          <button className={`pl-btn ${danger ? "pl-btn--danger" : ""}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
