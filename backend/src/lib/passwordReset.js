import crypto from "node:crypto";
import { pool } from "../db.js";
import { hashToken } from "./apiTokens.js";

const RESET_TTL_MINUTES = 60;

// Only the sha256 of the token is stored. Any earlier unused tokens for
// the same user are invalidated, so the newest email is the only live one.
export async function createResetToken(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(`DELETE FROM password_resets WHERE user_id = $1`, [userId]);
  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [userId, hashToken(token), String(RESET_TTL_MINUTES)]
  );
  return token;
}

// Single use, atomically: the DELETE ... RETURNING means two concurrent
// requests with the same token cannot both succeed.
export async function consumeResetToken(token) {
  const { rows } = await pool.query(
    `DELETE FROM password_resets WHERE token_hash = $1 AND expires_at > now() RETURNING user_id`,
    [hashToken(token)]
  );
  return rows[0]?.user_id || null;
}

export const RESET_TTL = RESET_TTL_MINUTES;
