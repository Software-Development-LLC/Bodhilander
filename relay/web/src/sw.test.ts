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
const CACHE = 'bodhi-shell-v1';

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
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => { skipWaitingCalls++; },
  };
  const clients = { claim: () => { claimCalls++; } };
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
  return { dispatch, stores, skipWaitingCalls: () => skipWaitingCalls, claimCalls: () => claimCalls };
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

  test('activate drops caches from older worker versions only', async () => {
    const sw = loadWorker(offline);
    await sw.dispatch('install');
    sw.stores.set('bodhi-shell-v0', new Map());
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
