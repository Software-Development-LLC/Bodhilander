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
 *
 * The agent's half of the exchange is an EPHEMERAL keypair, freshly generated
 * for every channel (see `deriveEphemeral`). This is what makes the counter
 * discipline sound: with a long-lived agent key, ECDH(agent_static, client_pub)
 * is a pure function of the client's public key, so anyone able to open a
 * channel — notably the relay — could re-present a recorded `clientX25519Pub`,
 * get the same session key back, and replay recorded frames into a fresh
 * counter sequence. A per-channel key makes every channel's key unique, kills
 * that replay, removes the two-time-pad risk when two channels share a client
 * key, and buys forward secrecy for free.
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

/** base64url (from a JWK field) → standard base64, for on-the-wire use. */
function b64urlToB64(b64url: string): string {
  return Buffer.from(b64url, 'base64url').toString('base64');
}

/**
 * One channel's X25519 key agreement, using a keypair generated here and thrown
 * away with the channel. Returns the shared secret plus the ephemeral public
 * key to advertise to the client (which the caller signs with the machine's
 * long-lived Ed25519 identity, so the client can still prove the key came from
 * this machine).
 *
 * The private key never leaves this function, so a channel's key material is
 * unrecoverable once the channel is gone.
 */
export function deriveEphemeral(peerX25519PubRaw: Uint8Array): {
  sharedSecret: Buffer;
  ephemeralPubB64: string;
} {
  if (peerX25519PubRaw.length !== 32) throw new Error('peer X25519 public key must be 32 bytes');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const peerKey = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(peerX25519PubRaw).toString('base64url') },
    format: 'jwk',
  });
  const sharedSecret = crypto.diffieHellman({ privateKey, publicKey: peerKey });
  const { x } = publicKey.export({ format: 'jwk' }) as { x: string };
  return { sharedSecret, ephemeralPubB64: b64urlToB64(x) };
}

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
