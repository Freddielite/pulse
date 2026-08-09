export default function ConfirmDialog({ title, body, confirmLabel = "Confirm", danger, onConfirm, onCancel }) {
  return (
    <div className="pl-overlay" onClick={onCancel}>
      <div className="pl-panel pl-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 380 }}>
        <div className="pl-modal__title">{title}</div>
        <div style={{ fontSize: 13.5, color: "var(--ink-dim)" }}>{body}</div>
        <div className="pl-modal__actions">
          <button className="pl-btn pl-btn--ghost" onClick={onCancel}>Cancel</button>
          <button className={`pl-btn ${danger ? "pl-btn--danger" : ""}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
