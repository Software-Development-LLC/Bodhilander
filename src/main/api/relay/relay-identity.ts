/**
 * Relay machine identity (remote hosting, Slice B).
 *
 * A machine's identity is an Ed25519 keypair (proves who it is) plus an X25519
 * keypair (future end-to-end key agreement with a web client). The raw public
 * keys are non-secret and live as plaintext preferences; the private keys are
 * encrypted with Electron `safeStorage` (OS keychain) and persisted as base64
 * blobs in the `preferences` table — the exact pattern used by `key-vault.ts`.
 * Plaintext private keys never touch the DB, logs, or the renderer.
 */

import crypto from 'crypto';
import { safeStorage } from 'electron';
import log from 'electron-log';
import { getPreference, setPreference, deletePreference } from '../../repositories/preferences';

const PREF = {
  ed25519Pub: 'relay.ed25519Pub',
  ed25519Priv: 'relay.ed25519Priv',
  x25519Pub: 'relay.x25519Pub',
  x25519Priv: 'relay.x25519Priv',
} as const;

export interface RelayIdentity {
  /** Raw 32-byte Ed25519 public key, base64. */
  ed25519Pub: string;
  /** Raw 32-byte X25519 public key, base64. */
  x25519Pub: string;
}

function vaultAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/** base64url (from a JWK field) → standard base64, for on-the-wire use. */
function b64urlToB64(b64url: string): string {
  return Buffer.from(b64url, 'base64url').toString('base64');
}

/** Generate an OKP keypair and return raw pub/priv as base64url (JWK-native). */
function generateOkp(type: 'ed25519' | 'x25519'): { pub: string; priv: string } {
  // Call with a string literal so TS resolves the ed25519/x25519 overload
  // (a union argument falls through to the wrong overload).
  const { publicKey, privateKey } =
    type === 'ed25519' ? crypto.generateKeyPairSync('ed25519') : crypto.generateKeyPairSync('x25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return { pub: pubJwk.x, priv: privJwk.d };
}

/**
 * Return the machine's identity, generating and persisting it on first use.
 * Throws if secure storage is unavailable — we refuse to keep a private key we
 * can't protect.
 */
export function ensureIdentity(): RelayIdentity {
  const existingEdPub = getPreference(PREF.ed25519Pub);
  const existingXPub = getPreference(PREF.x25519Pub);
  if (existingEdPub && existingXPub && getPreference(PREF.ed25519Priv) && getPreference(PREF.x25519Priv)) {
    return { ed25519Pub: existingEdPub, x25519Pub: existingXPub };
  }

  if (!vaultAvailable()) {
    throw new Error('Secure key storage is not available on this system; cannot create a relay identity');
  }

  const ed = generateOkp('ed25519');
  const x = generateOkp('x25519');

  // Public keys are stored base64 (wire format); private keys stay base64url
  // (JWK-native) inside the encrypted blob so signing can reconstruct the JWK.
  setPreference(PREF.ed25519Pub, b64urlToB64(ed.pub));
  setPreference(PREF.x25519Pub, b64urlToB64(x.pub));
  setPreference(PREF.ed25519Priv, safeStorage.encryptString(ed.priv).toString('base64'));
  setPreference(PREF.x25519Priv, safeStorage.encryptString(x.priv).toString('base64'));
  log.info('[Relay] generated new machine identity');

  return { ed25519Pub: b64urlToB64(ed.pub), x25519Pub: b64urlToB64(x.pub) };
}

/** True if an identity has already been created. */
export function hasIdentity(): boolean {
  return !!getPreference(PREF.ed25519Pub) && !!getPreference(PREF.ed25519Priv);
}

/** Sign a message with the Ed25519 identity key. Requires an existing identity. */
export function signWithIdentity(message: Uint8Array): Buffer {
  const edPubB64 = getPreference(PREF.ed25519Pub);
  const encPriv = getPreference(PREF.ed25519Priv);
  if (!edPubB64 || !encPriv) throw new Error('no relay identity to sign with');
  if (!vaultAvailable()) throw new Error('secure storage unavailable; cannot access signing key');

  const privB64url = safeStorage.decryptString(Buffer.from(encPriv, 'base64'));
  const key = crypto.createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(edPubB64, 'base64').toString('base64url'),
      d: privB64url,
    },
    format: 'jwk',
  });
  return crypto.sign(null, Buffer.from(message), key);
}

/**
 * A human-comparable fingerprint of the identity, SSH-style
 * (`SHA256:<base64-no-pad>`). Shown on the desktop and in the web UI so a user
 * can confirm they're linking the right machine (§5 of the design).
 */
export function identityFingerprint(): string | null {
  const edPubB64 = getPreference(PREF.ed25519Pub);
  if (!edPubB64) return null;
  const hash = crypto.createHash('sha256').update(Buffer.from(edPubB64, 'base64')).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

/** Forget the identity entirely (used when unlinking / resetting). */
export function clearIdentity(): void {
  for (const key of Object.values(PREF)) deletePreference(key);
  log.info('[Relay] cleared machine identity');
}
