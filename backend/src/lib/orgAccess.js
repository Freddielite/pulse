// Membership and role helpers for organizations - the shared-ownership
// layer that sits alongside (not instead of) the original single-user
// model. A monitor or status page with organization_id NULL is exactly
// as personal as it always was; these helpers only come into play once
// something has an organization_id set.
//
// Role model, deliberately just three: 'owner' (can rename/brand/delete
// the org, change anyone's role, always at least one per org),
// 'admin' (can invite/remove members, create monitors under the org),
// 'member' (can see and use what the org owns). See the note in
// HANDOVER.md about the one place role isn't yet enforced: editing or
// deleting an org's existing monitors is currently open to any member,
// not gated to admin+, to keep this change's surface area contained.

import { pool } from "../db.js";

const ROLE_RANK = { member: 0, admin: 1, owner: 2 };

export function roleAtLeast(role, minimum) {
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[minimum] ?? 99);
}

// A user's accepted (not pending-invite) memberships, with role.
export async function getUserOrgRole(userId, organizationId) {
  const { rows } = await pool.query(
    `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId]
  );
  return rows[0]?.role || null;
}

export async function requireOrgRole(userId, organizationId, minimum) {
  const role = await getUserOrgRole(userId, organizationId);
  return role !== null && roleAtLeast(role, minimum);
}

export async function logOrgAction(organizationId, actorUserId, action, detail = null) {
  await pool.query(
    `INSERT INTO org_audit_log (organization_id, actor_user_id, action, detail) VALUES ($1, $2, $3, $4)`,
    [organizationId, actorUserId, action, detail]
  );
}

// Every account, user or org, that a given monitor should notify: just
// the owner for a personal monitor (the original, only behavior before
// this feature existed), or every accepted member of the owning org.
// Every alert call site in checkRunner.js/securityEvents.js/digest.js
// goes through this instead of `SELECT * FROM users WHERE id = monitor.user_id`
// directly, so "the team gets paged, not just whoever happened to
// create the monitor" only had to be taught to this one function.
export async function getNotifiableUsers(monitor) {
  if (monitor.organization_id) {
    const { rows } = await pool.query(
      `SELECT u.* FROM organization_members om
       JOIN users u ON u.id = om.user_id
       WHERE om.organization_id = $1 AND om.user_id IS NOT NULL`,
      [monitor.organization_id]
    );
    // A monitor moved into an org that (edge case) currently has no
    // accepted members yet - shouldn't happen since creating an org
    // always seeds the owner as a member, but falling back to the
    // creator rather than silently notifying nobody is the safer
    // failure mode.
    if (rows.length > 0) return rows;
  }
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [monitor.user_id]);
  return rows;
}

// Claims any pending invites (organization_members rows with user_id
// NULL) that were sent to this email, at the moment the account behind
// that email is created. Called once, right after signup - an invite
// sent before someone had ever signed up still resolves into real
// membership without the inviter needing to do anything twice.
export async function claimPendingInvites(userId, email) {
  await pool.query(
    `UPDATE organization_members SET user_id = $1, invited_email = NULL
     WHERE invited_email = $2 AND user_id IS NULL`,
    [userId, email]
  );
}
