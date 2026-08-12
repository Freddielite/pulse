import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { generateShareToken } from "../lib/shareLinks.js";

const router = Router();
router.use(requireAuth);

// Shared by create and update: exactly one selection mode per page.
// group_name means "whatever's currently in this group" (live, no edit
// needed as monitors are added/removed from the group later);
// monitor_ids is a fixed manual list for a page that doesn't map to an
// existing group. Never both, never neither.
async function validateSelection(userId, groupName, monitorIds) {
  const hasGroup = !!groupName?.trim();
  const hasManual = Array.isArray(monitorIds) && monitorIds.length > 0;
  if (hasGroup === hasManual) {
    return "pick either a group or a manual list of monitors, not both or neither";
  }
  if (hasManual) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS n FROM monitors WHERE id = ANY($1::uuid[]) AND user_id = $2`,
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
    `SELECT * FROM status_pages WHERE user_id = $1 ORDER BY created_at ASC`,
    [req.userId]
  );
  res.json(rows);
});

router.post("/", async (req, res) => {
  const { name, group_name, monitor_ids } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const selectionError = await validateSelection(req.userId, group_name, monitor_ids);
  if (selectionError) return res.status(400).json({ error: selectionError });
  try {
    const { rows } = await pool.query(
      `INSERT INTO status_pages (user_id, name, share_token, group_name, monitor_ids)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [
        req.userId,
        name.trim(),
        generateShareToken(),
        group_name?.trim() || null,
        monitor_ids?.length ? JSON.stringify(monitor_ids) : null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create status page" });
  }
});

router.patch("/:id", async (req, res) => {
  const { name, group_name, monitor_ids } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const selectionError = await validateSelection(req.userId, group_name, monitor_ids);
  if (selectionError) return res.status(400).json({ error: selectionError });
  const { rows } = await pool.query(
    `UPDATE status_pages SET name = $3, group_name = $4, monitor_ids = $5, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [
      req.params.id,
      req.userId,
      name.trim(),
      group_name?.trim() || null,
      monitor_ids?.length ? JSON.stringify(monitor_ids) : null,
    ]
  );
  if (rows.length === 0) return res.status(404).json({ error: "status page not found" });
  res.json(rows[0]);
});

// Same reasoning as monitors' /share/regenerate: swap the token in the
// same write, so the old link stops resolving the instant the new one
// exists rather than both being live for any window.
router.post("/:id/regenerate", async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE status_pages SET share_token = $3, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *`,
    [req.params.id, req.userId, generateShareToken()]
  );
  if (rows.length === 0) return res.status(404).json({ error: "status page not found" });
  res.json(rows[0]);
});

router.delete("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM status_pages WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "status page not found" });
  res.json({ ok: true });
});

export default router;
