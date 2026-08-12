import crypto from "node:crypto";

// AES-256-GCM, not a hash: unlike api_tokens.token_hash or share_token,
// a GitHub token has to come back out in plaintext to actually call the
// GitHub API with, so hashing it (one-way, by design) isn't an option.
// REMEDIATION_ENC_KEY is a 32-byte key, base64-encoded, and lives only
// in the environment - generate one with `openssl rand -base64 32`.
// Never derive it from anything else stored in this database; the whole
// point is that a DB dump alone can't decrypt what's in it.
const KEY = process.env.REMEDIATION_ENC_KEY ? Buffer.from(process.env.REMEDIATION_ENC_KEY, "base64") : null;

export function remediationEncryptionAvailable() {
  return !!KEY && KEY.length === 32;
}

// Stored as "iv.authTag.ciphertext", each base64 - a fresh random iv per
// call (GCM requires a unique iv per encryption under the same key) and
// the auth tag alongside it so decryption can detect tampering, not just
// fail silently on a corrupted value.
export function encryptSecret(plaintext) {
  if (!remediationEncryptionAvailable()) throw new Error("REMEDIATION_ENC_KEY not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(stored) {
  if (!remediationEncryptionAvailable()) throw new Error("REMEDIATION_ENC_KEY not configured");
  const [ivB64, tagB64, ctB64] = stored.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
