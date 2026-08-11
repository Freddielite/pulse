import crypto from "node:crypto";

// 18 random bytes (144 bits) base64url-encoded - long enough that
// guessing or enumerating a live link isn't a realistic path, short
// enough to sit reasonably in a URL. Unlike an api_token, this isn't
// hashed at rest (see the share_token column comment in db.js): the
// whole point of the link is that holding it grants read-only viewing,
// so there's no separate "secret" to protect beyond the token itself.
export function generateShareToken() {
  return crypto.randomBytes(18).toString("base64url");
}
