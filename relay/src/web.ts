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

  return function webRoute(req: Request): Response | null {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/api/config' && req.method === 'GET') {
      return Response.json({ devLogin });
    }
    if (req.method !== 'GET') return null;

    if (p === '/app/main.js') return new Response(jsFile, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
    if (p === '/app/main.css') return new Response(cssFile, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' } });
    // SPA shell at the root; deeper client routes aren't used yet.
    if (p === '/') return new Response(indexFile, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    return null; // fall through to the API/auth/ws router
  };
}
