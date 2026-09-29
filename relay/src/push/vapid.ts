/**
 * VAPID — how a push service knows a request came from THIS relay. An ES256
 * JWT checked against the `applicationServerKey` the browser subscribed with.
 */

// Web Push splits identification (this file) from confidentiality (the agent's
// aes128gcm sealing). The relay signs, addresses and forwards a body it cannot
// read — design §10 — so everything here is about the envelope.

// Keys come from the environment, else the `kv` table, else a fresh pair that
// is persisted. The public key is baked into every browser subscription, so it
// must be STABLE: minting per boot leaves every device holding a key nothing
// signs with, and the push service answers 403 for no visible reason.

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

  /**
   * audience → a token good until `expiresAt`. Bounded: the audience comes from
   * a stored endpoint, so an unbounded map would grow with them.
   */
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const MAX_CACHED_TOKENS = 64;

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
      // Insert-if-absent, then adopt what is stored: two processes starting
      // together must converge on ONE key, or whichever wrote second would
      // orphan every subscription the first had already handed out.
      const stored = repos.setKvIfAbsent(
        VAPID_KV_KEY,
        JSON.stringify({ publicKey: minted.publicKey, privateKey: minted.privateKey }),
      );
      const winner = JSON.parse(stored) as StoredKeypair;
      if (winner.publicKey !== minted.publicKey) {
        logger.info('another process had already stored a VAPID keypair; using theirs');
        return { publicKey: winner.publicKey, signingKey: await importSigningKey(winner.publicKey, winner.privateKey) };
      }
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
      logger.error('could not settle on a stored VAPID keypair — this one is in memory only, so every ' +
        'subscription made against it is orphaned at the next restart', {
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
    // DELETED, not just ignored. The write below is insert-if-absent, so a row
    // left in place would swallow every replacement and the read-back would
    // fail again — minting a fresh unstored key on every restart, orphaning
    // every subscription, forever.
    repos.deleteKv(VAPID_KV_KEY);
    logger.warn('the stored VAPID keypair was unreadable — dropped it and minting a replacement');
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
      // Signing is cheap; unbounded growth is not. Oldest out first.
      if (tokens.size >= MAX_CACHED_TOKENS) {
        const oldest = tokens.keys().next().value;
        if (oldest !== undefined) tokens.delete(oldest);
      }
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
 * Build a signing key from the base64url pair. Imported as a JWK because
 * WebCrypto has no raw-private-scalar input for ECDSA: the coordinates come out
 * of the uncompressed point (`0x04 ‖ x ‖ y`) and pair with the scalar as `d`.
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
