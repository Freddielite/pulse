import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { sendTelegramMessage, telegramConfigured } from "../lib/telegram.js";

const router = Router();
router.use(requireAuth);

// Lets the frontend know whether it should even show the Telegram section
// (server-wide bot configured) without leaking the token itself.
router.get("/status", (req, res) => {
  res.json({ configured: telegramConfigured() });
});

router.post("/test", async (req, res) => {
  const { rows } = await pool.query(`SELECT telegram_chat_id FROM users WHERE id = $1`, [req.userId]);
  const chatId = rows[0]?.telegram_chat_id;
  if (!chatId) return res.status(400).json({ error: "no Telegram chat ID saved yet" });
  const result = await sendTelegramMessage({
    chatId,
    text: "Pulse: test notification. Telegram alerts are wired up correctly.",
  });
  if (!result.sent) return res.status(502).json({ error: result.reason || "failed to send" });
  res.json({ ok: true });
});

export default router;
