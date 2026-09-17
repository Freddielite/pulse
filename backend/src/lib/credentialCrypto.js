import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

// Unlike password hashing or API-token hashing elsewhere in this app,
// this has to be REVERSIBLE - a saved session cookie/bearer token needs
// to be sent back out on the next scheduled scan, not just checked
// against a stored value. That's a materially bigger trust step than
// anything else this app stores, which is exactly why it's opt-in per
// monitor, encrypted at rest, and gated on a key that has to be
// deliberately configured - there's no insecure fallback here the way
// SESSION_SECRET/CRON_SECRET have one. If CREDENTIAL_ENCRYPTION_KEY
// isn't set, this feature simply doesn't work, on purpose - see the
// callers in routes/monitors.js, which refuse to enable authenticated
// scanning at all rather than store a credential some other way.
function getKey() {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

export function isCredentialEncryptionConfigured() {
  return getKey() !== null;
}

// Stored as one base64 blob: 12-byte IV, 16-byte GCM auth tag, then the
// ciphertext, concatenated - simpler than three separate columns, and
// GCM's auth tag means a corrupted or tampered blob fails to decrypt
// loudly rather than silently returning garbage.
export function encryptCredential(plaintext) {
  const key = getKey();
  if (!key) throw new Error("CREDENTIAL_ENCRYPTION_KEY is not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptCredential(stored) {
  const key = getKey();
  if (!key) throw new Error("CREDENTIAL_ENCRYPTION_KEY is not configured");
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
