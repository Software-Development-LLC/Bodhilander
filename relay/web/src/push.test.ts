/**
 * Notifications on and off, from the browser's side. The refusals get more
 * attention than the happy path: "denied", "dismissed" and "this browser
 * can't" look identical unless the code tells them apart.
 */
import { describe, expect, test } from 'bun:test';
import { MACHINE_PREF_KEY } from './account';
import {
  applySwitchView,
  PUSH_STATE_NOTE,
  switchView,
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

  test.each([
    ['enablePush', (d: PushDeps) => enablePush(d)],
    ['disablePush', (d: PushDeps) => disablePush(d)],
  ])('%s settles too, rather than hanging on a worker that never arrives', async (_label, run) => {
    // Every caller goes through the bounded helper. `disablePush` matters most:
    // sign-out awaits it BEFORE ending the session, so an unbounded wait here
    // puts a hang in front of the security-relevant act.
    const h = harness({ permission: 'granted', registration: () => new Promise(() => {}) });
    const started = Date.now();
    const result = await run({ ...h.deps, registrationTimeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).not.toEqual({ ok: true });
  });

  test('settles even though serviceWorker.ready never rejects OR resolves', async () => {
    // This is the real failure — /sw.js 404s mid-deploy, or the first load is
    // offline. `ready` is specified never to reject, so it simply hangs, and a
    // control that never settles reads as a hung app.
    const h = harness({ registration: () => new Promise(() => {}) });
    const started = Date.now();
    expect(await currentPushState({ ...h.deps, registrationTimeoutMs: 30 })).toBe('off');
    expect(Date.now() - started).toBeLessThan(1000);
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

  test('a full device list is told what to do about it, not to retry', async () => {
    const h = harness({
      permission: 'granted',
      respond: (path) =>
        path === '/api/push/vapid-key' ? Response.json({ key: VAPID_KEY }) : new Response(null, { status: 409 }),
    });
    // "Check your connection and try again" sends someone round a loop that
    // can never clear.
    expect(await enablePush(h.deps)).toEqual({ ok: false, reason: 'too_many' });
    expect(pushFailureCopy('too_many')).toContain('Turn them off');
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
        path === '/api/push/vapid-key' ? Response.json({ key: VAPID_KEY }) : new Response(null, { status: 500 }),
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
    const target = consumePushTarget({ search: `?${PUSH_TARGET_PARAM}=machine-7`, pathname: '/', ...s });
    expect(target).toEqual({ machineId: 'machine-7', sessionId: null });
    expect(s.written).toEqual([[MACHINE_PREF_KEY, 'machine-7']]);
    // Left in place, `?m=` would re-pin that machine on every later refresh,
    // quietly overriding a switch made afterwards.
    expect(s.replaced).toEqual(['/']);
  });

  test('carries the session the notification was about', () => {
    const s = stores();
    // Landing on the right machine and then hunting for the session that woke
    // you is half an answer.
    expect(consumePushTarget({ search: '?m=machine-7&s=sess-42', pathname: '/', ...s })).toEqual({
      machineId: 'machine-7',
      sessionId: 'sess-42',
    });
  });

  test('strips only its OWN parameters, keeping the rest of the query', () => {
    const s = stores();
    consumePushTarget({ search: '?utm=email&m=machine-7&s=sess-42&debug=1', pathname: '/', ...s });
    // Rewriting to the bare pathname would drop everything else the link
    // carried, which is not this function's to throw away.
    expect(s.replaced).toEqual(['/?utm=email&debug=1']);
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
    expect(consumePushTarget({ search: '?m=a%20b%26c', pathname: '/', ...s })?.machineId).toBe('a b&c');
  });
});

describe('pushFailureCopy', () => {
  test('says something different, and actionable, for every refusal', () => {
    const reasons = ['denied', 'dismissed', 'unsupported', 'unavailable', 'too_many', 'failed'] as const;
    const lines = reasons.map(pushFailureCopy);
    expect(new Set(lines).size).toBe(reasons.length);
    for (const line of lines) expect(line.length).toBeGreaterThan(20);
    // The one a person can only fix outside the app must point them there.
    expect(pushFailureCopy('denied')).toContain('site settings');
    // And the iOS case has to name the actual step.
    expect(pushFailureCopy('unsupported')).toContain('Home Screen');
  });
});

describe('switchView', () => {
  test('reflects on and off, and stays operable in both', () => {
    expect(switchView('on')).toEqual({ checked: true, inert: false, note: PUSH_STATE_NOTE.on, stale: false });
    expect(switchView('off')).toEqual({ checked: false, inert: false, note: PUSH_STATE_NOTE.off, stale: false });
  });

  test.each(['denied', 'unsupported'] as const)('is inert but never checked for %s', (state) => {
    const view = switchView(state);
    expect(view.inert).toBe(true);
    expect(view.checked).toBe(false);
    // Inert is expressed with aria-disabled, not the native attribute: a
    // disabled button takes no focus, so the person who most needs the
    // sentence below could never reach it.
    expect(view.note).toBe(PUSH_STATE_NOTE[state]);
  });

  test('warns about a desktop too old to send, but only while notifications are on', () => {
    expect(switchView('on', { pushCapable: false }).stale).toBe(true);
    expect(switchView('off', { pushCapable: false }).stale).toBe(false);
    // Null is "the machine is offline, we do not know" — not a problem to raise.
    expect(switchView('on', { pushCapable: null }).stale).toBe(false);
    expect(switchView('on', { pushCapable: true }).stale).toBe(false);
  });

  test('an explicit note wins over the state copy', () => {
    expect(switchView('off', { note: 'Asking your browser…' }).note).toBe('Asking your browser…');
  });
});

// A DOM, however it can be had. The ROOT suite preloads happy-dom via
// bunfig.toml; the relay suite also runs standalone from `relay/`, where it does
// not — so it is registered here rather than assumed, and the block skips
// honestly if it cannot be.
let hasDom = typeof document !== 'undefined';
if (!hasDom) {
  try {
    const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
    GlobalRegistrator.register();
    hasDom = typeof document !== 'undefined';
  } catch {
    hasDom = false;
  }
}

describe.skipIf(!hasDom)('the notifications control, driven as rendered', () => {
  /** The switch exactly as `notificationsSection()` emits it. */
  function render() {
    document.body.innerHTML = `
      <button class="switch" id="pushToggle" role="switch" aria-checked="false" aria-labelledby="pushLabel"
        aria-disabled="true" aria-busy="true"><span class="track"></span></button>
      <div class="pref-note" id="pushNote" role="status">Checking…</div>
      <div class="banner warn hidden" id="pushStale"></div>`;
    return document.getElementById('pushToggle') as HTMLButtonElement;
  }

  /** Exactly what `paintNotifications` runs — the real function, not a copy. */
  function paint(toggle: HTMLButtonElement, state: Parameters<typeof switchView>[0]) {
    applySwitchView(
      {
        toggle,
        note: document.getElementById('pushNote')!,
        stale: document.getElementById('pushStale'),
      },
      switchView(state),
    );
  }

  test('a paint re-enables a control left disabled by an in-flight tap', () => {
    // The regression this pins. The handler sets `disabled` while the request
    // is in flight; if a paint does not clear it the control is dead for good,
    // because a `<button disabled>` fires no click and takes no focus.
    const toggle = render();
    toggle.disabled = true; // mid-tap: "Asking your browser…"

    paint(toggle, 'off');

    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-disabled')).toBe('false');
    let clicks = 0;
    toggle.onclick = () => { clicks += 1; };
    toggle.click();
    expect(clicks).toBe(1);
  });

  test('the rendered markup itself never ships the native disabled attribute', () => {
    const toggle = render();
    expect(toggle.hasAttribute('disabled')).toBe(false);
    expect(toggle.getAttribute('aria-disabled')).toBe('true'); // until the first paint
  });

  test('stays focusable and clickable even when inert, so the reason can be read', () => {
    const toggle = render();
    toggle.disabled = true;
    paint(toggle, 'denied');
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    // Not the native attribute — that is what would hide the explanation from
    // a screen reader.
    expect(toggle.disabled).toBe(false);
  });
});
