/**
 * Web Push fan-out dispatcher (BDHLNDR-49).
 *
 * `dispatchAttentionPush()` is invoked from the state-monitor hook in
 * `main/index.ts` whenever a session transitions into a state that needs
 * the user's attention (`waiting` for input, or `error`). It builds the
 * payload, fans out to every registered subscription, prunes endpoints
 * that come back 404/410 (dead browser), and swallows transient errors so
 * one bad endpoint can never block the others.
 *
 * Debouncing:
 *   - Per `sessionId + state` we suppress repeat pushes within
 *     `DEBOUNCE_WINDOW_MS` (30s). Some sessions flap between waiting/idle
 *     while Claude is mid-stream — without debouncing every flicker buzzes
 *     the user's phone.
 *   - The in-memory Map is bounded by `MAX_DEBOUNCE_ENTRIES` with simple
 *     oldest-first eviction so it can't grow unbounded over a long-running
 *     desktop session.
 *
 * Payload contract (consumed by the PWA service worker — keep in sync with
 * `src/pwa/src/sw.ts`):
 *   {
 *     title: string,
 *     body: string,
 *     icon: string,
 *     badge: string,
 *     tag: string,   // sessionId so newer pushes coalesce older ones
 *     data: { sessionId: string, url: string }
 *   }
 */

import log from 'electron-log';
import webpush from 'web-push';
import {
  deleteSubscriptionByEndpoint,
  getAllSubscriptions,
  type PushSubscription as PersistedSubscription,
} from '../../repositories/push-subscriptions';
import { configureWebPush } from './vapid';

export type AttentionState = 'waiting' | 'error';

/** 30s — see module header for rationale. */
const DEBOUNCE_WINDOW_MS = 30_000;
/** Soft cap on the in-memory debounce map. Eviction = oldest entry. */
const MAX_DEBOUNCE_ENTRIES = 256;

/** `sessionId:state` → last-push wall-clock ms. */
const lastPushAt: Map<string, number> = new Map();

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  try {
    configureWebPush();
    configured = true;
  } catch (err) {
    log.error('[web-push] Failed to configure VAPID details:', err);
  }
}

function evictOldestIfFull(): void {
  if (lastPushAt.size < MAX_DEBOUNCE_ENTRIES) return;
  // Map iteration order is insertion order; the first key is the oldest.
  const first = lastPushAt.keys().next().value;
  if (first !== undefined) lastPushAt.delete(first);
}

function shouldDebounce(sessionId: string, state: AttentionState): boolean {
  const key = `${sessionId}:${state}`;
  const last = lastPushAt.get(key);
  const now = Date.now();
  if (last !== undefined && now - last < DEBOUNCE_WINDOW_MS) {
    return true;
  }
  evictOldestIfFull();
  // Re-insert at the tail to refresh insertion order for the eviction policy.
  lastPushAt.delete(key);
  lastPushAt.set(key, now);
  return false;
}

function buildPayload(opts: {
  sessionId: string;
  sessionName: string;
  state: AttentionState;
}): string {
  const { sessionId, sessionName, state } = opts;
  const title = `Bodhilander - ${sessionName}`;
  const body =
    state === 'error'
      ? 'Claude hit an error and is waiting'
      : 'Claude is waiting for your input';

  return JSON.stringify({
    title,
    body,
    icon: '/m/icons/icon-192.png',
    badge: '/m/icons/icon-192.png',
    tag: sessionId,
    data: {
      sessionId,
      url: `/m/sessions/${sessionId}`,
    },
  });
}

interface SendResult {
  endpoint: string;
  ok: boolean;
  status?: number;
  removed?: boolean;
}

async function sendOne(
  sub: PersistedSubscription,
  payload: string,
): Promise<SendResult> {
  const browserSub = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };
  try {
    await webpush.sendNotification(browserSub, payload);
    return { endpoint: sub.endpoint, ok: true };
  } catch (err) {
    // `web-push` throws a `WebPushError` shape with a numeric `statusCode`.
    const status = (err as { statusCode?: number })?.statusCode;
    if (status === 404 || status === 410) {
      // Dead subscription — the browser uninstalled the SW or cleared
      // notification permission. Prune so we stop trying.
      const removed = deleteSubscriptionByEndpoint(sub.endpoint);
      log.info(
        `[web-push] Pruned dead subscription (status ${status}, endpoint hash ${sub.endpoint.slice(-12)}): removed=${removed}`,
      );
      return { endpoint: sub.endpoint, ok: false, status, removed };
    }
    // Anything else (network blip, 429, 5xx) — log and keep going. We'll
    // retry on the next attention event.
    log.warn(
      `[web-push] Send failed (status ${status ?? 'unknown'}):`,
      (err as Error).message ?? err,
    );
    return { endpoint: sub.endpoint, ok: false, status };
  }
}

/**
 * Fan a single attention push out to every persisted subscription.
 *
 * Returns a per-endpoint result array (mostly useful for tests / logging);
 * callers don't need to await it for correctness — failures are logged and
 * dead subscriptions pruned in-place.
 */
export async function dispatchAttentionPush(opts: {
  sessionId: string;
  sessionName: string;
  state: AttentionState;
}): Promise<SendResult[]> {
  if (shouldDebounce(opts.sessionId, opts.state)) {
    return [];
  }

  ensureConfigured();
  if (!configured) {
    // VAPID setup failed earlier — nothing we can do until next launch.
    return [];
  }

  let subs: PersistedSubscription[];
  try {
    subs = getAllSubscriptions();
  } catch (err) {
    log.error('[web-push] Failed to load subscriptions:', err);
    return [];
  }

  if (subs.length === 0) {
    return [];
  }

  const payload = buildPayload(opts);
  log.info(
    `[web-push] Dispatching ${opts.state} push for session ${opts.sessionId} to ${subs.length} subscription(s)`,
  );

  const results = await Promise.all(subs.map((sub) => sendOne(sub, payload)));
  return results;
}

/**
 * Reset the in-memory debounce map. Exported only for tests / dev-tooling.
 */
export function _resetDebounceForTests(): void {
  lastPushAt.clear();
  configured = false;
}
