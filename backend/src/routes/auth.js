import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { authRateLimit } from "../middleware/rateLimit.js";
import { normalizeNotificationPrefs } from "../lib/notificationPrefs.js";
import { generateSecret, otpauthUrl, verifyTotp, generateBackupCodes } from "../lib/totp.js";
import { sendWebhookAlert } from "../lib/webhook.js";

const router = Router();

const ME_COLUMNS = `id, email, alert_email, telegram_chat_id, webhook_url, digest_enabled, digest_sent_at,
  notification_prefs, totp_enabled, breach_monitoring_enabled, breach_checked_at, breach_last_result`;

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
    if (user.totp_enabled) {
      // Password is correct but the session isn't authenticated yet - a
      // second, narrower field (pendingTotpUserId) rather than userId,
      // so nothing that checks req.session.userId (i.e. requireAuth)
      // treats this half-logged-in state as an authenticated session.
      req.session.pendingTotpUserId = user.id;
      return res.json({ requires_totp: true });
    }

    req.session.userId = user.id;
    res.json({ id: user.id, email: user.email, alert_email: user.alert_email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to log in" });
  }
});

// Second step of login for accounts with 2FA enabled. Rate-limited on
// IP alone (there's no email in this request to key a second bucket
// off, the way login's identifierField does) since guessing a 6-digit
// TOTP code is exactly the kind of thing worth throttling.
router.post("/2fa/verify-login", authRateLimit({ max: 8, windowMinutes: 15, identifierField: "__none__" }), async (req, res) => {
  const pendingUserId = req.session.pendingTotpUserId;
  if (!pendingUserId) return res.status(400).json({ error: "no pending login" });

  const { code, backup_code } = req.body;
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [pendingUserId]);
  const user = rows[0];
  if (!user) return res.status(400).json({ error: "no pending login" });

  if (code && verifyTotp(user.totp_secret, code)) {
    req.session.userId = user.id;
    delete req.session.pendingTotpUserId;
    return res.json({ id: user.id, email: user.email, alert_email: user.alert_email });
  }

  if (backup_code) {
    const codes = user.totp_backup_codes || [];
    for (let i = 0; i < codes.length; i++) {
      if (await bcrypt.compare(String(backup_code).trim(), codes[i])) {
        // One-time - consumed on use, same as any recovery code.
        const remaining = codes.slice(0, i).concat(codes.slice(i + 1));
        await pool.query(`UPDATE users SET totp_backup_codes = $2 WHERE id = $1`, [user.id, JSON.stringify(remaining)]);
        req.session.userId = user.id;
        delete req.session.pendingTotpUserId;
        return res.json({ id: user.id, email: user.email, alert_email: user.alert_email });
      }
    }
  }

  await req.recordAuthFailure();
  res.status(401).json({ error: "invalid code" });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Same rate-limit shape as login (IP bucket, since there's no email in
// the body to key a second bucket off of) - the current-password check
// below is exactly the kind of thing brute-forcing would target.
router.post("/change-password", requireAuth, authRateLimit({ max: 5, windowMinutes: 15 }), async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password || new_password.length < 8) {
    return res.status(400).json({ error: "current password and a new 8+ character password are required" });
  }
  const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.userId]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(current_password, user.password_hash))) {
    await req.recordAuthFailure();
    return res.status(401).json({ error: "current password is incorrect" });
  }
  const hash = await bcrypt.hash(new_password, 12);
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [req.userId, hash]);
  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT ${ME_COLUMNS} FROM users WHERE id = $1`, [req.userId]);
  if (rows.length === 0) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// --- Two-factor auth (TOTP) ---

// Step 1: generate a secret and hand back the otpauth URI + bare secret
// for the user's authenticator app, without touching totp_enabled yet -
// see the totp_pending_secret column comment in db.js for why.
router.post("/2fa/setup", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.userId]);
  const secret = generateSecret();
  await pool.query(`UPDATE users SET totp_pending_secret = $2 WHERE id = $1`, [req.userId, secret]);
  res.json({ secret, otpauth_url: otpauthUrl({ secret, email: rows[0].email }) });
});

// Step 2: confirm setup with a code from the app, which is also proof
// the user actually saved the secret correctly before it becomes the
// thing guarding their login. Returns backup codes once, plaintext -
// same "shown once, unrecoverable after" treatment as an API token.
router.post("/2fa/confirm", requireAuth, async (req, res) => {
  const { code } = req.body;
  const { rows } = await pool.query(`SELECT totp_pending_secret FROM users WHERE id = $1`, [req.userId]);
  const pendingSecret = rows[0]?.totp_pending_secret;
  if (!pendingSecret) return res.status(400).json({ error: "no 2FA setup in progress" });
  if (!verifyTotp(pendingSecret, code)) return res.status(400).json({ error: "invalid code" });

  const backupCodes = generateBackupCodes();
  const hashedCodes = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)));
  await pool.query(
    `UPDATE users SET totp_secret = $2, totp_enabled = true, totp_pending_secret = NULL, totp_backup_codes = $3 WHERE id = $1`,
    [req.userId, pendingSecret, JSON.stringify(hashedCodes)]
  );
  res.json({ ok: true, backup_codes: backupCodes });
});

// Password confirmation required to turn 2FA off, same reasoning as
// requiring the current password to change it - this is exactly the
// kind of downgrade an attacker with a hijacked session would want.
router.post("/2fa/disable", requireAuth, async (req, res) => {
  const { password } = req.body;
  const { rows } = await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [req.userId]);
  if (!rows[0] || !(await bcrypt.compare(password || "", rows[0].password_hash))) {
    return res.status(401).json({ error: "incorrect password" });
  }
  await pool.query(
    `UPDATE users SET totp_enabled = false, totp_secret = NULL, totp_pending_secret = NULL, totp_backup_codes = NULL WHERE id = $1`,
    [req.userId]
  );
  res.json({ ok: true });
});

// Fires the same payload shape a real alert would, so a user can
// confirm their URL and receiving side actually work before relying on
// it - matters more here than for push/Telegram, since a webhook is
// user-typed and has no other "ready" signal the way Telegram's
// bot-configured check does.
router.post("/webhook-test", requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT webhook_url FROM users WHERE id = $1`, [req.userId]);
  const url = rows[0]?.webhook_url;
  if (!url) return res.status(400).json({ error: "no webhook URL saved" });
  const result = await sendWebhookAlert(url, {
    event: "test",
    severity: "info",
    title: "Pulse test webhook",
    body: "If you're seeing this, your webhook URL is working.",
  });
  if (!result.sent) return res.status(502).json({ error: result.reason || "webhook send failed" });
  res.json({ ok: true });
});

router.patch("/me", requireAuth, async (req, res) => {
  const { alert_email, telegram_chat_id, webhook_url, digest_enabled, breach_monitoring_enabled, notification_prefs } = req.body;
  // Merged against the current row (not just the default shape) so a
  // PATCH that only touches, say, push.down doesn't clobber telegram or
  // webhook prefs the user set in an earlier request.
  let mergedPrefs = undefined;
  if (notification_prefs !== undefined) {
    const { rows: currentRows } = await pool.query(`SELECT notification_prefs FROM users WHERE id = $1`, [req.userId]);
    mergedPrefs = normalizeNotificationPrefs({
      push: { ...currentRows[0]?.notification_prefs?.push, ...notification_prefs?.push },
      telegram: { ...currentRows[0]?.notification_prefs?.telegram, ...notification_prefs?.telegram },
      webhook: { ...currentRows[0]?.notification_prefs?.webhook, ...notification_prefs?.webhook },
    });
  }
  const { rows } = await pool.query(
    `UPDATE users SET
       alert_email = COALESCE($2, alert_email),
       -- Unlike the other fields, an explicit clear (empty string, to
       -- disconnect Telegram) is a real, valid request here - so this
       -- can't just be COALESCE($3, telegram_chat_id), which would be
       -- unable to tell "clear it" apart from "field wasn't in this
       -- request" (both arrive as NULL). $6 carries that distinction
       -- separately instead.
       telegram_chat_id = CASE WHEN $6 THEN $3 ELSE telegram_chat_id END,
       digest_enabled = COALESCE($4, digest_enabled),
       notification_prefs = COALESCE($5, notification_prefs),
       -- webhook_url gets the same "explicit clear is valid" treatment
       -- as telegram_chat_id above, for the same reason - disconnecting
       -- a webhook is a real request, not an absent field.
       webhook_url = CASE WHEN $7 THEN $8 ELSE webhook_url END,
       breach_monitoring_enabled = COALESCE($9, breach_monitoring_enabled)
     WHERE id = $1 RETURNING ${ME_COLUMNS}`,
    [
      req.userId,
      alert_email?.trim() || null,
      telegram_chat_id?.trim() || null,
      digest_enabled === undefined ? null : !!digest_enabled,
      mergedPrefs ? JSON.stringify(mergedPrefs) : null,
      telegram_chat_id !== undefined,
      webhook_url !== undefined,
      webhook_url?.trim() || null,
      breach_monitoring_enabled === undefined ? null : !!breach_monitoring_enabled,
    ]
  );
  res.json(rows[0]);
});

export default router;
