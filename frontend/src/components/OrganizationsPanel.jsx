import { useEffect, useState } from "react";
import {
  listOrganizations,
  createOrganization,
  getOrganization,
  updateOrganization,
  deleteOrganization,
  inviteOrgMember,
  updateOrgMemberRole,
  removeOrgMember,
} from "../api.js";
import ConfirmDialog from "./ConfirmDialog.jsx";
import Dropdown from "./Dropdown.jsx";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" };

// One org's expanded management view - members, pending invites,
// branding, and a recent audit log slice. Fetched lazily (only once
// this org is expanded) since the list view alone doesn't need any of
// this detail.
function OrgDetail({ orgId, myRole, onChanged, toast }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [brandName, setBrandName] = useState("");
  const [brandLogoUrl, setBrandLogoUrl] = useState("");
  const [brandAccentColor, setBrandAccentColor] = useState("");
  const [customDomain, setCustomDomain] = useState("");
  const [savingBrand, setSavingBrand] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showAuditLog, setShowAuditLog] = useState(false);

  const canManage = myRole === "owner" || myRole === "admin";
  const isOwner = myRole === "owner";

  async function load() {
    setLoading(true);
    try {
      const result = await getOrganization(orgId);
      setDetail(result);
      setBrandName(result.brand_name || "");
      setBrandLogoUrl(result.brand_logo_url || "");
      setBrandAccentColor(result.brand_accent_color || "");
      setCustomDomain(result.custom_domain || "");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function handleInvite(e) {
    e.preventDefault();
    setInviteBusy(true);
    try {
      await inviteOrgMember(orgId, inviteEmail.trim(), inviteRole);
      setInviteEmail("");
      toast("Invite sent.");
      await load();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRoleChange(memberId, role) {
    try {
      await updateOrgMemberRole(orgId, memberId, role);
      await load();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function handleRemove(memberId) {
    try {
      await removeOrgMember(orgId, memberId);
      toast("Removed.");
      await load();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function handleSaveBranding(e) {
    e.preventDefault();
    setSavingBrand(true);
    try {
      await updateOrganization(orgId, {
        brand_name: brandName.trim(),
        brand_logo_url: brandLogoUrl.trim(),
        brand_accent_color: brandAccentColor.trim(),
        custom_domain: customDomain.trim(),
      });
      toast("Branding saved.");
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setSavingBrand(false);
    }
  }

  async function handleDelete() {
    try {
      await deleteOrganization(orgId);
      toast("Organization deleted. Its monitors and status pages are now personal again.");
      onChanged();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  if (loading) return <div style={{ padding: 12, fontSize: 12.5, color: "var(--ink-dim)" }}>Loading...</div>;
  if (!detail) return null;

  return (
    <div style={{ paddingTop: 12, borderTop: "1px solid var(--panel-border)", marginTop: 12, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div className="pl-settings-row__title" style={{ marginBottom: 8 }}>Members</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {detail.members.map((m) => (
            <div key={m.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
              <span>{m.email}</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {isOwner && m.role !== "owner" ? (
                  <div style={{ width: 116 }}>
                    <Dropdown
                      value={m.role}
                      onChange={(role) => handleRoleChange(m.id, role)}
                      options={[
                        { value: "member", label: "Member" },
                        { value: "admin", label: "Admin" },
                        { value: "owner", label: "Owner" },
                      ]}
                    />
                  </div>
                ) : (
                  <span style={{ color: "var(--ink-dim)", fontSize: 12 }}>{ROLE_LABEL[m.role]}</span>
                )}
                {canManage && (
                  <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => handleRemove(m.id)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
          {detail.pending_invites.map((inv) => (
            <div key={inv.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, color: "var(--ink-dim)" }}>
              <span>{inv.invited_email} (invited, not yet joined)</span>
              {canManage && (
                <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => handleRemove(inv.id)}>
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {canManage && (
        <form onSubmit={handleInvite} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <div className="pl-field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Invite by email</label>
            <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
          </div>
          <div style={{ width: 130 }}>
            <Dropdown
              value={inviteRole}
              onChange={setInviteRole}
              options={[
                { value: "member", label: "Member" },
                { value: "admin", label: "Admin" },
              ]}
            />
          </div>
          <button className="pl-btn pl-btn--sm" type="submit" disabled={inviteBusy}>
            {inviteBusy ? "Sending..." : "Invite"}
          </button>
        </form>
      )}

      {canManage && (
        <form onSubmit={handleSaveBranding} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="pl-settings-row__title">White-label branding</div>
          <div className="pl-settings-row__desc" style={{ marginTop: -4 }}>
            Applied to this org's shared status pages and monitor links. A custom domain still needs a CNAME
            pointed at Pulse on your end - this field is a reminder of what to set up, not an automatic redirect.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div className="pl-field" style={{ marginBottom: 0 }}>
              <label>Brand name</label>
              <input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="Acme Client Reports" />
            </div>
            <div className="pl-field" style={{ marginBottom: 0 }}>
              <label>Accent color</label>
              <input value={brandAccentColor} onChange={(e) => setBrandAccentColor(e.target.value)} placeholder="#3ddc84" />
            </div>
            <div className="pl-field" style={{ marginBottom: 0 }}>
              <label>Logo URL</label>
              <input value={brandLogoUrl} onChange={(e) => setBrandLogoUrl(e.target.value)} placeholder="https://..." />
            </div>
            <div className="pl-field" style={{ marginBottom: 0 }}>
              <label>Custom domain</label>
              <input value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="status.acme.com" />
            </div>
          </div>
          <button className="pl-btn pl-btn--sm" type="submit" disabled={savingBrand} style={{ alignSelf: "flex-start" }}>
            {savingBrand ? "Saving..." : "Save branding"}
          </button>
        </form>
      )}

      <div>
        <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => setShowAuditLog((v) => !v)}>
          {showAuditLog ? "Hide" : "Show"} audit log
        </button>
        {showAuditLog && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--ink-dim)" }}>
            {detail.audit_log.length === 0 && <div>Nothing logged yet.</div>}
            {detail.audit_log.map((entry) => (
              <div key={entry.id}>
                {new Date(entry.created_at).toLocaleString()} - {entry.actor_email || "someone"} {entry.action.replace(/_/g, " ")}
                {entry.detail ? ` (${entry.detail})` : ""}
              </div>
            ))}
          </div>
        )}
      </div>

      {isOwner && (
        <div>
          <button className="pl-btn pl-btn--ghost pl-btn--sm" onClick={() => setConfirmingDelete(true)}>
            Delete organization
          </button>
          {confirmingDelete && (
            <ConfirmDialog
              title="Delete this organization?"
              body="Its monitors and status pages aren't deleted - they become personal to whoever created each one. Membership and the audit log are gone for good."
              confirmLabel="Delete organization"
              onConfirm={handleDelete}
              onCancel={() => setConfirmingDelete(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default function OrganizationsPanel({ toast }) {
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [newOrgName, setNewOrgName] = useState("");
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const result = await listOrganizations();
      setOrgs(result);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    try {
      const org = await createOrganization(newOrgName.trim());
      setNewOrgName("");
      await load();
      setExpandedId(org.id);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="pl-panel">
      <div className="pl-settings-row__desc" style={{ marginBottom: 12 }}>
        Share monitors and status pages with a team. Everyone in an organization gets paged for its monitors, not
        just whoever created them.
      </div>

      {!loading && orgs.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--ink-dim)", marginBottom: 12 }}>No organizations yet.</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
        {orgs.map((org) => (
          <div key={org.id} style={{ borderRadius: 8, background: "var(--bg)", padding: 10 }}>
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
              onClick={() => setExpandedId((id) => (id === org.id ? null : org.id))}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{org.name}</div>
                <div style={{ fontSize: 11.5, color: "var(--ink-dim)" }}>
                  {ROLE_LABEL[org.role]} - {org.member_count} member{Number(org.member_count) === 1 ? "" : "s"}
                </div>
              </div>
              <span style={{ fontSize: 12, color: "var(--ink-dim)" }}>{expandedId === org.id ? "Hide" : "Manage"}</span>
            </div>
            {expandedId === org.id && <OrgDetail orgId={org.id} myRole={org.role} onChanged={load} toast={toast} />}
          </div>
        ))}
      </div>

      <form onSubmit={handleCreate} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div className="pl-field" style={{ flex: 1, marginBottom: 0 }}>
          <label>New organization name</label>
          <input value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} placeholder="Acme Agency" required />
        </div>
        <button className="pl-btn pl-btn--sm" type="submit" disabled={creating}>
          {creating ? "Creating..." : "Create"}
        </button>
      </form>
    </div>
  );
}
