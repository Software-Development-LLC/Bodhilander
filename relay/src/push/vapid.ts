/**
 * VAPID — how a push service knows the request came from THIS relay.
 *
 * Web Push splits two jobs that are easy to confuse. **Identification** is
 * VAPID: an ES256 JWT, signed with an application-server key, that the push
 * service checks against the `applicationServerKey` the browser subscribed
 * with. **Confidentiality** is the aes128gcm content encoding, keyed by the
 * subscription's own `p256dh`/`auth`.
 *
 * The relay does the first and never the second. It signs, it addresses, it
 * forwards — the body arrives already sealed by the desktop agent and the
 * relay has no way to read it (design §10). Everything in this file is
 * therefore about the envelope.
 *
 * Key provisioning, in order:
 *   1. `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` from the environment.
 *   2. A pair previously minted here, from the `kv` table.
 *   3. A fresh pair, minted and persisted.
 *
 * The public key is baked into every browser subscription, so it must be
 * STABLE across restarts. Generating one per boot would leave every subscribed
 * device holding a key nothing signs with any more, and the push service would
 * reject each send with a 403 that looks like nothing in particular.
 */

import type { RelayConfig } from '../config';
import type { Logger } from '../logger';
import type { Repositories } from '../repositories';
import { toArrayBuffer } from '../crypto';

/** Where a self-minted keypair lives in the `kv` table. */
export const VAPID_KV_KEY = 'push.vapid';

/**
 * How long a signed JWT stays valid. RFC 8292 caps this at 24h; 12 gives us a
 * wide reuse window without sitting near a limit a push service may round.
 */
const JWT_TTL_SECONDS = 12 * 60 * 60;

/**
 * Re-sign this long before expiry rather than at it, so a token can't lapse
 * between being handed out and being read by the push service.
 */
const JWT_REFRESH_MARGIN_SECONDS = 5 * 60;

interface StoredKeypair {
  publicKey: string;
  privateKey: string;
}

/** Declared locally: `JsonWebKey` is a DOM lib type and the relay omits DOM. */
interface EcPrivateJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
  ext: boolean;
}

export interface Vapid {
  /** The base64url public key a browser subscribes with. */
  publicKey(): Promise<string>;
  /**
   * The `Authorization` header value for one push endpoint. Audience is the
   * endpoint's ORIGIN, never its full URL — the path contains the subscription
   * secret, and a JWT is not a place to put one.
   */
  authorization(endpoint: string): Promise<string>;
}

export function createVapid(ctx: {
  config: RelayConfig;
  repos: Repositories;
  logger: Logger;
  now?: () => number;
}): Vapid {
  const { config, repos, logger } = ctx;
  const now = ctx.now ?? Date.now;

  /**
   * Resolved once and reused. Held as the promise rather than its value so two
   * concurrent first-callers cannot both mint a keypair and race to store it.
   */
  let resolving: Promise<{ publicKey: string; signingKey: CryptoKey }> | null = null;

  /** audience → a token good until `expiresAt`. */
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  function resolveKeys(): Promise<{ publicKey: string; signingKey: CryptoKey }> {
    resolving ??= loadOrMint();
    return resolving;
  }

  async function loadOrMint(): Promise<{ publicKey: string; signingKey: CryptoKey }> {
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      return {
        publicKey: config.vapidPublicKey,
        signingKey: await importSigningKey(config.vapidPublicKey, config.vapidPrivateKey),
      };
    }

    const stored = readStored();
    if (stored) {
      return { publicKey: stored.publicKey, signingKey: await importSigningKey(stored.publicKey, stored.privateKey) };
    }

    const minted = await generateKeypair();
    // A store failure must not take push down for this process — but it does
    // mean the next restart mints a different key and orphans anything that
    // subscribed in between, which is worth saying out loud.
    try {
      repos.setKv(VAPID_KV_KEY, JSON.stringify({ publicKey: minted.publicKey, privateKey: minted.privateKey }));
      // Said once, at the only moment it is actionable. Every subscription is
      // bound to this key, so an operator on disposable storage needs to know
      // to pin it in the environment instead — and an operator on a durable
      // volume needs never to hear about it again.
      if (config.isProduction) {
        logger.warn(
          'minted a VAPID keypair and stored it in the database. Every push subscription is bound to this ' +
            'public key: if this volume is disposable, set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY instead, or ' +
            'notifications will stop for every subscribed device the next time it is replaced.',
        );
      } else {
        logger.info('minted a VAPID keypair and stored it');
      }
    } catch (err) {
      logger.error('failed to persist the VAPID keypair — subscriptions will not survive a restart', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      publicKey: minted.publicKey,
      signingKey: await importSigningKey(minted.publicKey, minted.privateKey),
    };
  }

  function readStored(): StoredKeypair | null {
    const raw = repos.getKv(VAPID_KV_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredKeypair>;
      if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch {
      /* fall through — a corrupt row is replaced rather than fatal */
    }
    logger.warn('the stored VAPID keypair is unreadable — minting a replacement');
    return null;
  }

  return {
    async publicKey() {
      return (await resolveKeys()).publicKey;
    },

    async authorization(endpoint: string) {
      const audience = new URL(endpoint).origin;
      const { publicKey, signingKey } = await resolveKeys();
      const nowSeconds = Math.floor(now() / 1000);

      const cached = tokens.get(audience);
      if (cached && cached.expiresAt - JWT_REFRESH_MARGIN_SECONDS > nowSeconds) {
        return `vapid t=${cached.token},k=${publicKey}`;
      }

      const expiresAt = nowSeconds + JWT_TTL_SECONDS;
      const token = await signJwt(signingKey, { aud: audience, exp: expiresAt, sub: config.vapidSubject });
      tokens.set(audience, { token, expiresAt });
      return `vapid t=${token},k=${publicKey}`;
    },
  };
}

/** `{ typ, alg }.{ aud, exp, sub }.{ ES256 signature }`, all base64url. */
async function signJwt(key: CryptoKey, claims: { aud: string; exp: number; sub: string }): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  // WebCrypto's ECDSA emits the raw r‖s pair JWS wants, not the DER SEQUENCE
  // OpenSSL would — so this needs no re-encoding, which is the usual bug here.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toArrayBuffer(signingInput),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

/**
 * Build a signing key from the base64url pair.
 *
 * Imported as a JWK because WebCrypto has no "raw private scalar" input for
 * ECDSA: the coordinates are carved out of the uncompressed point (`0x04 ‖ x ‖
 * y`) and paired with the scalar as `d`.
 */
async function importSigningKey(publicKeyB64: string, privateKeyB64: string): Promise<CryptoKey> {
  const point = new Uint8Array(Buffer.from(publicKeyB64, 'base64url'));
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('the VAPID public key must be an uncompressed P-256 point');
  }
  const jwk: EcPrivateJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(point.subarray(1, 33)),
    y: b64url(point.subarray(33, 65)),
    d: b64url(new Uint8Array(Buffer.from(privateKeyB64, 'base64url'))),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function generateKeypair(): Promise<StoredKeypair> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as { d?: string };
  if (!jwk.d) throw new Error('generated VAPID key has no private scalar');
  return { publicKey: b64url(publicKey), privateKey: jwk.d };
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
