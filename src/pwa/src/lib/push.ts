/**
 * Web Push subscribe / unsubscribe client (BDHLNDR-49).
 *
 * Contract with the desktop:
 *   - GET    /api/v1/web-push/public-key  → { publicKey: <urlBase64> }
 *   - POST   /api/v1/web-push/subscribe   ← PushSubscription.toJSON()
 *   - DELETE /api/v1/web-push/subscribe   ← { endpoint? }
 *
 * Lifecycle:
 *   - `subscribeToPush()` is idempotent: if a subscription already exists in
 *     the SW registration we re-POST it (server-side INSERT OR REPLACE on
 *     endpoint, so re-subscribe doesn't accumulate rows).
 *   - `unsubscribeFromPush()` clears both ends (browser + server).
 *   - All entry points return early on unsupported browsers / denied
 *     permission so callers don't have to gate per-call.
 */

import { apiFetch } from './api';

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

export function isPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in window)) return false;
  if (!('Notification' in window)) return false;
  return true;
}

export type PushPermission = NotificationPermission | 'unsupported';

export function getPushPermission(): PushPermission {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

// ---------------------------------------------------------------------------
// VAPID public key handling
// ---------------------------------------------------------------------------

/**
 * Convert a URL-safe-base64 VAPID key into the Uint8Array the Push API
 * expects for `applicationServerKey`. The desktop ships the key in the
 * standard form returned by `web-push.generateVAPIDKeys()`.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Allocate a fresh ArrayBuffer (not SharedArrayBuffer) so the resulting
  // view is assignable to BufferSource in the Push API typings.
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; ++i) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

let cachedPublicKey: string | null = null;

async function fetchPublicKey(): Promise<string> {
  if (cachedPublicKey) return cachedPublicKey;
  const { publicKey } = await apiFetch<{ publicKey: string }>('/web-push/public-key');
  cachedPublicKey = publicKey;
  return publicKey;
}

// ---------------------------------------------------------------------------
// Subscription state
// ---------------------------------------------------------------------------

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  try {
    // `ready` waits for the *active* SW; under autoUpdate it resolves to the
    // current one even if a new version is installing.
    return await navigator.serviceWorker.ready;
  } catch (err) {
    console.error('[push] Failed to await SW registration:', err);
    return null;
  }
}

/**
 * Current subscription as held by the SW, or null. Reads from the browser
 * only — does NOT round-trip to the server.
 */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  const reg = await getRegistration();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch (err) {
    console.error('[push] getSubscription failed:', err);
    return null;
  }
}

/**
 * Prompt the user for notification permission if not yet decided. Returns
 * the resulting permission state. Safe to call from a user-gesture handler.
 */
export async function requestPushPermission(): Promise<PushPermission> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch (err) {
    console.error('[push] requestPermission threw:', err);
    return 'denied';
  }
}

// ---------------------------------------------------------------------------
// Subscribe / unsubscribe
// ---------------------------------------------------------------------------

export interface SubscribeResult {
  ok: boolean;
  reason?:
    | 'unsupported'
    | 'permission-denied'
    | 'no-sw'
    | 'subscribe-failed'
    | 'server-failed';
}

/**
 * Idempotent subscribe. Caller should have already pre-validated that
 * (a) the user is paired (auth token present) and (b) it's a good time to
 * ask for permission (e.g. they just opened a session). We re-check
 * permission internally so this is safe to call without a fresh prompt.
 */
export async function subscribeToPush(): Promise<SubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };

  // Bail out early on denied — re-requesting permission after denial is a
  // no-op in every modern browser and confuses the user.
  if (Notification.permission === 'denied') {
    return { ok: false, reason: 'permission-denied' };
  }
  if (Notification.permission === 'default') {
    const granted = await requestPushPermission();
    if (granted !== 'granted') return { ok: false, reason: 'permission-denied' };
  }

  const reg = await getRegistration();
  if (!reg) return { ok: false, reason: 'no-sw' };

  let subscription: PushSubscription | null;
  try {
    subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      const publicKey = await fetchPublicKey();
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
  } catch (err) {
    console.error('[push] subscribe() failed:', err);
    return { ok: false, reason: 'subscribe-failed' };
  }

  // POST the subscription (idempotent server-side via INSERT OR REPLACE on
  // the endpoint UNIQUE index).
  try {
    await apiFetch('/web-push/subscribe', {
      method: 'POST',
      body: subscription.toJSON(),
    });
    return { ok: true };
  } catch (err) {
    console.error('[push] Failed to POST subscription to server:', err);
    return { ok: false, reason: 'server-failed' };
  }
}

/**
 * BDHLNDR-68: convenience helper meant to be fire-and-forgotten from a user
 * gesture (chat-view compose send, one-tap response button, etc.) so that
 * the user is asked for notification permission at the right moment without
 * the caller having to know all the gating rules.
 *
 * Safe to call repeatedly — idempotent across all branches:
 *   - push not supported (no SW, no Push API) → no-op
 *   - not installed via Add-to-Home-Screen on iOS → no-op (push won't work
 *     in browser-tab mode on iOS, so don't waste the user's permission grant)
 *   - permission already granted + subscription exists → no-op
 *   - permission denied → no-op
 *   - permission default + standalone + supported → prompt + subscribe
 */
export async function maybePromptAndSubscribe(): Promise<void> {
  if (!isPushSupported()) return;
  // Inline matchMedia check rather than importing from install-prompt to
  // keep push.ts self-contained and avoid an import cycle.
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true;
  if (!standalone) return;
  if (Notification.permission === 'denied') return;
  // subscribeToPush internally calls requestPushPermission when the state
  // is 'default' — the only place that's safe to do so is inside a user-
  // gesture handler, which is exactly where this helper is meant to be
  // called from.
  await subscribeToPush();
}

/**
 * Best-effort unsubscribe on both ends. Always attempts the browser-side
 * unsubscribe even if the server DELETE fails (orphaning a subscription on
 * the server is far worse than an orphan record — it'd keep pushing to a
 * dead browser).
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;

  const reg = await getRegistration();
  if (!reg) return;

  let endpoint: string | null = null;
  try {
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      endpoint = sub.endpoint;
      await sub.unsubscribe();
    }
  } catch (err) {
    console.error('[push] Browser-side unsubscribe failed:', err);
  }

  try {
    await apiFetch('/web-push/subscribe', {
      method: 'DELETE',
      body: endpoint ? { endpoint } : {},
    });
  } catch (err) {
    // 401 is expected if the caller already cleared auth (e.g. on unpair).
    console.error('[push] Server-side unsubscribe failed:', err);
  }
}
