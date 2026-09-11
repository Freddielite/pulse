import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { authRateLimit } from "../middleware/rateLimit.js";
import { normalizeNotificationPrefs } from "../lib/notificationPrefs.js";

const router = Router();

// Optional lightweight gate so a publicly-deployed instance can't be
// signed up for by strangers. Leave SIGNUP_CODE unset in dev; set it in
// production if the backend URL could plausibly be found by anyone else.
// Signup gets a looser limit than login: it's already gated by
// SIGNUP_CODE on any instance that needs it, and the thing being
// prevented here is bulk account creation rather than password guessing.
router.post("/signup", authRateLimit({ max: 5, windowMinutes: 60 }), async (req, res) => {
  const { email, password, signup_code, alert_email } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: "email and an 8+ character password are required" });
  }
  if (process.env.SIGNUP_CODE && signup_code !== process.env.SIGNUP_CODE) {
    // A wrong signup code counts as a failed attempt, otherwise the code
    // itself is brute-forceable at whatever rate the network allows.
    await req.recordAuthFailure();
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

router.post("/login", authRateLimit({ max: 8, windowMinutes: 15 }), async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email?.trim().toLowerCase()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
      // Only failures are counted, so someone logging in successfully all
      // day never trips the limiter (see middleware/rateLimit.js).
      await req.recordAuthFailure();
      // The unauthenticated response is deliberately identical whether
      // the email exists or not - "invalid email or password" rather than
      // "no such account" - so this endpoint can't be used to enumerate
      // which addresses have accounts.
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
  const { rows } = await pool.query(
    `SELECT id, email, alert_email, telegram_chat_id, digest_enabled, digest_sent_at, notification_prefs FROM users WHERE id = $1`,
    [req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

router.patch("/me", requireAuth, async (req, res) => {
  const { alert_email, telegram_chat_id, digest_enabled, notification_prefs } = req.body;
  // Merged against the current row (not just the default shape) so a
  // PATCH that only touches, say, push.down doesn't clobber telegram
  // prefs the user set in an earlier request.
  let mergedPrefs = undefined;
  if (notification_prefs !== undefined) {
    const { rows: currentRows } = await pool.query(`SELECT notification_prefs FROM users WHERE id = $1`, [req.userId]);
    mergedPrefs = normalizeNotificationPrefs({
      push: { ...currentRows[0]?.notification_prefs?.push, ...notification_prefs?.push },
      telegram: { ...currentRows[0]?.notification_prefs?.telegram, ...notification_prefs?.telegram },
    });
  }
  const { rows } = await pool.query(
    `UPDATE users SET
       alert_email = COALESCE($2, alert_email),
       telegram_chat_id = $3,
       digest_enabled = COALESCE($4, digest_enabled),
       notification_prefs = COALESCE($5, notification_prefs)
     WHERE id = $1 RETURNING id, email, alert_email, telegram_chat_id, digest_enabled, digest_sent_at, notification_prefs`,
    [
      req.userId,
      alert_email?.trim() || null,
      telegram_chat_id?.trim() || null,
      digest_enabled === undefined ? null : !!digest_enabled,
      mergedPrefs ? JSON.stringify(mergedPrefs) : null,
    ]
  );
  res.json(rows[0]);
});

export default router;
