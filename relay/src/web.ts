import path from 'node:path';
import type { RelayConfig } from './config';

/**
 * Serves the web client SPA (built from `relay/web/` by `bun run build:web`)
 * and its static assets. Everything else (auth, /api/me, /api/machines, /link,
 * /ws/client, …) is handled by the router/gateway. Resolved relative to this
 * file so it works regardless of the process CWD (repo or Docker image).
 */
const WEB_DIR = path.join(import.meta.dir, '..', 'web');

export function createWebClient(config: RelayConfig) {
  const devLogin = !config.isProduction;
  const indexFile = Bun.file(path.join(WEB_DIR, 'index.html'));
  const jsFile = Bun.file(path.join(WEB_DIR, 'dist', 'main.js'));
  const cssFile = Bun.file(path.join(WEB_DIR, 'dist', 'main.css'));

  // What makes the client installable: manifest, root-scoped worker, offline
  // fallback, icons. Enumerated path by path — this file serves an exact
  // allow-list, never a directory. Icons may cache for a day; the worker and
  // manifest must not, or an update would take that long to be discovered.
  const icon = (name: string) => ({ file: Bun.file(path.join(WEB_DIR, ...name.split('/'))), type: 'image/png', cache: 'public, max-age=86400' });
  const pwaAssets: Record<string, { file: ReturnType<typeof Bun.file>; type: string; cache: string }> = {
    '/manifest.webmanifest': { file: Bun.file(path.join(WEB_DIR, 'manifest.webmanifest')), type: 'application/manifest+json', cache: 'no-cache' },
    '/sw.js': { file: Bun.file(path.join(WEB_DIR, 'sw.js')), type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
    '/offline.html': { file: Bun.file(path.join(WEB_DIR, 'offline.html')), type: 'text/html; charset=utf-8', cache: 'no-cache' },
    '/apple-touch-icon.png': icon('apple-touch-icon.png'),
    '/icons/icon-192.png': icon('icons/icon-192.png'),
    '/icons/icon-512.png': icon('icons/icon-512.png'),
    '/icons/icon-maskable-192.png': icon('icons/icon-maskable-192.png'),
    '/icons/icon-maskable-512.png': icon('icons/icon-maskable-512.png'),
  };

  return function webRoute(req: Request): Response | null {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/api/config' && req.method === 'GET') {
      return Response.json({ devLogin });
    }
    if (req.method !== 'GET') return null;

    if (p === '/app/main.js') return new Response(jsFile, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
    if (p === '/app/main.css') return new Response(cssFile, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' } });

    const asset = pwaAssets[p];
    if (asset) return new Response(asset.file, { headers: { 'content-type': asset.type, 'cache-control': asset.cache } });

    // SPA shell at the root, and for invite links.
    //
    // `/i/:code` is a client route: the code lives in the path so it can be
    // sent in a message, and the fingerprint rides in the `#fp=` fragment,
    // which never reaches this server at all. Serving the shell here lets the
    // client read both — a redirect to `/` would discard the code, and the
    // fragment would not survive it either.
    if (p === '/' || p === '/i' || p.startsWith('/i/')) {
      return new Response(indexFile, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    return null; // fall through to the API/auth/ws router
  };
}
