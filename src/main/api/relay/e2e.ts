/**
 * End-to-end encryption for relay terminal sessions (M3).
 *
 * The relay is a blind router — it forwards these sealed frames between a web
 * client and this agent without being able to read them. Both sides derive the
 * same key from an X25519 ECDH shared secret; terminal traffic is then sealed
 * with AES-256-GCM.
 *
 * AES-GCM (not XChaCha20) because it's the one AEAD available in *both* Node
 * crypto and browser WebCrypto, so the wire format is identical on both ends:
 * ciphertext = AES-256-GCM(key, nonce, plaintext) with the 16-byte tag
 * appended (WebCrypto's default), base64-encoded.
 *
 * Nonces are a 96-bit big-endian counter, one sequence per direction, so a
 * (key, nonce) pair is never reused. Receivers must reject non-increasing
 * counters to prevent replay/reorder.
 */

import crypto from 'crypto';

/**
 * HKDF salt + info — must match the web client exactly. An explicit (non-empty)
 * salt is used deliberately: empty-salt HKDF can differ between Node and
 * WebCrypto, whereas identical explicit salt bytes are unambiguous on both.
 */
const HKDF_SALT = 'bodhilander-relay-salt:v1';
const HKDF_INFO = 'bodhilander-relay-e2e:v1';
/** Handshake proof version — must match the web client exactly. */
const HANDSHAKE_VERSION = 'e2e-handshake:v1';

/** Derive the 32-byte AES key from an X25519 shared secret (HKDF-SHA256). */
export function deriveSessionKey(sharedSecret: Uint8Array): Buffer {
  const key = crypto.hkdfSync('sha256', sharedSecret, Buffer.from(HKDF_SALT), Buffer.from(HKDF_INFO), 32);
  return Buffer.from(key);
}

/** 12-byte AES-GCM nonce from a 64-bit counter (big-endian, high 4 bytes zero). */
export function nonceFromCounter(counter: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

export interface SealedFrame {
  /** The nonce counter used, so the receiver can reconstruct the nonce. */
  n: number;
  /** base64(ciphertext || 16-byte GCM tag). */
  ct: string;
}

/** Seal a plaintext under `key` at nonce-counter `counter`. */
export function seal(key: Buffer, counter: number, plaintext: Uint8Array): SealedFrame {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceFromCounter(counter));
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { n: counter, ct: Buffer.concat([enc, tag]).toString('base64') };
}

/** Open a sealed frame. Throws if authentication fails. */
export function open(key: Buffer, frame: SealedFrame): Buffer {
  const raw = Buffer.from(frame.ct, 'base64');
  if (raw.length < 16) throw new Error('sealed frame too short');
  const enc = raw.subarray(0, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceFromCounter(frame.n));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

/** Seal a JSON value. */
export function sealJson(key: Buffer, counter: number, value: unknown): SealedFrame {
  return seal(key, counter, new TextEncoder().encode(JSON.stringify(value)));
}

/** Open a sealed frame and JSON-parse it. */
export function openJson<T = unknown>(key: Buffer, frame: SealedFrame): T {
  return JSON.parse(open(key, frame).toString('utf8')) as T;
}

/**
 * The message the agent signs (Ed25519) to prove the ephemeral X25519 key it
 * offers really came from this machine. Binds both public keys so the signature
 * can't be replayed onto a different exchange. The client verifies it against
 * the machine's known Ed25519 identity key (the anti-MITM check).
 */
export function buildHandshakeProof(clientX25519PubB64: string, agentX25519PubB64: string): Uint8Array {
  return new TextEncoder().encode(`${HANDSHAKE_VERSION}\n${clientX25519PubB64}\n${agentX25519PubB64}`);
}
