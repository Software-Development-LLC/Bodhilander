/**
 * Turning notifications on and off, from the browser's side.
 *
 * The refusals get more attention than the happy path on purpose: "denied",
 * "dismissed" and "this browser can't" are three different situations that look
 * identical to a person unless the code tells them apart, and getting that
 * wrong is how a feature becomes "it just doesn't work on my phone".
 */
import { describe, expect, test } from 'bun:test';
import { MACHINE_PREF_KEY } from './account';
import {
  consumePushTarget,
  currentPushState,
  decodeVapidKey,
  disablePush,
  enablePush,
  isPushSupported,
  pushFailureCopy,
  PUSH_TARGET_PARAM,
  subscriptionKeys,
  type PushDeps,
  type PushSubscriptionLike,
} from './push';

const ENDPOINT = 'https://push.example.com/send/abc';
const KEYS = { p256dh: 'BPointBase64Url', auth: 'AuthSecret' };

/**
 * A real-shaped application-server key: 65 bytes, base64url. Length matters —
 * a stand-in like `'test-key'` is not valid base64 and would be rejected by
 * `decodeVapidKey` before the code under test ever got interesting.
 */
const VAPID_KEY = (() => {
  const raw = new Uint8Array(65);
  raw[0] = 4;
  for (let i = 1; i < 65; i++) raw[i] = (i * 11) % 256;
  return Buffer.from(raw).toString('base64url');
})();

function fakeSubscription(over: Partial<PushSubscriptionLike> = {}) {
  const state = { unsubscribed: false };
  const sub: PushSubscriptionLike = {
    endpoint: ENDPOINT,
    toJSON: () => ({ keys: { ...KEYS } }),
    unsubscribe: async () => {
      state.unsubscribed = true;
      return true;
    },
    ...over,
  };
  return { sub, state };
}

interface Harness {
  deps: PushDeps;
  calls: Array<{ path: string; body: unknown }>;
  subscribeCalls: number;
  current: PushSubscriptionLike | null;
}

function harness(
  over: {
    supported?: boolean;
    permission?: NotificationPermission;
    answer?: NotificationPermission;
    existing?: PushSubscriptionLike | null;
    respond?: (path: string) => Response;
    registration?: () => Promise<{ pushManager: PushDeps extends never ? never : any }>;
    subscribeThrows?: boolean;
  } = {},
): Harness {
  const calls: Array<{ path: string; body: unknown }> = [];
  const state = {
    current: over.existing ?? null,
    subscribeCalls: 0,
    permission: over.permission ?? 'default',
  };

  const respond =
    over.respond ??
    ((path: string) =>
      path === '/api/push/vapid-key'
        ? Response.json({ key: VAPID_KEY })
        : new Response(null, { status: 204 }));

  const pushManager = {
    getSubscription: async () => state.current,
    subscribe: async () => {
      state.subscribeCalls += 1;
      if (over.subscribeThrows) throw new Error('permission revoked mid-flight');
      state.current = fakeSubscription().sub;
      return state.current;
    },
  };

  const deps: PushDeps = {
    supported: over.supported ?? true,
    permission: () => state.permission,
    requestPermission: async () => {
      // Faithful to the browser: once a site is blocked, this resolves straight
      // to `denied` and no prompt is ever shown.
      if (state.permission === 'denied') return state.permission;
      state.permission = over.answer ?? 'granted';
      return state.permission;
    },
    registration: over.registration ?? (async () => ({ pushManager })),
    api: async (path, init) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      return respond(path);
    },
  };

  return {
    deps,
    calls,
    get subscribeCalls() {
      return state.subscribeCalls;
    },
    get current() {
      return state.current;
    },
  };
}

describe('isPushSupported', () => {
  test('needs a service worker, a PushManager and Notification', () => {
    expect(isPushSupported({ navigator: { serviceWorker: {} }, PushManager: {}, Notification: {} })).toBe(true);
    // An iPhone tab that has not been added to the Home Screen: service worker
    // yes, PushManager no. Shown as "unsupported", not as a broken toggle.
    expect(isPushSupported({ navigator: { serviceWorker: {} }, Notification: {} })).toBe(false);
    expect(isPushSupported({ PushManager: {}, Notification: {} })).toBe(false);
    expect(isPushSupported({ navigator: { serviceWorker: {} }, PushManager: {} })).toBe(false);
  });
});

describe('decodeVapidKey', () => {
  test('round-trips a real 65-byte application-server key', () => {
    const raw = new Uint8Array(65);
    raw[0] = 4;
    for (let i = 1; i < 65; i++) raw[i] = (i * 7) % 256;
    const b64url = Buffer.from(raw).toString('base64url');
    expect(decodeVapidKey(b64url)).toEqual(raw);
  });

  test('handles the URL-safe alphabet and the missing padding', () => {
    // `-` and `_` are exactly what `atob` cannot take, and 65 bytes never
    // divides into 4, so both branches fire on every real key.
    const withBoth = Buffer.from([0xfb, 0xff, 0xbf, 0x00]).toString('base64url');
    expect(withBoth).toContain('-');
    expect(withBoth).toContain('_');
    expect(decodeVapidKey(withBoth)).toEqual(new Uint8Array([0xfb, 0xff, 0xbf, 0x00]));
    expect(decodeVapidKey(Buffer.from([1, 2, 3, 4, 5]).toString('base64url')).length).toBe(5);
  });
});

describe('subscriptionKeys', () => {
  test('reads both keys out of the browser subscription', () => {
    expect(subscriptionKeys(fakeSubscription().sub)).toEqual(KEYS);
  });

  test('is null when the browser gave us a subscription with no keys', () => {
    expect(subscriptionKeys(fakeSubscription({ toJSON: () => ({ keys: null }) }).sub)).toBeNull();
    expect(subscriptionKeys(fakeSubscription({ toJSON: () => ({ keys: { auth: 'a' } }) }).sub)).toBeNull();
  });
});

describe('currentPushState', () => {
  test('reports what the toggle should show', async () => {
    expect(await currentPushState(harness({ supported: false }).deps)).toBe('unsupported');
    expect(await currentPushState(harness({ permission: 'denied' }).deps)).toBe('denied');
    expect(await currentPushState(harness({ existing: fakeSubscription().sub }).deps)).toBe('on');
    expect(await currentPushState(harness().deps)).toBe('off');
  });

  test('reads as off — not on — when the worker never became ready', async () => {
    const h = harness({ registration: () => Promise.reject(new Error('no active worker')) });
    expect(await currentPushState(h.deps)).toBe('off');
  });
});

describe('enablePush', () => {
  test('asks, subscribes, and registers the subscription with the relay', async () => {
    const h = harness();
    expect(await enablePush(h.deps)).toEqual({ ok: true });
    expect(h.subscribeCalls).toBe(1);
    expect(h.calls.map((c) => c.path)).toEqual(['/api/push/vapid-key', '/api/push/subscribe']);
    expect(h.calls[1]!.body).toEqual({ endpoint: ENDPOINT, keys: KEYS });
  });

  test('does not prompt again when permission is already granted', async () => {
    let asked = 0;
    const h = harness({ permission: 'granted' });
    const deps = { ...h.deps, requestPermission: async () => { asked += 1; return 'granted' as const; } };
    expect(await enablePush(deps)).toEqual({ ok: true });
    expect(asked).toBe(0);
  });

  test('reuses an existing browser subscription instead of minting a second', async () => {
    // Re-subscribing would strand the old endpoint in the relay's table until
    // it happened to come back 410.
    const existing = fakeSubscription().sub;
    const h = harness({ permission: 'granted', existing });
    expect(await enablePush(h.deps)).toEqual({ ok: true });
    expect(h.subscribeCalls).toBe(0);
    expect(h.calls[1]!.body).toEqual({ endpoint: ENDPOINT, keys: KEYS });
  });

  test('a refused prompt and a dismissed one are told apart', async () => {
    expect(await enablePush(harness({ answer: 'denied' }).deps)).toEqual({ ok: false, reason: 'denied' });
    expect(await enablePush(harness({ answer: 'default' }).deps)).toEqual({ ok: false, reason: 'dismissed' });
  });

  test('an already-blocked browser is refused before anything is asked', async () => {
    const h = harness({ permission: 'denied' });
    expect(await enablePush(h.deps)).toEqual({ ok: false, reason: 'denied' });
    expect(h.calls).toEqual([]);
  });

  test('a browser with no push at all is refused first of all', async () => {
    const h = harness({ supported: false });
    expect(await enablePush(h.deps)).toEqual({ ok: false, reason: 'unsupported' });
    expect(h.calls).toEqual([]);
  });

  test('a relay with push switched off says so, without subscribing', async () => {
    const h = harness({ respond: () => new Response(null, { status: 503 }) });
    expect(await enablePush(h.deps)).toEqual({ ok: false, reason: 'unavailable' });
    expect(h.subscribeCalls).toBe(0);
  });

  test('an empty key is treated as unavailable rather than passed to subscribe', async () => {
    const h = harness({ respond: () => Response.json({}) });
    expect(await enablePush(h.deps)).toEqual({ ok: false, reason: 'unavailable' });
    expect(h.subscribeCalls).toBe(0);
  });

  test('rolls the browser subscription back when the relay will not keep it', async () => {
    const created = fakeSubscription();
    const h = harness({
      respond: (path) =>
        path === '/api/push/vapid-key' ? Response.json({ key: VAPID_KEY }) : new Response(null, { status: 409 }),
    });
    // Swap in a subscription we can watch being undone.
    const deps: PushDeps = {
      ...h.deps,
      registration: async () => ({
        pushManager: {
          getSubscription: async () => null,
          subscribe: async () => created.sub,
        },
      }),
    };
    expect(await enablePush(deps)).toEqual({ ok: false, reason: 'failed' });
    // Otherwise the browser holds a subscription nothing will ever send to,
    // and the toggle would sit there saying "on".
    expect(created.state.unsubscribed).toBe(true);
  });

  test('leaves a pre-existing subscription alone when registration fails', async () => {
    const existing = fakeSubscription();
    const h = harness({
      permission: 'granted',
      existing: existing.sub,
      respond: (path) =>
        path === '/api/push/vapid-key' ? Response.json({ key: VAPID_KEY }) : new Response(null, { status: 500 }),
    });
    expect(await enablePush(h.deps)).toEqual({ ok: false, reason: 'failed' });
    // It was not ours to undo — another tab or an earlier session made it.
    expect(existing.state.unsubscribed).toBe(false);
  });

  test('a browser that throws mid-subscribe is a plain failure, not a crash', async () => {
    const h = harness({ permission: 'granted', subscribeThrows: true });
    expect(await enablePush(h.deps)).toEqual({ ok: false, reason: 'failed' });
  });

  test('a network failure fetching the key is unavailable, not failed', async () => {
    const h = harness();
    const deps: PushDeps = { ...h.deps, api: () => Promise.reject(new TypeError('offline')) };
    expect(await enablePush(deps)).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('disablePush', () => {
  test('tells the relay first, then drops the browser subscription', async () => {
    const existing = fakeSubscription();
    const h = harness({ permission: 'granted', existing: existing.sub });
    expect(await disablePush(h.deps)).toBe(true);
    expect(h.calls.map((c) => c.path)).toEqual(['/api/push/unsubscribe']);
    expect(h.calls[0]!.body).toEqual({ endpoint: ENDPOINT });
    expect(existing.state.unsubscribed).toBe(true);
  });

  test('still drops the local subscription when the relay is unreachable', async () => {
    // The opposite order would leave the relay sealing payloads for a browser
    // that has thrown away the key to read them.
    const existing = fakeSubscription();
    const h = harness({ permission: 'granted', existing: existing.sub });
    const deps: PushDeps = { ...h.deps, api: () => Promise.reject(new TypeError('offline')) };
    expect(await disablePush(deps)).toBe(true);
    expect(existing.state.unsubscribed).toBe(true);
  });

  test('is a quiet success when there was nothing subscribed', async () => {
    const h = harness({ permission: 'granted' });
    expect(await disablePush(h.deps)).toBe(true);
    expect(h.calls).toEqual([]);
  });

  test('is a no-op in a browser that never supported push', async () => {
    const h = harness({ supported: false });
    expect(await disablePush(h.deps)).toBe(true);
    expect(h.calls).toEqual([]);
  });
});

describe('consumePushTarget', () => {
  function stores() {
    const written: Array<[string, string]> = [];
    const replaced: string[] = [];
    return {
      written,
      replaced,
      storage: { setItem: (k: string, v: string) => { written.push([k, v]); } },
      replace: (url: string) => { replaced.push(url); },
    };
  }

  test('adopts the machine the notification named and strips it from the URL', () => {
    const s = stores();
    const id = consumePushTarget({ search: `?${PUSH_TARGET_PARAM}=machine-7`, pathname: '/', ...s });
    expect(id).toBe('machine-7');
    expect(s.written).toEqual([[MACHINE_PREF_KEY, 'machine-7']]);
    // Left in place, `?m=` would re-pin that machine on every later refresh,
    // quietly overriding a switch made afterwards.
    expect(s.replaced).toEqual(['/']);
  });

  test('does nothing to an ordinary visit', () => {
    const s = stores();
    expect(consumePushTarget({ search: '', pathname: '/', ...s })).toBeNull();
    expect(s.written).toEqual([]);
    expect(s.replaced).toEqual([]);
  });

  test('leaves an invite link alone', () => {
    const s = stores();
    expect(consumePushTarget({ search: '?ref=email', pathname: '/i/ABCD-EFGH', ...s })).toBeNull();
    expect(s.replaced).toEqual([]);
  });

  test('decodes an escaped id', () => {
    const s = stores();
    expect(consumePushTarget({ search: '?m=a%20b%26c', pathname: '/', ...s })).toBe('a b&c');
  });
});

describe('pushFailureCopy', () => {
  test('says something different, and actionable, for every refusal', () => {
    const reasons = ['denied', 'dismissed', 'unsupported', 'unavailable', 'failed'] as const;
    const lines = reasons.map(pushFailureCopy);
    expect(new Set(lines).size).toBe(reasons.length);
    for (const line of lines) expect(line.length).toBeGreaterThan(20);
    // The one a person can only fix outside the app must point them there.
    expect(pushFailureCopy('denied')).toContain('site settings');
    // And the iOS case has to name the actual step.
    expect(pushFailureCopy('unsupported')).toContain('Home Screen');
  });
});
