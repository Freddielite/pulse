import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { sendPushToUser } from "../lib/webPush.js";

const router = Router();
router.use(requireAuth);

router.get("/vapid-public-key", (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

router.post("/subscribe", async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: "invalid subscription" });
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`,
    [req.userId, endpoint, keys.p256dh, keys.auth]
  );
  res.status(201).json({ ok: true });
});

router.post("/unsubscribe", async (req, res) => {
  const { endpoint } = req.body;
  await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [endpoint, req.userId]);
  res.json({ ok: true });
});

router.post("/test", async (req, res) => {
  const result = await sendPushToUser(req.userId, { title: "Pulse", body: "Test notification. Push is wired up correctly." });
  if (!result.configured) return res.status(503).json({ error: "push isn't configured on the server" });
  if (result.total === 0) return res.status(400).json({ error: "no active push subscription found for this device - try toggling push off and back on" });
  if (result.sent === 0) return res.status(502).json({ error: "the push service rejected delivery - try toggling push off and back on to get a fresh subscription" });
  res.json({ ok: true, sent: result.sent, failed: result.failed });
});

export default router;
