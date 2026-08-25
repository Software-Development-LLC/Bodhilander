/**
 * The hand-written service worker (../sw.js), run in a mocked worker scope
 * with synthetic install/activate/fetch events dispatched at it.
 * Run with: bun test relay/web/src/sw.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SW_SOURCE = readFileSync(path.join(import.meta.dir, '..', 'sw.js'), 'utf8');
const ORIGIN = 'https://relay.test';
const CACHE = 'bodhi-shell-v2';

interface FakeRequest { url: string; method: string; mode: string; }
type FetchImpl = (req: FakeRequest) => Promise<Response>;

const req = (p: string, over: Partial<FakeRequest> = {}): FakeRequest => ({
  url: over.url ?? `${ORIGIN}${p}`,
  method: over.method ?? 'GET',
  mode: over.mode ?? 'no-cors',
});

const offline: FetchImpl = () => Promise.reject(new TypeError('network down'));

function loadWorker(fetchImpl: FetchImpl) {
  const listeners = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, Response>>();

  // Cache keys normalize to pathname so `put(request)` and `match('/path')`
  // land on the same entry, as they do in a real cache for same-origin URLs.
  const keyOf = (k: string | FakeRequest) => new URL(typeof k === 'string' ? new URL(k, ORIGIN) : k.url).pathname;
  const cacheFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      addAll: async (paths: string[]) => { for (const p of paths) store.set(keyOf(p), new Response(`precached ${p}`)); },
      put: async (r: FakeRequest, res: Response) => { store.set(keyOf(r), res); },
      match: async (key: string | FakeRequest) => store.get(keyOf(key)),
    };
  };
  const caches = {
    open: async (name: string) => cacheFor(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (key: string | FakeRequest) => {
      for (const store of stores.values()) { const hit = store.get(keyOf(key)); if (hit) return hit; }
      return undefined;
    },
  };

  let skipWaitingCalls = 0;
  let claimCalls = 0;
  // What the worker showed, and what it did with a tap. Recorded rather than
  // asserted through a spy so the shape the platform sees is what's checked.
  const shown: Array<{ title: string; options: Record<string, any> }> = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  let windows: Array<Record<string, any>> = [];

  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => { skipWaitingCalls++; },
    registration: {
      showNotification: async (title: string, options: Record<string, any>) => { shown.push({ title, options }); },
    },
  };
  const clients = {
    claim: () => { claimCalls++; },
    matchAll: async () => windows,
    openWindow: async (url: string) => { opened.push(url); return { url }; },
  };
  new Function('self', 'caches', 'clients', 'fetch', SW_SOURCE)(self, caches, clients, fetchImpl);

  async function dispatch(type: string, event: Record<string, unknown> = {}): Promise<Response | null> {
    const settled: Promise<unknown>[] = [];
    let responded: Promise<Response | undefined> | null = null;
    listeners.get(type)!({
      waitUntil: (p: Promise<unknown>) => settled.push(p),
      respondWith: (p: Response | Promise<Response | undefined>) => { responded = Promise.resolve(p); },
      ...event,
    });
    const res = responded ? await responded : null;
    await Promise.all(settled);
    return res ?? null;
  }
  /** A window client the worker can find, focus and navigate. */
  function addWindow(url: string, over: Record<string, any> = {}) {
    const win: Record<string, any> = {
      url,
      focused: false,
      focus: async () => { win.focused = true; return win; },
      navigate: async (to: string) => { navigated.push(to); return win; },
      ...over,
    };
    windows.push(win);
    return win;
  }

  return {
    dispatch,
    stores,
    skipWaitingCalls: () => skipWaitingCalls,
    claimCalls: () => claimCalls,
    shown,
    opened,
    navigated,
    addWindow,
    clearWindows: () => { windows = []; },
  };
}

/** A `push` event carrying `payload` as its JSON data. */
function pushEvent(payload: unknown) {
  return { data: { json: () => structuredClone(payload) } };
}

/** A `notificationclick` event, recording whether the notification was closed. */
function clickEvent(data: unknown) {
  const closed = { count: 0 };
  return {
    event: { notification: { data, close: () => { closed.count++; } } },
    closed,
  };
}

describe('service worker', () => {
  test('install precaches the app shell and the offline page', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('install');
    const store = sw.stores.get(CACHE)!;
    for (const p of ['/', '/app/main.js', '/app/main.css', '/offline.html']) expect(store.has(p)).toBe(true);
  });

  test('a navigation goes to the network first', async () => {
    const sw = loadWorker(() => Promise.resolve(new Response('live shell')));
    await sw.dispatch('install');
    const res = await sw.dispatch('fetch', { request: req('/', { mode: 'navigate' }) });
    expect(await res!.text()).toBe('live shell');
  });

  test('a failed navigation gets the branded offline page, wherever it aimed', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('install');
    for (const p of ['/', '/i/SOME-CODE']) {
      const res = await sw.dispatch('fetch', { request: req(p, { mode: 'navigate' }) });
      expect(await res!.clone().text()).toBe('precached /offline.html');
    }
  });

  test('shell assets fall back to the precache when the network is down', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('install');
    const res = await sw.dispatch('fetch', { request: req('/app/main.js') });
    expect(await res!.text()).toBe('precached /app/main.js');
  });

  test('a successful shell fetch refreshes the cached copy', async () => {
    const sw = loadWorker(() => Promise.resolve(new Response('v2')));
    await sw.dispatch('install');
    const res = await sw.dispatch('fetch', { request: req('/app/main.css') });
    expect(await res!.text()).toBe('v2');
    const cached = sw.stores.get(CACHE)!.get('/app/main.css')!;
    expect(await cached.text()).toBe('v2');
  });

  test('API, websocket, cross-origin and non-GET requests are never touched', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('install');
    const untouched = [
      req('/api/machines'),
      req('/api/me'),
      req('/ws/client'),
      req('/auth/github/login'),
      req('/', { method: 'POST', mode: 'navigate' }),
      req('/app/main.js', { url: 'https://evil.test/app/main.js' }),
    ];
    for (const request of untouched) {
      expect(await sw.dispatch('fetch', { request })).toBeNull();
    }
  });

  test('a shell response that is not ok is never cached', async () => {
    // A transient 502 from a proxy, or a 404 mid-deploy, must not become the
    // app shell that gets served back once the relay recovers.
    const sw = loadWorker(() => Promise.resolve(new Response('gateway down', { status: 502 })));
    await sw.dispatch('install');
    const res = await sw.dispatch('fetch', { request: req('/app/main.js') });
    expect(res!.status).toBe(502);
    const cached = sw.stores.get(CACHE)!.get('/app/main.js')!;
    expect(await cached.text()).toBe('precached /app/main.js');
  });

  test('activate drops caches from older worker versions only', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('install');
    sw.stores.set('bodhi-shell-v1', new Map());
    await sw.dispatch('activate');
    expect([...sw.stores.keys()]).toEqual([CACHE]);
  });

  test('an update never seizes live pages: no skipWaiting, no clients.claim', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('install');
    await sw.dispatch('activate');
    expect(sw.skipWaitingCalls()).toBe(0);
    expect(sw.claimCalls()).toBe(0);
  });
});

describe('web push', () => {
  const payload = {
    title: 'deploy-prod',
    body: 'Waiting for your input',
    tag: 's-42',
    machineId: 'machine-7',
    sessionId: 's-42',
  };

  test('shows the session name the agent sealed into the payload', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('push', pushEvent(payload));
    expect(sw.shown.length).toBe(1);
    expect(sw.shown[0]!.title).toBe('deploy-prod');
    expect(sw.shown[0]!.options.body).toBe('Waiting for your input');
    expect(sw.shown[0]!.options.data).toEqual({ machineId: 'machine-7', sessionId: 's-42' });
  });

  test('tags per session so a newer alert replaces the older one, and still buzzes', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('push', pushEvent(payload));
    expect(sw.shown[0]!.options.tag).toBe('s-42');
    expect(sw.shown[0]!.options.renotify).toBe(true);
  });

  test('still shows something when the payload is unreadable', async () => {
    // A worker that takes a push and shows nothing gets killed by the platform,
    // and repeat offences cost the site its notification permission.
    const sw = loadWorker(offline);
    await sw.dispatch('push', {
      data: { json: () => { throw new SyntaxError('not json'); } },
    });
    expect(sw.shown.length).toBe(1);
    expect(sw.shown[0]!.title).toBe('A session needs you');
  });

  test('still shows something when there is no payload at all', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('push', { data: null });
    expect(sw.shown.length).toBe(1);
    expect(sw.shown[0]!.title).toBe('A session needs you');
  });

  test('ignores non-string fields rather than rendering them', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('push', pushEvent({ title: 42, body: { a: 1 }, machineId: ['x'] }));
    expect(sw.shown[0]!.title).toBe('A session needs you');
    expect(sw.shown[0]!.options.body).toBe('Open Bodhilander to take a look.');
    expect(sw.shown[0]!.options.data).toEqual({ machineId: null, sessionId: null });
  });
});

describe('tapping a notification', () => {
  test('opens a window aimed at the right machine when nothing is open', async () => {
    const sw = loadWorker(offline);
    const { event, closed } = clickEvent({ machineId: 'machine-7' });
    await sw.dispatch('notificationclick', event);
    expect(closed.count).toBe(1);
    expect(sw.opened).toEqual(['/?m=machine-7']);
  });

  test('focuses an existing window and steers it, rather than piling up tabs', async () => {
    const sw = loadWorker(offline);
    const win = sw.addWindow(`${ORIGIN}/`);
    const { event } = clickEvent({ machineId: 'machine-7' });
    await sw.dispatch('notificationclick', event);
    expect(win.focused).toBe(true);
    expect(sw.navigated).toEqual(['/?m=machine-7']);
    expect(sw.opened).toEqual([]);
  });

  test('falls back to a new window when the open one refuses to navigate', async () => {
    const sw = loadWorker(offline);
    sw.addWindow(`${ORIGIN}/`, { navigate: async () => { throw new Error('not controlled'); } });
    const { event } = clickEvent({ machineId: 'machine-7' });
    await sw.dispatch('notificationclick', event);
    expect(sw.opened).toEqual(['/?m=machine-7']);
  });

  test('ignores windows from another origin', async () => {
    const sw = loadWorker(offline);
    sw.addWindow('https://elsewhere.test/');
    const { event } = clickEvent({ machineId: 'machine-7' });
    await sw.dispatch('notificationclick', event);
    expect(sw.navigated).toEqual([]);
    expect(sw.opened).toEqual(['/?m=machine-7']);
  });

  test('opens the home page when the payload named no machine', async () => {
    const sw = loadWorker(offline);
    const { event } = clickEvent({});
    await sw.dispatch('notificationclick', event);
    expect(sw.opened).toEqual(['/']);
  });

  test('escapes the machine id into the query string', async () => {
    const sw = loadWorker(offline);
    const { event } = clickEvent({ machineId: 'a b&c=d' });
    await sw.dispatch('notificationclick', event);
    expect(sw.opened).toEqual(['/?m=a%20b%26c%3Dd']);
  });
});
