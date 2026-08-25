import pkg from '../package.json';
import type { RelayConfig } from './config';
import type { Logger } from './logger';
import type { Machine, MachineGrant, Repositories, ShareInvite, User } from './repositories';
import { fromBase64, randomToken, verifyEd25519 } from './crypto';
import { buildLinkMessage, buildShareCreateMessage, LINK_MAX_SKEW_MS, MINTABLE_ROLES } from './protocol';
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
import { clientIp, createRateLimiter, type RateLimiter } from './rate-limit';
import { isAllowedPushEndpoint } from './push/send';
import type { Vapid } from './push/vapid';

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
 *   POST /api/machines/:id/shares     — owner mints an invite (Ed25519-signed)
 *   GET  /api/machines/:id/shares     — owner lists invites + grants (session)
 *   DEL  /api/machines/:id/shares/:id — owner revokes an invite (session)
 *   POST /api/shares/redeem           — guest redeems a code (session)
 *   GET  /api/shares                  — guest lists their grants (session)
 *   DEL  /api/shares/:grantId         — owner OR grantee ends a grant (session)
 *   GET  /api/push/vapid-key          — application-server key to subscribe with
 *   POST /api/push/subscribe          — register this browser (session)
 *   POST /api/push/unsubscribe        — drop this browser (session)
 */
export interface RelayContext {
  config: RelayConfig;
  logger: Logger;
  repos: Repositories;
  /** Injectable for tests; defaults to global fetch (used for GitHub calls). */
  fetchImpl?: typeof fetch;
  /** Injectable so the caller can sweep it from the reaper; defaults to a fresh one. */
  rateLimiter?: RateLimiter;
  /**
   * Called when a guest redeems an invite, so the gateway can wake the owner's
   * agent. HTTP and WebSocket are separate surfaces; this is the seam between
   * them rather than a shared mutable table.
   */
  onGrantRedeemed?: (grant: MachineGrant) => void;
  /** Called when a grant is revoked over HTTP, so live sockets can be cut. */
  onGrantRevoked?: (grant: MachineGrant) => void;
  /**
   * The application-server identity for web push. Absent in tests that don't
   * exercise it; the push routes then answer 503 rather than pretending.
   */
  vapid?: Vapid;
  /**
   * A user's set of push subscriptions changed. The gateway re-sends it to that
   * user's online agents, which are the things that actually seal payloads —
   * same HTTP↔WebSocket seam as the grant callbacks above.
   */
  onPushSubscriptionsChanged?: (userId: string) => void;
}

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Abuse limits on the two routes that mint or consume a secret. */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const LINK_PER_IP = 10;
const LINK_PER_KEY = 5;
/** Tighter: this is where a link code would be guessed at. */
const CLAIM_PER_IP = 20;
/** Minting invites is cheap for an owner and pointless to do in bulk. */
const SHARE_PER_IP = 20;
/**
 * Subscribing is a once-per-device act. The window is generous enough for a
 * browser that re-subscribes on every launch and tight enough that a script
 * cannot walk the per-user cap with a stream of throwaway endpoints.
 */
const PUSH_PER_IP = 30;
/** Reading the public key is free and idempotent — this is anti-hammering only. */
const PUSH_KEY_PER_IP = 120;

/**
 * Ceilings on what an invite may ask for. The desktop offers far shorter
 * defaults; these exist so a malformed or hostile request cannot produce a
 * grant that outlives any reasonable session.
 */
/** Upper bound for a grant that expires at all; 0 means "until revoked". */
const MAX_GRANT_TTL_SECONDS = 24 * 60 * 60;
const MAX_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export function createRouter(ctx: RelayContext) {
  const { config, logger, repos, onGrantRedeemed, onGrantRevoked, onPushSubscriptionsChanged } = ctx;
  const limiter = ctx.rateLimiter ?? createRateLimiter();
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

  /**
   * Charge one hit against `bucket` for this caller. Returns a 429 when the
   * window is exhausted, otherwise null. Fails OPEN when no address can be
   * resolved — bucketing every anonymous caller together would turn one abuser
   * into a global outage.
   */
  function limited(req: Request, peerIp: string | null, bucket: string, limit: number): Response | null {
    const ip = clientIp(req, peerIp, config.trustProxy);
    if (!ip) return null;
    const result = limiter.check(`${bucket}:${ip}`, limit, RATE_WINDOW_MS);
    if (result.allowed) return null;
    logger.warn('rate limited', { bucket, path: new URL(req.url).pathname });
    return json({ error: 'rate_limited' }, 429, { 'retry-after': String(result.retryAfter) });
  }

  return async function route(req: Request, peerIp: string | null = null): Promise<Response> {
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
        return json({ machines: machinesFor(user) });
      }

      if (pathname === '/link' && method === 'POST') {
        return limited(req, peerIp, 'link', LINK_PER_IP) ?? (await handleLink(req));
      }

      if (pathname === '/link/claim' && method === 'POST') {
        return limited(req, peerIp, 'claim', CLAIM_PER_IP) ?? (await handleClaim(req));
      }

      // --- sharing (M5.2) ---

      const shares = matchMachineShares(pathname);
      if (shares) {
        if (method === 'POST' && !shares.inviteId) {
          return limited(req, peerIp, 'share', SHARE_PER_IP) ?? (await handleCreateShare(req, shares.machineId));
        }
        if (method === 'GET' && !shares.inviteId) return handleListShares(req, shares.machineId);
        if (method === 'DELETE' && shares.inviteId) {
          return handleRevokeInvite(req, shares.machineId, shares.inviteId);
        }
      }

      if (pathname === '/api/shares' && method === 'GET') {
        return handleListMyShares(req);
      }

      if (pathname === '/api/shares/redeem' && method === 'POST') {
        // Code-guessing surface, same as /link/claim.
        return limited(req, peerIp, 'redeem', CLAIM_PER_IP) ?? (await handleRedeem(req));
      }

      const grantId = matchShareGrant(pathname);
      if (grantId && method === 'DELETE') return handleRevokeGrant(req, grantId);

      // --- web push (M5.3) ---

      if (pathname === '/api/push/vapid-key' && method === 'GET') {
        return limited(req, peerIp, 'push:key', PUSH_KEY_PER_IP) ?? (await handleVapidKey(req));
      }
      if (pathname === '/api/push/subscribe' && method === 'POST') {
        return limited(req, peerIp, 'push', PUSH_PER_IP) ?? (await handlePushSubscribe(req));
      }
      if (pathname === '/api/push/unsubscribe' && method === 'POST') {
        return limited(req, peerIp, 'push', PUSH_PER_IP) ?? (await handlePushUnsubscribe(req));
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

    // Charged only after the signature verifies, so nobody can exhaust someone
    // else's budget by naming their key. Bounds the unclaimed rows one keypair
    // can accumulate, independent of how many addresses it comes from.
    const perKey = limiter.check(`link:key:${ed25519Pub}`, LINK_PER_KEY, RATE_WINDOW_MS);
    if (!perKey.allowed) {
      logger.warn('rate limited', { bucket: 'link:key' });
      return json({ error: 'rate_limited' }, 429, { 'retry-after': String(perKey.retryAfter) });
    }

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

  // --- sharing (M5.2) ---

  /**
   * Every machine this user can reach, owned and shared-with, in one list.
   *
   * A guest's entry carries the certificate it must present. The relay holds
   * that blob but cannot read it — and cannot mint one, which is the whole
   * point of the agent countersigning.
   */
  function machinesFor(user: User) {
    const owned = repos.listMachines(user.id).map((m) => ({
      ...publicMachine(m),
      relation: 'owner' as const,
      ownerName: null as string | null,
      grantId: null as string | null,
      role: null as string | null,
      certificate: null as string | null,
    }));

    const shared = [];
    for (const grant of repos.listGrantsForUser(user.id)) {
      // Only grants the agent has actually countersigned are usable; a pending
      // one is a request the owner has not answered. The expiry check matters
      // because the reaper runs every ten minutes — without it a lapsed grant
      // would keep being listed, certificate and all, until it happened to be
      // swept.
      if (grant.status !== 'active' || !grant.certificate) continue;
      if (grant.expires_at !== null && grant.expires_at <= Date.now()) continue;
      const machine = repos.getMachine(grant.machine_id);
      if (!machine) continue;
      const owner = repos.getUser(machine.user_id);
      shared.push({
        ...publicMachine(machine),
        relation: 'grantee' as const,
        // Label by person: "machine" is owner vocabulary.
        ownerName: owner?.display_name ?? null,
        grantId: grant.id,
        role: grant.role,
        certificate: grant.certificate,
      });
    }
    return [...owned, ...shared];
  }

  /**
   * Create an invite. Ed25519-signed by the machine, not session-authenticated:
   * only the machine can countersign a grant, so only the machine may offer
   * one — a stolen session cookie cannot mint invites.
   */
  async function handleCreateShare(req: Request, machineId: string): Promise<Response> {
    const body = await readJson(req);
    if (!body) return json({ error: 'invalid_json' }, 400);

    const { expectedGithubLogin, role, grantTtlSeconds, inviteTtlSeconds, issuedAt, signature, label } =
      body as Record<string, unknown>;

    if (
      typeof role !== 'string' ||
      typeof grantTtlSeconds !== 'number' ||
      typeof inviteTtlSeconds !== 'number' ||
      typeof issuedAt !== 'number' ||
      typeof signature !== 'string' ||
      (expectedGithubLogin !== null && typeof expectedGithubLogin !== 'string') ||
      (label !== undefined && label !== null && typeof label !== 'string')
    ) {
      return json({ error: 'invalid_request' }, 400);
    }
    if (!(MINTABLE_ROLES as readonly string[]).includes(role)) return json({ error: 'invalid_role' }, 400);
    // 0 is "until the owner revokes it" — see GRANT_TTL_UNTIL_REVOKED. The
    // relay stores it and nothing more: it is not the authority on how long a
    // grant lives, the machine that signs the certificate is, and that machine
    // ends the grant on revoke or on a restart of the shared session whatever
    // the clock says. Every other value stays capped.
    if (!Number.isInteger(grantTtlSeconds) || grantTtlSeconds < 0) return json({ error: 'invalid_ttl' }, 400);
    if (grantTtlSeconds > MAX_GRANT_TTL_SECONDS) return json({ error: 'invalid_ttl' }, 400);
    if (inviteTtlSeconds <= 0 || inviteTtlSeconds > MAX_INVITE_TTL_SECONDS) return json({ error: 'invalid_ttl' }, 400);
    if (Math.abs(Date.now() - issuedAt) > LINK_MAX_SKEW_MS) return json({ error: 'stale_request' }, 400);

    const machine = repos.getMachine(machineId);
    if (!machine) return json({ error: 'not_found' }, 404);

    const sigBytes = fromBase64(signature);
    if (!sigBytes) return json({ error: 'invalid_request' }, 400);
    const message = buildShareCreateMessage({
      machineId,
      expectedGithubLogin: expectedGithubLogin ?? '',
      role,
      grantTtlSeconds,
      inviteTtlSeconds,
      issuedAt,
    });
    if (!(await verifyEd25519(new Uint8Array(machine.ed25519_pubkey), sigBytes, message))) {
      return json({ error: 'bad_signature' }, 401);
    }

    const { invite, code } = repos.createShareInvite({
      machineId,
      expectedGithubLogin: (expectedGithubLogin as string | null) ?? null,
      role: role as 'viewer' | 'operator',
      label: (label as string | undefined) ?? null,
      grantTtlSeconds,
      inviteTtlSeconds,
    });

    logger.info('share invite created', { machineId, addressed: !!invite.expected_github_login });
    // The CODE only — never a URL. If the relay authored the invite link it
    // could put its own fingerprint in the `#fp=` fragment and serve the
    // matching key, making the guest's three-way check agree perfectly and
    // manufacturing a false "verified". The desktop composes the URL locally.
    return json({ inviteId: invite.id, code, expiresAt: invite.expires_at });
  }

  function handleListShares(req: Request, machineId: string): Response {
    const user = currentUser(req);
    if (!user) return json({ error: 'unauthorized' }, 401);
    const machine = repos.getMachine(machineId);
    if (!machine || machine.user_id !== user.id) return json({ error: 'not_found' }, 404);
    return json({
      invites: repos.listShareInvites(machineId).map(publicInvite),
      grants: repos.listGrantsForMachine(machineId).map((g) => publicGrant(g, repos.getUser(g.grantee_user_id))),
    });
  }

  function handleRevokeInvite(req: Request, machineId: string, inviteId: string): Response {
    const user = currentUser(req);
    if (!user) return json({ error: 'unauthorized' }, 401);
    const machine = repos.getMachine(machineId);
    if (!machine || machine.user_id !== user.id) return json({ error: 'not_found' }, 404);
    if (!repos.revokeShareInvite(machineId, inviteId)) return json({ error: 'not_found' }, 404);
    return new Response(null, { status: 204 });
  }

  function handleListMyShares(req: Request): Response {
    const user = currentUser(req);
    if (!user) return json({ error: 'unauthorized' }, 401);
    const grants = repos.listGrantsForUser(user.id).map((g) => {
      const machine = repos.getMachine(g.machine_id);
      const owner = machine ? repos.getUser(machine.user_id) : null;
      return {
        ...publicGrant(g, user),
        machineId: g.machine_id,
        machineName: machine?.name ?? null,
        ownerName: owner?.display_name ?? null,
      };
    });
    return json({ grants });
  }

  async function handleRedeem(req: Request): Promise<Response> {
    const user = currentUser(req);
    if (!user) return json({ error: 'unauthorized' }, 401);

    const body = await readJson(req);
    const code = body && typeof (body as Record<string, unknown>).code === 'string' ? (body as { code: string }).code : null;
    if (!code) return json({ error: 'invalid_request' }, 400);

    // The desktop generates grant ids so a reused one cannot silently hand one
    // grant's holder another grant's sessions — but redemption happens here,
    // before the desktop is involved. A UUID minted here is still opaque to
    // the guest, and the agent refuses any grantId absent from its own table,
    // so a collision fails closed rather than widening anything.
    const result = repos.redeemShareInvite(code, user, crypto.randomUUID());
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      // Logged because a refusal is the one outcome the guest cannot explain
      // and the owner cannot see. `login_unknown` in particular looked exactly
      // like a wrong account from the outside.
      logger.info('share invite refused', { reason: result.reason });
      return json({ error: `invite_${result.reason}` }, status);
    }

    logger.info('share invite redeemed', { machineId: result.grant.machine_id, grantId: result.grant.id });
    onGrantRedeemed?.(result.grant);
    // Pending, deliberately: the guest is waiting on the owner, and the client
    // must render that rather than a broken terminal.
    return json({ grant: publicGrant(result.grant, user), status: 'pending' });
  }

  function handleRevokeGrant(req: Request, grantId: string): Response {
    const user = currentUser(req);
    if (!user) return json({ error: 'unauthorized' }, 401);
    const grant = repos.getGrant(grantId);
    if (!grant) return json({ error: 'not_found' }, 404);

    const machine = repos.getMachine(grant.machine_id);
    const isOwner = !!machine && machine.user_id === user.id;
    const isGrantee = grant.grantee_user_id === user.id;
    // A grantee may hand access back; anyone else gets the same answer as a
    // grant that does not exist.
    if (!isOwner && !isGrantee) return json({ error: 'not_found' }, 404);

    repos.revokeGrant(grantId);
    logger.info('grant revoked', { grantId, by: isOwner ? 'owner' : 'grantee' });
    onGrantRevoked?.(grant);
    return new Response(null, { status: 204 });
  }

  // --- web push (M5.3) ---

  /**
   * The application-server public key a browser subscribes with.
   *
   * Session-gated, though the value is public: only a signed-in browser has any
   * use for it, and gating keeps the key off an anonymous surface that would
   * otherwise be the cheapest way to fingerprint which relay you are talking to.
   */
  async function handleVapidKey(req: Request): Promise<Response> {
    if (!currentUser(req)) return json({ error: 'unauthorized' }, 401);
    if (!ctx.vapid) return json({ error: 'push_unavailable' }, 503);
    return json({ key: await ctx.vapid.publicKey() });
  }

  async function handlePushSubscribe(req: Request): Promise<Response> {
    const user = currentUser(req);
    if (!user) return json({ error: 'unauthorized' }, 401);

    const body = await readJson(req);
    if (!body) return json({ error: 'invalid_json' }, 400);
    const { endpoint, keys } = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const p256dh = keys?.p256dh;
    const auth = keys?.auth;

    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
      return json({ error: 'invalid_request' }, 400);
    }
    // The endpoint is a URL this server will later make a request TO, so it is
    // checked before it is stored, not before it is used. See `isAllowedPushEndpoint`.
    if (!isAllowedPushEndpoint(endpoint)) return json({ error: 'invalid_endpoint' }, 400);
    // Sized here so a malformed pair fails at subscribe time — where a person
    // can see it — rather than as an unexplained delivery failure much later.
    if (!isUncompressedP256Point(p256dh)) return json({ error: 'invalid_keys' }, 400);
    if (!isAuthSecret(auth)) return json({ error: 'invalid_keys' }, 400);

    const saved = repos.upsertPushSubscription(user.id, { endpoint, p256dh, auth });
    if (!saved) {
      logger.warn('push subscription refused: per-user cap reached', { userId: user.id });
      return json({ error: 'too_many_subscriptions' }, 409);
    }

    logger.info('push subscription registered', { userId: user.id });
    onPushSubscriptionsChanged?.(user.id);
    return new Response(null, { status: 204 });
  }

  async function handlePushUnsubscribe(req: Request): Promise<Response> {
    const user = currentUser(req);
    if (!user) return json({ error: 'unauthorized' }, 401);

    const body = await readJson(req);
    const endpoint = body && typeof (body as { endpoint?: unknown }).endpoint === 'string'
      ? (body as { endpoint: string }).endpoint
      : null;
    if (!endpoint) return json({ error: 'invalid_request' }, 400);

    // 204 either way. The browser has already dropped its end by the time it
    // calls this, so "there was nothing to remove" is a success from where the
    // caller stands — and distinguishing the two would confirm whether a given
    // endpoint is registered to the signed-in account.
    if (repos.deletePushSubscriptionByEndpoint(user.id, endpoint)) {
      logger.info('push subscription removed', { userId: user.id });
      onPushSubscriptionsChanged?.(user.id);
    }
    return new Response(null, { status: 204 });
  }
}

/** The subscription's public key: an uncompressed P-256 point, base64url. */
function isUncompressedP256Point(value: string): boolean {
  const bytes = fromBase64(value);
  return !!bytes && bytes.length === 65 && bytes[0] === 0x04;
}

/** The subscription's auth secret: 16 bytes, base64url (RFC 8291 §3.2). */
function isAuthSecret(value: string): boolean {
  const bytes = fromBase64(value);
  return !!bytes && bytes.length === 16;
}

/** `/api/machines/:machineId/shares[/:inviteId]` */
function matchMachineShares(pathname: string): { machineId: string; inviteId: string | null } | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== 'api' || parts[1] !== 'machines' || parts[3] !== 'shares') return null;
  if (parts.length > 5) return null;
  return { machineId: parts[2]!, inviteId: parts[4] ?? null };
}

/** `/api/shares/:grantId`, excluding the fixed sub-routes. */
function matchShareGrant(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'api' || parts[1] !== 'shares') return null;
  const id = parts[2]!;
  return id === 'redeem' ? null : id;
}

function publicInvite(i: ShareInvite) {
  return {
    id: i.id,
    expectedGithubLogin: i.expected_github_login,
    role: i.role,
    label: i.label,
    status: i.status,
    attemptCount: i.attempt_count,
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    grantTtlSeconds: i.grant_ttl_seconds,
    // No code, and no hash: neither is useful to a client and the hash is a
    // guessing target.
  };
}

function publicGrant(g: MachineGrant, grantee: User | null) {
  return {
    id: g.id,
    role: g.role,
    status: g.status,
    label: g.label,
    granteeName: grantee?.display_name ?? null,
    granteeLogin: grantee?.github_login ?? null,
    createdAt: g.created_at,
    boundAt: g.bound_at,
    expiresAt: g.expires_at,
    lastUsedAt: g.last_used_at,
  };
}

function publicUser(user: User) {
  return {
    id: user.id,
    displayName: user.display_name,
    email: user.primary_email,
    avatarUrl: user.avatar_url,
    // Null is a real, reachable state: a row created before we recorded logins
    // has none until the next sign-in backfills it. The client surfaces that
    // rather than hiding it — it is the whole reason an addressed invite can
    // refuse someone who IS the right person (#170).
    githubLogin: user.github_login,
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

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}
