// Authenticated encryption for local credentials at rest.
//
// What this protects: the OneBot access token that this app needs in order to dial the
// user's own local NapCat WebSocket. It is NOT a QQ account password — those never reach
// this application at all (login belongs to NapCat). Even so, the token is a live
// credential for a locally listening service, so it is not stored in the clear.
//
// Key handling reuses the project's existing secret-file mechanism
// (`browserStateSecret`), which already does what a key file needs: create it once with
// 0600 permissions, write it atomically, and serialise concurrent creation. It gets its
// OWN key file rather than sharing the browser-state key, so the two secrets never have
// to be rotated together.
//
// AES-256-GCM, not CBC: a token that has been tampered with must fail loudly rather than
// decrypt into a mangled string. GCM gives that for free, and the version prefix leaves
// room to change the scheme without guessing at the old format.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import { browserStateSecret } from "./browser-state";

/** Development fallback; the app always passes the layout's own key path. */
export const DEFAULT_TRANSPORT_KEY_PATH = path.resolve("artifacts/state/qq-transport.key");
/** 外部模型 API 密钥的密钥文件（0032）。各自一把：轮换一个不影响另一个。 */
export const DEFAULT_MODEL_PROVIDER_KEY_PATH = path.resolve("artifacts/state/model-providers.key");

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;

/** Derive a stable 32-byte key from the secret file's text. */
function keyFrom(secret: string): Buffer {
  // The secret is already 32 random bytes in base64url, so its bytes ARE the key.
  const key = Buffer.from(secret, "base64url");
  if (key.length < 32) throw new Error("SECRET_TOO_SHORT");
  return key.subarray(0, 32);
}

/**
 * Encrypt a secret for storage. The output is self-describing:
 * `v1.<iv>.<tag>.<ciphertext>`, all base64url, so a stored value can be recognised as
 * ours before it is decrypted.
 */
export function sealSecret(plaintext: string, secret: string): string {
  if (plaintext.length === 0) throw new Error("EMPTY_SECRET");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFrom(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt a stored secret. Returns `null` for anything that is not a well-formed,
 * authentic value we produced: a rotated key, a truncated row or a tampered token all
 * mean "this credential is not usable", which the caller must treat as "not configured"
 * rather than as an empty token.
 */
export function openSecret(sealed: string, secret: string): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const [, ivPart, tagPart, bodyPart] = parts;
  if (!ivPart || !tagPart || !bodyPart) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, keyFrom(secret), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(bodyPart, "base64url")),
      decipher.final(),
    ]);
    const value = plaintext.toString("utf8");
    return value.length > 0 ? value : null;
  } catch {
    // Never surface the underlying error: it can describe the key or the ciphertext.
    return null;
  }
}

/** The key for stored transport credentials, created on first use. */
export function transportSecret(keyPath: string): string {
  return browserStateSecret(keyPath);
}
