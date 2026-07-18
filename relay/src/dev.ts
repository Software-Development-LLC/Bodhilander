import type { RelayConfig } from './config';
import type { Repositories } from './repositories';
import { serializeCookie, SESSION_COOKIE } from './auth/cookies';

/**
 * Development-only sign-in. Stands in for GitHub OAuth so the full desktop →
 * relay → online flow can be exercised locally without registering an OAuth
 * app. The web client (web.ts) surfaces a "Dev sign in" button that hits this.
 *
 * Mounted ONLY when NODE_ENV !== production (see http.ts). It must never exist
 * in a deployed relay.
 */
export function createDevRoutes(_config: RelayConfig, repos: Repositories) {
  return async function devRoute(req: Request): Promise<Response | null> {
    const url = new URL(req.url);

    if (url.pathname === '/dev/login' && req.method === 'POST') {
      const user = repos.upsertGithubUser({
        providerUserId: 'dev-user',
        displayName: 'Dev User',
        email: 'dev@localhost',
        avatarUrl: null,
      });
      const { token } = repos.createSession(user.id, 24 * 60 * 60);
      return new Response(JSON.stringify({ ok: true, user: { id: user.id, displayName: user.display_name } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': serializeCookie(SESSION_COOKIE, token, { secure: false, maxAgeSeconds: 86400 }),
        },
      });
    }

    return null; // not a dev route — fall through to the real router
  };
}
