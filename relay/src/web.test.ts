/**
 * What the relay serves at which path.
 *
 * The ordering inside `createWebClient` is the point: an exact static-asset
 * allow-list is consulted first, and the SPA shell catches `/` and `/i/*`
 * afterwards. That reads as correct, and it stayed correct through the PWA
 * work — but it was only ever correct by inspection, and the failure mode is
 * quiet: an invite link would start answering with the manifest, or with a 404
 * that sends the guest to a blank page holding a code that does work.
 */
import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config';
import { createWebClient } from './web';

const { config } = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://relay.test' });
const web = createWebClient(config);

const get = (path: string) => web(new Request(`http://relay.test${path}`));

/** The shell, identified by content rather than by trusting the status code. */
async function isShell(res: Response | null): Promise<boolean> {
  if (!res) return false;
  if (!res.headers.get('content-type')?.startsWith('text/html')) return false;
  return (await res.text()).includes('<div id="root"></div>');
}

describe('the SPA shell', () => {
  test('is served at the root', async () => {
    expect(await isShell(await get('/'))).toBe(true);
  });

  test.each([
    '/i/ABCD-EFGH',
    '/i/abcd-efgh',
    '/i/ABCD-EFGH/',
    '/i',
    // A code that happens to look like an asset path must still reach the
    // client, which is the whole reason this route is a prefix match.
    '/i/sw.js',
    '/i/manifest.webmanifest',
  ])('is served for the invite route %s', async (path) => {
    // The code lives in the path and the fingerprint rides in the `#fp=`
    // fragment, which never reaches this server. A redirect would discard both.
    expect(await isShell(await get(path))).toBe(true);
  });

  test('a dynamic route is not shadowed by the static-asset lookup', async () => {
    // The ordering that makes this true is: exact asset table first, then the
    // shell. Both have to keep working, so both are asserted together.
    const asset = await get('/sw.js');
    expect(asset).not.toBeNull();
    expect(asset!.headers.get('content-type')).toContain('javascript');
    expect(await isShell(await get('/i/CODE-HERE'))).toBe(true);
  });
});

describe('the static allow-list', () => {
  test.each([
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/sw.js', 'text/javascript'],
    ['/offline.html', 'text/html'],
    ['/icons/icon-192.png', 'image/png'],
    ['/apple-touch-icon.png', 'image/png'],
  ])('serves %s as %s', async (path, type) => {
    const res = await get(path);
    expect(res).not.toBeNull();
    expect(res!.headers.get('content-type')).toContain(type);
  });

  test('the worker and the manifest are never cached, so an update is discoverable', async () => {
    for (const path of ['/sw.js', '/manifest.webmanifest']) {
      expect((await get(path))!.headers.get('cache-control')).toBe('no-cache');
    }
  });

  test('is an allow-list, not a directory — nothing else under web/ is reachable', async () => {
    // `..` is normalised away by `new URL` before it ever reaches the table,
    // and an unlisted real file still falls through to the API router.
    for (const path of ['/tsconfig.json', '/src/main.ts', '/../package.json', '/icons/', '/index.html']) {
      expect(await get(path)).toBeNull();
    }
  });

  test('hands everything else to the API and auth router', async () => {
    for (const path of ['/api/machines', '/auth/github/login', '/health', '/link']) {
      expect(await get(path)).toBeNull();
    }
  });

  test('only answers GET, so a POST reaches the route that handles it', async () => {
    const posted = web(new Request('http://relay.test/i/ABCD', { method: 'POST' }));
    expect(posted).toBeNull();
  });
});
