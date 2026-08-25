/**
 * Sealing a web-push payload on the AGENT (RFC 8291, `aes128gcm`). The relay
 * forwards a blob it holds no key for, so a notification can name a session
 * the relay never learns. Why it is done here: design §10.
 */

// Pure `node:crypto` like `grants.ts` — no Electron, no repositories, no
// logger — so every branch is testable without `mock.module()`.
//
// Pinned against the published RFC 8291 §5 vector in the tests, which makes
// this verified interop rather than a round trip that agrees with itself.

import { createCipheriv, createECDH, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';

/** One record, and every payload we send fits in it. */
export const RECORD_SIZE = 4096;

/** Uncompressed P-256 point: `0x04 ‖ x ‖ y`. */
const PUBLIC_KEY_BYTES = 65;
/** RFC 8291 §3.2 fixes the subscription's auth secret at 16 octets. */
const AUTH_SECRET_BYTES = 16;
/** salt(16) ‖ rs(4) ‖ idlen(1) — the RFC 8188 record header, minus the key id. */
const HEADER_BYTES = 21;
const SALT_BYTES = 16;
/** AES-GCM tag, plus the one-octet record delimiter. */
const OVERHEAD_BYTES = 17;

/** The most plaintext a single record can carry. */
export const MAX_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - PUBLIC_KEY_BYTES - OVERHEAD_BYTES;

export interface PushSubscriptionKeys {
  /** The subscription's public key, base64url. */
  p256dh: string;
  /** The subscription's auth secret, base64url. */
  auth: string;
}

/**
 * A browser subscription as the relay describes it: keys, and an id to name
 * them by. No endpoint — the relay addresses, so the desktop never learns
 * which push service its owner reads on. Minimal disclosure, both ways.
 */
export interface RelayPushSubscription extends PushSubscriptionKeys {
  id: string;
}

export interface SealOptions {
  /**
   * Fixed salt and ephemeral key. **Tests only**: a repeated (key, nonce) pair
   * under AES-GCM loses confidentiality outright. Production stays random.
   */
  salt?: Buffer;
  senderPrivateKey?: Buffer;
}

export class PushSealError extends Error {
  override name = 'PushSealError';
}

/**
 * Encrypt `plaintext` to one subscription: the exact bytes of the POST body.
 * Throws rather than returning null — a malformed subscription is a bug or a
 * hostile relay, and both beat a notification that never silently arrives.
 */
export function sealWebPushPayload(
  keys: PushSubscriptionKeys,
  plaintext: string | Uint8Array,
  options: SealOptions = {},
): Buffer {
  const receiverPublic = decodeKey(keys.p256dh, 'p256dh');
  if (receiverPublic.length !== PUBLIC_KEY_BYTES || receiverPublic[0] !== 0x04) {
    throw new PushSealError('p256dh must be an uncompressed P-256 point');
  }
  const authSecret = decodeKey(keys.auth, 'auth');
  if (authSecret.length !== AUTH_SECRET_BYTES) {
    throw new PushSealError(`auth must be ${AUTH_SECRET_BYTES} bytes`);
  }

  const body = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  if (body.length > MAX_PLAINTEXT_BYTES) {
    throw new PushSealError(`payload is ${body.length} bytes; the limit is ${MAX_PLAINTEXT_BYTES}`);
  }

  const ecdh = createECDH('prime256v1');
  if (options.senderPrivateKey) ecdh.setPrivateKey(options.senderPrivateKey);
  else ecdh.generateKeys();
  const senderPublic = ecdh.getPublicKey();

  let sharedSecret: Buffer;
  try {
    sharedSecret = ecdh.computeSecret(receiverPublic);
  } catch {
    // A point that isn't on the curve. Never a transient condition, so it is
    // reported rather than retried.
    throw new PushSealError('p256dh is not a valid P-256 public key');
  }

  // The context string binds the derived key to BOTH public keys, which is what
  // stops a payload sealed for one subscription being replayed at another.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));

  const salt = options.salt ?? randomBytes(SALT_BYTES);
  if (salt.length !== SALT_BYTES) throw new PushSealError(`salt must be ${SALT_BYTES} bytes`);

  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // `0x02` is the last-record delimiter. A single-record message uses 0x02;
  // 0x01 would claim another record follows and the browser would reject it.
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([body, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(HEADER_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(senderPublic.length, SALT_BYTES + 4);

  return Buffer.concat([header, senderPublic, ciphertext]);
}

/**
 * Whether two subscription key sets are the same. Constant-time: the values
 * come from the relay, and there is no reason to leak a prefix length.
 */
export function sameSubscriptionKeys(a: PushSubscriptionKeys, b: PushSubscriptionKeys): boolean {
  return equalStrings(a.p256dh, b.p256dh) && equalStrings(a.auth, b.auth);
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function decodeKey(value: string, field: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PushSealError(`${field} is missing`);
  }
  // base64url and base64 both decode here: Node's decoder accepts either
  // alphabet, and push subscriptions have been observed using both.
  return Buffer.from(value, 'base64url');
}
