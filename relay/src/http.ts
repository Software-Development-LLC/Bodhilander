import pkg from '../package.json';
import type { RelayConfig } from './config';
import type { Logger } from './logger';
import type { Machine, Repositories, User } from './repositories';
import { fromBase64, randomToken, verifyEd25519 } from './crypto';
import { buildLinkMessage, LINK_MAX_SKEW_MS } from './protocol';
import {
  buildAuthorizeUrl,
  exchangeCodeForProfile,
  GithubOAuthError,
  OrgMembershipError,
  type GithubOAuthConfig,
} from './auth/github';
import {
  clearCookie,
  OAUTH_STATE_COOKIE,
  parseCookies,
  SESSION_COOKIE,
  serializeCookie,
} from './auth/cookies';
import { createDevRoutes } from './dev';
import { createWebClient } from './web';

/**
 * HTTP surface of the relay (M2), as a `fetch`-style handler for `Bun.serve`.
 * WebSocket upgrades are handled separately in `index.ts`.
 *
 * Routes:
 *   GET  /health                      — liveness (unauthenticated)
 *   GET  /auth/github/login           — begin GitHub OAuth
 *   GET  /auth/github/callback        — finish OAuth, set session cookie
 *   POST /auth/logout                 — destroy session
 *   GET  /api/me                      — current user (session)
 *   GET  /api/machines                — user's linked machines (session)
 *   POST /link                        — agent registers a machine (Ed25519-signed)
 *   POST /link/claim                  — user claims a link code (session)
 */
export interface RelayContext {
  config: RelayConfig;
  logger: Logger;
  repos: Repositories;
  /** Injectable for tests; defaults to global fetch (used for GitHub calls). */
  fetchImpl?: typeof fetch;
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function createRouter(ctx: RelayContext) {
  const { config, logger, repos } = ctx;
  const version = pkg.version ?? '0.0.0';
  const secure = config.isProduction || config.trustProxy;

  // Web client (sign-in + link-code claim), served at `/`.
  const webRoute = createWebClient(config);
  // Dev-only fake sign-in (/dev/login). Never mounted in production.
  const devRoute = config.isProduction ? null : createDevRoutes(config, repos);

  const githubConfig: GithubOAuthConfig | null =
    config.githubClientId && config.githubClientSecret
      ? {
          clientId: config.githubClientId,
          clientSecret: config.githubClientSecret,
          redirectUri: `${config.publicUrl}/auth/github/callback`,
        }
      : null;

  function currentUser(req: Request): User | null {
    const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
    return token ? repos.getUserBySessionToken(token) : null;
  }

  return async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    try {
      const webResponse = webRoute(req);
      if (webResponse) return webResponse;

      if (devRoute) {
        const devResponse = await devRoute(req);
        if (devResponse) return devResponse;
      }

      if (pathname === '/health' && method === 'GET') {
        return json({ ok: true, version, uptime: process.uptime() });
      }

      if (pathname === '/auth/github/login' && method === 'GET') {
        if (!githubConfig) return json({ error: 'oauth_not_configured' }, 503);
        const state = randomToken(16);
        return new Response(null, {
          status: 302,
          headers: {
            location: buildAuthorizeUrl(githubConfig, state, !!config.allowedGithubOrg),
            'set-cookie': serializeCookie(OAUTH_STATE_COOKIE, state, { secure, maxAgeSeconds: 600 }),
          },
        });
      }

      if (pathname === '/auth/github/callback' && method === 'GET') {
        return handleOAuthCallback(url, req);
      }

      if (pathname === '/auth/logout' && method === 'POST') {
        const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
        if (token) repos.deleteSession(token);
        return new Response(null, {
          status: 204,
          headers: { 'set-cookie': clearCookie(SESSION_COOKIE, secure) },
        });
      }

      if (pathname === '/api/me' && method === 'GET') {
        const user = currentUser(req);
        if (!user) return json({ error: 'unauthorized' }, 401);
        return json({ user: publicUser(user) });
      }

      if (pathname === '/api/machines' && method === 'GET') {
        const user = currentUser(req);
        if (!user) return json({ error: 'unauthorized' }, 401);
        return json({ machines: repos.listMachines(user.id).map(publicMachine) });
      }

      if (pathname === '/link' && method === 'POST') {
        return handleLink(req);
      }

      if (pathname === '/link/claim' && method === 'POST') {
        return handleClaim(req);
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      logger.error('unhandled http error', {
        method,
        path: pathname,
        err: err instanceof Error ? err.message : String(err),
      });
      return json({ error: 'internal_error' }, 500);
    }
  };

  async function handleOAuthCallback(url: URL, req: Request): Promise<Response> {
    if (!githubConfig) return json({ error: 'oauth_not_configured' }, 503);

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookieState = parseCookies(req.headers.get('cookie'))[OAUTH_STATE_COOKIE];

    if (!code || !state || !cookieState || state !== cookieState) {
      return json({ error: 'invalid_oauth_state' }, 400);
    }

    let profile;
    try {
      profile = await exchangeCodeForProfile(githubConfig, code, ctx.fetchImpl ?? fetch, config.allowedGithubOrg);
    } catch (err) {
      if (err instanceof OrgMembershipError) {
        // Valid GitHub user, but not in the required org — deny, don't sign in.
        logger.info('sign-in denied: not an org member', { org: config.allowedGithubOrg });
        const headers = new Headers({ location: `${config.publicUrl}/?denied=org` });
        headers.append('set-cookie', clearCookie(OAUTH_STATE_COOKIE, secure));
        return new Response(null, { status: 302, headers });
      }
      if (err instanceof GithubOAuthError) {
        logger.warn('github oauth exchange failed', { err: err.message });
        return json({ error: 'oauth_exchange_failed' }, 502);
      }
      throw err;
    }

    const user = repos.upsertGithubUser(profile);
    const { token, expiresAt } = repos.createSession(user.id, SESSION_TTL_SECONDS);
    logger.info('user signed in', { userId: user.id });

    const headers = new Headers({ location: `${config.publicUrl}/` });
    headers.append(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, token, {
        secure,
        maxAgeSeconds: Math.floor((expiresAt - Date.now()) / 1000),
      }),
    );
    headers.append('set-cookie', clearCookie(OAUTH_STATE_COOKIE, secure));
    return new Response(null, { status: 302, headers });
  }

  async function handleLink(req: Request): Promise<Response> {
    const body = await readJson(req);
    if (!body) return json({ error: 'invalid_json' }, 400);

    const { machineName, ed25519Pub, x25519Pub, issuedAt, signature } = body as Record<string, unknown>;
    if (
      typeof machineName !== 'string' ||
      typeof ed25519Pub !== 'string' ||
      typeof x25519Pub !== 'string' ||
      typeof issuedAt !== 'number' ||
      typeof signature !== 'string' ||
      machineName.length === 0 ||
      machineName.length > 128
    ) {
      return json({ error: 'invalid_request' }, 400);
    }

    if (Math.abs(Date.now() - issuedAt) > LINK_MAX_SKEW_MS) {
      return json({ error: 'stale_request' }, 400);
    }

    const edBytes = fromBase64(ed25519Pub);
    const xBytes = fromBase64(x25519Pub);
    const sigBytes = fromBase64(signature);
    if (!edBytes || !xBytes || !sigBytes || edBytes.length !== 32 || xBytes.length !== 32) {
      return json({ error: 'invalid_keys' }, 400);
    }

    const message = buildLinkMessage({ ed25519PubB64: ed25519Pub, x25519PubB64: x25519Pub, machineName, issuedAt });
    const verified = await verifyEd25519(edBytes, sigBytes, message);
    if (!verified) return json({ error: 'bad_signature' }, 401);

    const { code, expiresAt } = repos.createLinkCode(machineName, edBytes, xBytes, config.linkCodeTtlSeconds);
    logger.info('link code issued', { machineName });
    return json({ code, expiresAt });
  }

  async function handleClaim(req: Request): Promise<Response> {
    const user = currentUser(req);
    if (!user) return json({ error: 'unauthorized' }, 401);

    const body = await readJson(req);
    const code = body && typeof (body as Record<string, unknown>).code === 'string' ? (body as { code: string }).code : null;
    if (!code) return json({ error: 'invalid_request' }, 400);

    const result = repos.claimLinkCode(code, user.id);
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return json({ error: `link_${result.reason}` }, status);
    }
    logger.info('machine linked', { userId: user.id, machineId: result.machine.id });
    return json({ machine: publicMachine(result.machine) });
  }
}

function publicUser(user: User) {
  return {
    id: user.id,
    displayName: user.display_name,
    email: user.primary_email,
    avatarUrl: user.avatar_url,
  };
}

function publicMachine(m: Machine) {
  return {
    id: m.id,
    name: m.name,
    ed25519Pub: Buffer.from(m.ed25519_pubkey).toString('base64'),
    x25519Pub: Buffer.from(m.x25519_pubkey).toString('base64'),
    createdAt: m.created_at,
    lastSeenAt: m.last_seen_at,
  };
}

async function readJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
