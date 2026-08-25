/**
 * Turning notifications on and off in the browser. Apart from main.ts for the
 * reason account.ts is: main.ts imports xterm and boots on import, so nothing
 * in it is reachable from a test.
 */

// Browser surfaces arrive as arguments rather than globals, so the whole flow —
// the refusals included, which are what a person actually meets — is testable.
//
// This file does NOT compose the notification. The agent seals every payload
// against the keys created here and the relay forwards ciphertext (§10).

import { MACHINE_PREF_KEY } from './account';

/** The query parameters a notification tap arrives with. */
export const PUSH_TARGET_PARAM = 'm';
export const PUSH_SESSION_PARAM = 's';

export type PushState = 'unsupported' | 'denied' | 'on' | 'off';

/** Where a tapped notification wants the client to land. */
export interface PushTarget {
  machineId: string;
  /** The session it was about, when the payload named one. */
  sessionId: string | null;
}

export type PushFailure = 'unsupported' | 'denied' | 'dismissed' | 'unavailable' | 'too_many' | 'failed';

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
  /** Shortened in tests; see `REGISTRATION_TIMEOUT_MS`. */
  registrationTimeoutMs?: number;
}

/**
 * Whether push is available at all here. iOS is why this checks rather than
 * assumes: Safari exposes `PushManager` only to a page installed to the Home
 * Screen, so a plain tab needs telling, not a toggle that cannot work.
 */
export function isPushSupported(scope: {
  navigator?: { serviceWorker?: unknown };
  PushManager?: unknown;
  Notification?: unknown;
}): boolean {
  return !!scope.navigator?.serviceWorker && !!scope.PushManager && !!scope.Notification;
}

/**
 * The base64url application-server key as the bytes `subscribe()` wants. The
 * value arrives base64URL and `atob` speaks base64, so the alphabet is
 * translated and the padding put back rather than hoped for.
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

/**
 * How long to wait for the service worker. `serviceWorker.ready` never REJECTS,
 * so a worker that fails to register leaves it pending forever — raced rather
 * than caught, because there is nothing to catch.
 */
export const REGISTRATION_TIMEOUT_MS = 4000;

/** Sentinel for the race below; never returned to a caller. */
const TIMED_OUT = Symbol('registration timed out');

/** What the toggle should show right now. */
export async function currentPushState(deps: PushDeps): Promise<PushState> {
  if (!deps.supported) return 'unsupported';
  if (deps.permission() === 'denied') return 'denied';
  try {
    const registration = await Promise.race([
      deps.registration(),
      new Promise<typeof TIMED_OUT>((resolve) =>
        setTimeout(() => resolve(TIMED_OUT), deps.registrationTimeoutMs ?? REGISTRATION_TIMEOUT_MS),
      ),
    ]);
    // No worker, so nothing can arrive. Offered as "off" rather than "on":
    // /sw.js can 404 mid-deploy, the first load can be offline, or the browser
    // can refuse registration outright.
    if (registration === TIMED_OUT) return 'off';
    return (await registration.pushManager.getSubscription()) ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/**
 * Ask for permission if needed, subscribe, and register it. Must be called
 * from a user gesture (`requestPermission()` is ignored otherwise), which is
 * why this is wired to the toggle and to nothing else.
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
      // 409 is the per-account device cap. Telling someone to check their
      // connection would send them round a loop that can never clear.
      return { ok: false, reason: res.status === 409 ? 'too_many' : 'failed' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Drop this browser's subscription, at the relay FIRST. Reversed, a failure
 * between the two leaves a row the relay keeps sealing payloads for while the
 * browser has already thrown away the key to read them.
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
 * A notification tap names the machine it came from: adopt it, then strip it
 * from the URL. Left in place, `?m=` would re-pin that machine on every later
 * refresh, quietly overriding a switch the person made afterwards.
 */
export function consumePushTarget(ctx: {
  search: string;
  pathname: string;
  storage: Pick<Storage, 'setItem'>;
  replace: (url: string) => void;
}): PushTarget | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(ctx.search);
  } catch {
    return null;
  }
  const machineId = params.get(PUSH_TARGET_PARAM);
  if (!machineId) return null;
  const sessionId = params.get(PUSH_SESSION_PARAM);

  ctx.storage.setItem(MACHINE_PREF_KEY, machineId);
  // Only OUR parameters are removed. Rewriting to the bare pathname would throw
  // away anything else the link carried, which is not this function's to drop.
  params.delete(PUSH_TARGET_PARAM);
  params.delete(PUSH_SESSION_PARAM);
  const rest = params.toString();
  ctx.replace(rest ? `${ctx.pathname}?${rest}` : ctx.pathname);
  return { machineId, sessionId };
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
    case 'too_many':
      return 'You’ve got notifications on for as many browsers as this account allows. Turn them off on a device you no longer use, then try again.';
    default:
      return 'Couldn’t turn notifications on. Check your connection and try again.';
  }
}
