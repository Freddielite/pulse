import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

// Optional lightweight gate so a publicly-deployed instance can't be
// signed up for by strangers. Leave SIGNUP_CODE unset in dev; set it in
// production if the backend URL could plausibly be found by anyone else.
router.post("/signup", async (req, res) => {
  const { email, password, signup_code, alert_email } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: "email and an 8+ character password are required" });
  }
  if (process.env.SIGNUP_CODE && signup_code !== process.env.SIGNUP_CODE) {
    return res.status(403).json({ error: "invalid signup code" });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, alert_email) VALUES ($1, $2, $3)
       RETURNING id, email, alert_email`,
      [email.trim().toLowerCase(), hash, alert_email?.trim() || email.trim().toLowerCase()]
    );
    req.session.userId = rows[0].id;
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "an account with that email already exists" });
    console.error(err);
    res.status(500).json({ error: "failed to sign up" });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email?.trim().toLowerCase()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
      return res.status(401).json({ error: "invalid email or password" });
    }
    req.session.userId = user.id;
    res.json({ id: user.id, email: user.email, alert_email: user.alert_email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to log in" });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT id, email, alert_email, telegram_chat_id FROM users WHERE id = $1`, [req.userId]);
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

router.patch("/me", requireAuth, async (req, res) => {
  const { alert_email, telegram_chat_id } = req.body;
  const { rows } = await pool.query(
    `UPDATE users SET
       alert_email = COALESCE($2, alert_email),
       telegram_chat_id = $3
     WHERE id = $1 RETURNING id, email, alert_email, telegram_chat_id`,
    [req.userId, alert_email?.trim() || null, telegram_chat_id?.trim() || null]
  );
  res.json(rows[0]);
});

export default router;
