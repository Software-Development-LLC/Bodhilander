/**
 * VAPID keypair management for Web Push (BDHLNDR-49).
 *
 * Web Push requires a VAPID (Voluntary Application Server Identification)
 * keypair so push services can identify this server when relaying push
 * messages to subscribed browsers. The public key is handed to the PWA at
 * subscribe time (encoded into the PushSubscription) and the private key
 * is used to sign push requests via the `web-push` npm package.
 *
 * Storage:
 *   - Path: `<userData>/web-push/vapid.json`
 *   - Shape: `{ publicKey: string, privateKey: string, subject: string,
 *              createdAt: number }`
 *     `publicKey` / `privateKey` are URL-base64 strings as returned by
 *     `webpush.generateVAPIDKeys()`. `subject` is the `mailto:` identity
 *     embedded in the signed JWT (push services may reject sends if it's
 *     missing or malformed). `createdAt` is the ms-epoch we minted the pair.
 *
 * Lifecycle:
 *   - First call to `getVapidKeys()` checks for the JSON file. If absent we
 *     generate, persist, and return; if present we load and return.
 *   - Result is cached in-process so we only touch the disk once per launch.
 *   - On POSIX we chmod 600 the file as a best-effort defense — the contents
 *     are no more sensitive than any other userData asset, but the private
 *     key shouldn't be world-readable on a shared box.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import webpush from 'web-push';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
  createdAt: number;
}

let cached: VapidKeys | null = null;

function getStoragePath(): string {
  return path.join(app.getPath('userData'), 'web-push', 'vapid.json');
}

/**
 * Load the existing VAPID keypair from disk, generating + persisting one on
 * first run. Cached in-memory after the first call so repeated invocations
 * (per state-change push, per `/public-key` request) are free.
 */
export function getVapidKeys(): VapidKeys {
  if (cached) return cached;

  const filePath = getStoragePath();

  // Load existing
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<VapidKeys>;
      if (
        typeof parsed.publicKey === 'string' &&
        typeof parsed.privateKey === 'string' &&
        typeof parsed.subject === 'string'
      ) {
        cached = {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
          subject: parsed.subject,
          createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
        };
        log.info('[vapid] Loaded existing VAPID keys from', filePath);
        return cached;
      }
      log.warn('[vapid] Existing vapid.json is missing required fields — regenerating');
    } catch (err) {
      log.error('[vapid] Failed to parse existing vapid.json — regenerating:', err);
    }
  }

  // Generate fresh keypair
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  const next: VapidKeys = {
    publicKey,
    privateKey,
    // `mailto:` identity required by some push providers (FCM accepts an
    // https: URL too; mailto: is the universally-accepted form). It's
    // surfaced inside the signed JWT — not user-visible.
    subject: 'mailto:bodhilander@localhost',
    createdAt: Date.now(),
  };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
    // Best-effort tightening of the file mode on POSIX. Windows ignores
    // chmod; we don't want to throw a noisy error there.
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch (chmodErr) {
        log.warn('[vapid] chmod 600 failed (non-fatal):', chmodErr);
      }
    }
    log.info('[vapid] Generated and stored new VAPID keypair at', filePath);
  } catch (err) {
    // Persistence failure shouldn't break the running push channel — keep the
    // freshly-generated pair in memory and try again on next launch. (We'll
    // log the error so the user can see it.)
    log.error('[vapid] Failed to persist vapid.json — keys are in-memory only:', err);
  }

  cached = next;
  return cached;
}

/**
 * Configure the global VAPID details on the `web-push` library. Safe to call
 * repeatedly; the library just overwrites the previous values.
 */
export function configureWebPush(): VapidKeys {
  const keys = getVapidKeys();
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  return keys;
}
