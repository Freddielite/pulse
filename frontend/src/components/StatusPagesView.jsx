import { useState } from "react";
import { createStatusPage, updateStatusPage, regenerateStatusPage, deleteStatusPage } from "../api.js";
import { createPortal } from "react-dom";
import Dropdown from "./Dropdown.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";

// A combined status page is either group-based (live membership of an
// existing group_name) or manual (a fixed list of monitor ids picked at
// creation time) - never both. This mirrors that choice as a two-option
// dropdown rather than trying to infer intent from which fields are set.
function StatusPageForm({ page, monitors, existingGroups, onClose, onSaved, toast }) {
  const editing = !!page;
  const [name, setName] = useState(page?.name || "");
  const [mode, setMode] = useState(page?.group_name ? "group" : "manual");
  const [groupName, setGroupName] = useState(page?.group_name || existingGroups[0] || "");
  const [monitorIds, setMonitorIds] = useState(new Set(page?.monitor_ids || []));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  function toggleMonitor(id) {
    setMonitorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (mode === "group" && !groupName) {
      setError("Pick a group.");
      return;
    }
    if (mode === "manual" && monitorIds.size === 0) {
      setError("Select at least one monitor.");
      return;
    }
    setBusy(true);
    const payload = {
      name: name.trim(),
      group_name: mode === "group" ? groupName : null,
      monitor_ids: mode === "manual" ? [...monitorIds] : null,
    };
    try {
      if (editing) {
        await updateStatusPage(page.id, payload);
        toast("Status page updated.");
      } else {
        await createStatusPage(payload);
        toast("Status page created.");
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Portal to <body>: this view lives inside .pl-page (the animated
  // page-transition wrapper), and a transform left on that ancestor
  // by the animation would otherwise reposition/clip this fixed
  // overlay - see the identical fix and reasoning in ConfirmDialog.jsx.
  return createPortal(
    <div className="pl-overlay" onClick={onClose}>
      <div className="pl-panel pl-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pl-modal__title">{editing ? "Edit status page" : "New status page"}</div>
        <form onSubmit={handleSubmit}>
          <div className="pl-field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Wyntek clients" required autoFocus />
          </div>
          <div className="pl-field">
            <label>Which monitors</label>
            <Dropdown
              value={mode}
              onChange={setMode}
              options={[
                { value: "group", label: "By group - stays current as the group changes" },
                { value: "manual", label: "Pick monitors manually" },
              ]}
            />
          </div>
          {mode === "group" ? (
            existingGroups.length > 0 ? (
              <div className="pl-field">
                <label>Group</label>
                <Dropdown value={groupName} onChange={setGroupName} options={existingGroups.map((g) => ({ value: g, label: g }))} />
              </div>
            ) : (
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 14 }}>
                No groups yet - set a monitor's "Group" field first, or pick monitors manually instead.
              </div>
            )
          ) : (
            <div className="pl-field">
              <label>Monitors ({monitorIds.size} selected)</label>
              <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: 8 }}>
                {monitors.map((m) => (
                  <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={monitorIds.has(m.id)} onChange={() => toggleMonitor(m.id)} />
                    {m.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {error && <div className="pl-error">{error}</div>}
          <div className="pl-modal__actions">
            <button type="button" className="pl-btn pl-btn--ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="pl-btn" disabled={busy}>{busy ? "Saving..." : "Save"}</button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export default function StatusPagesView({ monitors, existingGroups = [], pages, loading, onReload, toast }) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingPage, setEditingPage] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);

  async function handleCopy(token) {
    const url = `${window.location.origin}${window.location.pathname}#/status/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Copied to clipboard.");
    } catch {
      toast("Couldn't copy automatically - select and copy it manually.", "error");
    }
  }

  async function handleRegenerate(id) {
    setBusyId(id);
    try {
      await regenerateStatusPage(id);
      await onReload();
      toast("Link regenerated - the old one no longer works.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id) {
    setBusyId(id);
    try {
      await deleteStatusPage(id);
      await onReload();
      toast("Status page deleted.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setBusyId(null);
      setConfirmingDeleteId(null);
    }
  }

  if (loading) {
    return (
      <div>
        <div className="pl-dashboard-toolbar" style={{ marginBottom: 14 }}>
          <div className="pl-skeleton" style={{ width: 220, height: 13 }} />
          <div className="pl-skeleton" style={{ width: 120, height: 30 }} />
        </div>
        <div className="pl-panel" style={{ marginBottom: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="pl-skeleton" style={{ width: "40%", height: 14 }} />
          <div className="pl-skeleton" style={{ width: "70%", height: 12 }} />
        </div>
        <div className="pl-panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="pl-skeleton" style={{ width: "35%", height: 14 }} />
          <div className="pl-skeleton" style={{ width: "60%", height: 12 }} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="pl-dashboard-toolbar" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: "var(--ink-faint)", maxWidth: 480 }}>
          One link showing several monitors together - hand a client a single page covering their whole stack
          instead of one per-monitor link each.
        </div>
        <div className="pl-dashboard-actions">
          <button className="pl-btn pl-btn--sm" onClick={() => setFormOpen(true)}>New status page</button>
        </div>
      </div>

      {pages.length === 0 && (
        <div className="pl-panel" style={{ color: "var(--ink-dim)", fontSize: 13 }}>
          No status pages yet.
        </div>
      )}

      {pages.map((page) => {
        const url = `${window.location.origin}${window.location.pathname}#/status/${page.share_token}`;
        const target = page.group_name
          ? `Group: ${page.group_name}`
          : `${(page.monitor_ids || []).length} monitor${(page.monitor_ids || []).length === 1 ? "" : "s"}, manually selected`;
        return (
          <div className="pl-panel" key={page.id} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14.5 }}>{page.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{target}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => setEditingPage(page)}>Edit</button>
                <button className="pl-btn pl-btn--danger pl-btn--sm" onClick={() => setConfirmingDeleteId(page.id)}>Delete</button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <code style={{ fontSize: 12.5, wordBreak: "break-all", flex: 1 }}>{url}</code>
              <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => handleCopy(page.share_token)}>Copy</button>
              <button type="button" className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => handleRegenerate(page.id)} disabled={busyId === page.id}>
                Regenerate
              </button>
            </div>
          </div>
        );
      })}

      {(formOpen || editingPage) && (
        <StatusPageForm
          page={editingPage}
          monitors={monitors}
          existingGroups={existingGroups}
          onClose={() => {
            setFormOpen(false);
            setEditingPage(null);
          }}
          onSaved={() => {
            setFormOpen(false);
            setEditingPage(null);
            onReload();
          }}
          toast={toast}
        />
      )}

      {confirmingDeleteId && (
        <ConfirmDialog
          title="Delete this status page?"
          body="The link will stop working immediately. This doesn't affect the monitors themselves or their individual share links."
          confirmLabel="Delete"
          onConfirm={() => handleDelete(confirmingDeleteId)}
          onCancel={() => setConfirmingDeleteId(null)}
        />
      )}
    </div>
  );
}
