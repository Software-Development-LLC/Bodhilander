import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Crypto helpers for the relay. Everything here is standard-library / WebCrypto
 * — Bun provides Ed25519 and X25519 natively, so the relay ships no crypto
 * dependencies.
 *
 * Conventions:
 *   - Secrets handed to clients are URL-safe base64 of random bytes.
 *   - Only the SHA-256 *hash* of any bearer secret is persisted, so a DB leak
 *     never exposes a usable token.
 */

/** A URL-safe base64 string of `bytes` random bytes (default 32 = 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Lowercase hex SHA-256 of a string or bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time comparison of two hex strings of equal length. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Generate a human-friendly, single-use link code, e.g. `K7Q2-9F3D`. Uses a
 * Crockford-ish alphabet (no 0/O/1/I/L) so it's unambiguous when read aloud or
 * typed. Returns the raw code — only its `sha256Hex` is ever stored.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function generateLinkCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    if (i === 3) out += '-';
  }
  return out;
}

/** Normalize a user-entered code: uppercase, strip whitespace/dashes. */
export function normalizeLinkCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Verify an Ed25519 signature against a raw 32-byte public key. `publicKeyRaw`,
 * `signature`, and `message` are raw bytes. Returns false on any malformed
 * input rather than throwing.
 */
export async function verifyEd25519(
  publicKeyRaw: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  if (publicKeyRaw.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('raw', toArrayBuffer(publicKeyRaw), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, toArrayBuffer(signature), toArrayBuffer(message));
  } catch {
    return false;
  }
}

/**
 * Copy a Uint8Array into a fresh, plain `ArrayBuffer`. WebCrypto wants a
 * `BufferSource`, and under Bun's lib config `Uint8Array<ArrayBufferLike>`
 * doesn't satisfy that type; a concrete ArrayBuffer does.
 */
export function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(u.byteLength);
  new Uint8Array(ab).set(u);
  return ab;
}

/** Decode a base64 / base64url string to bytes; returns null if invalid. */
export function fromBase64(value: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}
