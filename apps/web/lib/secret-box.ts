import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "./env";

/**
 * Seal a small secret the owner types into admin (a courier API password) so
 * the database and its backups never hold it in the clear. AES-256-GCM with a
 * key derived from SESSION_SECRET for one purpose; the purpose is bound as
 * additional data too, so a value sealed for one use won't open for another.
 * If SESSION_SECRET changes, old values stop opening and the caller treats the
 * secret as missing (the owner types it again).
 */

const VERSION = "v1";

function key(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", env.sessionSecret, "print-shop secret-box", purpose, 32));
}

export function sealSecret(plain: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** The secret, or null when it can't be opened (tampered, other purpose, or
 *  sealed under a different SESSION_SECRET). */
export function openSecret(sealed: string, purpose: string): string | null {
  const [version, ivText, bodyText] = sealed.split(".");
  if (version !== VERSION || !ivText || !bodyText) return null;
  try {
    const iv = Buffer.from(ivText, "base64url");
    const body = Buffer.from(bodyText, "base64url");
    if (iv.length !== 12 || body.length < 17) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(purpose), iv);
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
