import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { generateShareToken } from "../lib/shareLinks.js";
import { requireOrgRole } from "../lib/orgAccess.js";
import { verifyCustomDomain, registerDomainWithVercel } from "../lib/customDomain.js";

const router = Router();
router.use(requireAuth);

// Same broadened access as monitors.js: a user can select any monitor
// they personally own, or any monitor owned by an org they belong to -
// not just monitors owned by whichever org the status page itself is
// tagged with, since a page mixing a couple of personal monitors with a
// team's is a completely reasonable thing to want.
async function validateSelection(userId, groupName, monitorIds) {
  const hasGroup = !!groupName?.trim();
  const hasManual = Array.isArray(monitorIds) && monitorIds.length > 0;
  if (hasGroup === hasManual) {
    return "pick either a group or a manual list of monitors, not both or neither";
  }
  if (hasManual) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n FROM monitors
       WHERE id = ANY($1::uuid[])
         AND (user_id = $2 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $2))`,
      [monitorIds, userId]
    );
    if (Number(rows[0].n) !== monitorIds.length) {
      return "one or more selected monitors don't exist or aren't yours";
    }
  }
  return null;
}

router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM status_pages
     WHERE user_id = $1 OR organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = $1)
     ORDER BY created_at ASC`,
    [req.userId]
  );
  res.json(rows);
});

router.post("/", async (req, res) => {
  const { name, group_name, monitor_ids, organization_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const selectionError = await validateSelection(req.userId, group_name, monitor_ids);
  if (selectionError) return res.status(400).json({ error: selectionError });
  // Same admin+ gate as tagging a monitor to an org at creation - a
  // status page under an org's name is a branding decision, not a
  // view-only one.
  if (organization_id) {
    const allowed = await requireOrgRole(req.userId, organization_id, "admin");
    if (!allowed) return res.status(403).json({ error: "you need admin access on that organization to create a status page for it" });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO status_pages (user_id, name, share_token, group_name, monitor_ids, organization_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        req.userId,
        name.trim(),
        generateShareToken(),
        group_name?.trim() || null,
        monitor_ids?.length ? JSON.stringify(monitor_ids) : null,
        organization_id || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create status page" });
  }
});

// Gate for every route that changes a status page rather than just
// reading it - same model as loadMonitorForMutation in monitors.js: the
// page's own creator can always manage it, otherwise only admin+ on the
// org that owns it.
async function loadStatusPageForMutation(req, res) {
  const { rows } = await pool.query(`SELECT * FROM status_pages WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) {
    res.status(404).json({ error: "status page not found" });
    return null;
  }
  const page = rows[0];
  const isCreator = page.user_id === req.userId;
  const isOrgAdmin = page.organization_id && (await requireOrgRole(req.userId, page.organization_id, "admin"));
  if (!isCreator && !isOrgAdmin) {
    res.status(403).json({ error: "admin access on this status page's organization is required for that" });
    return null;
  }
  return page;
}

router.patch("/:id", async (req, res) => {
  const page = await loadStatusPageForMutation(req, res);
  if (!page) return;
  const { name, group_name, monitor_ids, organization_id, custom_domain } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const selectionError = await validateSelection(req.userId, group_name, monitor_ids);
  if (selectionError) return res.status(400).json({ error: selectionError });
  // Same narrower rule as monitors.js's identical reassignment gate:
  // only the page's own creator can move it between personal and
  // organization ownership at all, regardless of how broad
  // loadStatusPageForMutation's own edit access is - an org admin who
  // didn't create this particular page can edit its monitor list, but
  // can't reassign it away from wherever its creator put it.
  if (organization_id !== undefined) {
    if (page.user_id !== req.userId) {
      return res.status(403).json({ error: "only the status page's creator can move it between personal and organization ownership" });
    }
    if (organization_id) {
      const allowed = await requireOrgRole(req.userId, organization_id, "admin");
      if (!allowed) return res.status(403).json({ error: "you need admin access on that organization to move status pages into it" });
    }
  }
  const normalizedDomain = custom_domain === undefined ? undefined : custom_domain?.trim().toLowerCase().replace(/^https?:\/\//, "") || null;
  if (normalizedDomain && /[\s/]/.test(normalizedDomain)) {
    return res.status(400).json({ error: "custom domain should be just the hostname, e.g. status.example.com" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE status_pages SET
         name = $2,
         group_name = $3,
         monitor_ids = $4,
         -- Explicit-clear-is-valid, same pattern as monitors.js's own
         -- organization_id handling: NULL genuinely means "make this
         -- personal," which a plain COALESCE could never tell apart from
         -- "field wasn't sent."
         organization_id = CASE WHEN $5 THEN $6 ELSE organization_id END,
         custom_domain = CASE WHEN $7 THEN $8 ELSE custom_domain END,
         -- A changed domain string was never verified - whatever passed
         -- before was for the OLD value. Only cleared when the domain
         -- actually changes, not on every save of an unrelated field.
         custom_domain_verified_at = CASE WHEN $7 AND $8 IS DISTINCT FROM custom_domain THEN NULL ELSE custom_domain_verified_at END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        name.trim(),
        group_name?.trim() || null,
        monitor_ids?.length ? JSON.stringify(monitor_ids) : null,
        organization_id !== undefined,
        organization_id || null,
        normalizedDomain !== undefined,
        normalizedDomain,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "that domain is already in use by another status page" });
    console.error(err);
    res.status(500).json({ error: "failed to update status page" });
  }
});

// Checks the domain's DNS and, if it checks out, auto-registers it with
// Vercel when credentials are configured (see lib/customDomain.js for
// both halves of that). Doesn't require custom_domain to have just been
// set - re-running this later (DNS was still propagating, or someone
// wants to confirm nothing's broken) is exactly what it's for too.
router.post("/:id/verify-domain", async (req, res) => {
  const page = await loadStatusPageForMutation(req, res);
  if (!page) return;
  if (!page.custom_domain) return res.status(400).json({ error: "no custom domain set on this status page yet" });

  const result = await verifyCustomDomain(page.custom_domain);
  if (!result.verified) {
    return res.json({ verified: false, reason: result.reason });
  }

  await pool.query(`UPDATE status_pages SET custom_domain_verified_at = now() WHERE id = $1`, [page.id]);
  const vercel = await registerDomainWithVercel(page.custom_domain);
  res.json({ verified: true, vercel });
});

// Same reasoning as monitors' /share/regenerate: swap the token in the
// same write, so the old link stops resolving the instant the new one
// exists rather than both being live for any window.
router.post("/:id/regenerate", async (req, res) => {
  const page = await loadStatusPageForMutation(req, res);
  if (!page) return;
  const { rows } = await pool.query(
    `UPDATE status_pages SET share_token = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id, generateShareToken()]
  );
  res.json(rows[0]);
});

router.delete("/:id", async (req, res) => {
  const page = await loadStatusPageForMutation(req, res);
  if (!page) return;
  await pool.query(`DELETE FROM status_pages WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

export default router;
