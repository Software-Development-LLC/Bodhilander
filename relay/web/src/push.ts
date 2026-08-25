/**
 * Turning notifications on and off in the browser.
 *
 * Lives apart from main.ts for the same reason account.ts does: main.ts pulls in
 * xterm and runs boot() at import time, so nothing in it is reachable from a
 * unit test. Everything here takes its browser surfaces as arguments instead of
 * reaching for globals, so the whole flow — including the refusals, which are
 * the parts a person actually meets — can be driven in a test.
 *
 * What this file does NOT do is compose the notification. The desktop agent
 * seals every payload against the keys created here, and the relay forwards
 * ciphertext; the text a person reads is written on their own machine and is
 * unreadable to everything in between (design §10).
 */

import { MACHINE_PREF_KEY } from './account';

/** Remembers the last known answer so the toggle renders without a round trip. */
export const PUSH_HINT_KEY = 'bodhi.push';

/** The query parameter a notification tap arrives with. */
export const PUSH_TARGET_PARAM = 'm';

export type PushState = 'unsupported' | 'denied' | 'on' | 'off';

export type PushFailure = 'unsupported' | 'denied' | 'dismissed' | 'unavailable' | 'failed';

export type PushResult = { ok: true } | { ok: false; reason: PushFailure };

/** The bits of `PushSubscription` this module uses. */
export interface PushSubscriptionLike {
  endpoint: string;
  toJSON(): { keys?: { p256dh?: string; auth?: string } | null };
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
}

export interface PushDeps {
  /** Whether this browser has a service worker, a PushManager and Notification. */
  supported: boolean;
  permission: () => NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  /** Resolves once the worker registered in main.ts is active. */
  registration: () => Promise<{ pushManager: PushManagerLike }>;
  api: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Whether push is available at all in this browser.
 *
 * All three are needed and iOS is the reason to check rather than assume: Safari
 * exposes `PushManager` only to a page installed to the Home Screen, so a plain
 * tab must be told that rather than shown a toggle that cannot work.
 */
export function isPushSupported(scope: {
  navigator?: { serviceWorker?: unknown };
  PushManager?: unknown;
  Notification?: unknown;
}): boolean {
  return !!scope.navigator?.serviceWorker && !!scope.PushManager && !!scope.Notification;
}

/**
 * The base64url application-server key, as the bytes `subscribe()` wants.
 *
 * `PushManager.subscribe` predates browsers accepting a string here, and the
 * value arrives base64URL while `atob` speaks base64 — so the alphabet is
 * translated and the padding put back rather than hoping.
 */
export function decodeVapidKey(key: string): Uint8Array {
  const padded = key.padEnd(key.length + ((4 - (key.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The two keys the agent seals to, or null if the browser gave us neither. */
export function subscriptionKeys(sub: PushSubscriptionLike): { p256dh: string; auth: string } | null {
  const keys = sub.toJSON().keys;
  if (!keys?.p256dh || !keys.auth) return null;
  return { p256dh: keys.p256dh, auth: keys.auth };
}

/** What the toggle should show right now. */
export async function currentPushState(deps: PushDeps): Promise<PushState> {
  if (!deps.supported) return 'unsupported';
  if (deps.permission() === 'denied') return 'denied';
  try {
    const registration = await deps.registration();
    return (await registration.pushManager.getSubscription()) ? 'on' : 'off';
  } catch {
    // A worker that never activated. Not a permission problem, and offering the
    // toggle is more honest than showing "on" for something that cannot arrive.
    return 'off';
  }
}

/**
 * Ask for permission if needed, subscribe, and register the subscription.
 *
 * Must be called from a user gesture — `requestPermission()` is ignored
 * otherwise — which is why this is wired to the toggle and to nothing else.
 */
export async function enablePush(deps: PushDeps): Promise<PushResult> {
  if (!deps.supported) return { ok: false, reason: 'unsupported' };

  // Short-circuited rather than left to `requestPermission()`, which resolves
  // straight to `denied` without prompting once a site is blocked. Stating it
  // here means the branch reads as the decision it is, instead of resting on a
  // browser behaviour a reader has to already know.
  if (deps.permission() === 'denied') return { ok: false, reason: 'denied' };

  if (deps.permission() !== 'granted') {
    const answer = await deps.requestPermission();
    if (answer === 'denied') return { ok: false, reason: 'denied' };
    // `default` means the prompt was dismissed rather than refused. Told apart
    // because the two need different words: one is recoverable by asking again,
    // the other needs a trip into browser settings.
    if (answer !== 'granted') return { ok: false, reason: 'dismissed' };
  }

  let key: string;
  try {
    const res = await deps.api('/api/push/vapid-key');
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    key = ((await res.json()) as { key?: string }).key ?? '';
    if (!key) return { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  try {
    const registration = await deps.registration();
    const existing = await registration.pushManager.getSubscription();
    // Reuse rather than re-subscribe: a fresh subscription would strand the old
    // endpoint in the relay's table until it happened to come back 410.
    const sub =
      existing ??
      (await registration.pushManager.subscribe({
        // Required by Chrome, and true of us anyway: every push we send shows a
        // notification. A silent push would be a promise we are not keeping.
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(key),
      }));

    const keys = subscriptionKeys(sub);
    if (!keys) return { ok: false, reason: 'failed' };

    const res = await deps.api('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, keys }),
    });
    if (!res.ok) {
      // The relay would not keep it, so neither do we — otherwise the browser
      // holds a subscription nothing will ever send to and the toggle lies.
      if (!existing) await sub.unsubscribe().catch(() => false);
      return { ok: false, reason: 'failed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Drop this browser's subscription, locally and at the relay.
 *
 * The relay is told FIRST. If the order were reversed, a failure between the
 * two would leave a row the relay keeps sealing payloads for while the browser
 * has already thrown away the key to read them.
 */
export async function disablePush(deps: PushDeps): Promise<boolean> {
  if (!deps.supported) return true;
  try {
    const registration = await deps.registration();
    const sub = await registration.pushManager.getSubscription();
    if (!sub) return true;

    await deps
      .api('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      })
      .catch(() => undefined);

    return await sub.unsubscribe();
  } catch {
    return false;
  }
}

/**
 * A notification tap names the machine it came from. Adopt it as the current
 * machine and strip it from the URL.
 *
 * Stripping matters: leaving `?m=` in place would re-pin that machine on every
 * later refresh of what is now just "the app", quietly overriding a switch the
 * person made afterwards.
 */
export function consumePushTarget(ctx: {
  search: string;
  pathname: string;
  storage: Pick<Storage, 'setItem'>;
  replace: (url: string) => void;
}): string | null {
  let machineId: string | null;
  try {
    machineId = new URLSearchParams(ctx.search).get(PUSH_TARGET_PARAM);
  } catch {
    return null;
  }
  if (!machineId) return null;

  ctx.storage.setItem(MACHINE_PREF_KEY, machineId);
  ctx.replace(ctx.pathname);
  return machineId;
}

/** Copy for every way enabling can fail. Never guesses, never blames. */
export function pushFailureCopy(reason: PushFailure): string {
  switch (reason) {
    case 'denied':
      return 'Your browser is blocking notifications for this site. Allow them in its site settings, then try again.';
    case 'dismissed':
      return 'No answer to the permission prompt yet — tap again when you’re ready to allow notifications.';
    case 'unsupported':
      return 'This browser can’t do push here. On iPhone or iPad, add Bodhilander to your Home Screen first.';
    case 'unavailable':
      return 'This relay isn’t set up for notifications yet.';
    default:
      return 'Couldn’t turn notifications on. Check your connection and try again.';
  }
}
