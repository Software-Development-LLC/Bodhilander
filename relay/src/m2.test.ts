import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { openDb } from './db';
import { createRepositories } from './repositories';
import { createRouter } from './http';
import { buildLinkMessage } from './protocol';
import { generateLinkCode, normalizeLinkCode, sha256Hex, timingSafeEqualHex, toArrayBuffer, verifyEd25519 } from './crypto';

const logger = createLogger('error');

function freshRepos() {
  return createRepositories(openDb(':memory:'));
}

/** Generate an Ed25519 keypair and return raw pubkey + a signer. */
async function ed25519Keypair() {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const sign = async (msg: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, toArrayBuffer(msg)));
  return { pub, sign };
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

// ---------------------------------------------------------------------------
describe('crypto', () => {
  test('generateLinkCode is 9 chars in XXXX-XXXX form with an unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateLinkCode();
      expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    }
  });

  test('normalizeLinkCode strips formatting and uppercases', () => {
    expect(normalizeLinkCode(' k7q2-9f3d ')).toBe('K7Q29F3D');
  });

  test('timingSafeEqualHex', () => {
    const h = sha256Hex('x');
    expect(timingSafeEqualHex(h, h)).toBe(true);
    expect(timingSafeEqualHex(h, sha256Hex('y'))).toBe(false);
    expect(timingSafeEqualHex(h, 'short')).toBe(false);
  });

  test('verifyEd25519 accepts a valid signature and rejects tampering', async () => {
    const { pub, sign } = await ed25519Keypair();
    const msg = new TextEncoder().encode('authentic');
    const sig = await sign(msg);
    expect(await verifyEd25519(pub, sig, msg)).toBe(true);
    expect(await verifyEd25519(pub, sig, new TextEncoder().encode('forged'))).toBe(false);
    const badSig = new Uint8Array(sig);
    badSig[0] = (badSig[0] ?? 0) ^ 0xff;
    expect(await verifyEd25519(pub, badSig, msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('repositories: users & sessions', () => {
  test('upsertGithubUser creates once, then refreshes profile on repeat', () => {
    const repos = freshRepos();
    const a = repos.upsertGithubUser({ providerUserId: '42', displayName: 'Octo', login: 'octo', email: 'o@gh.com', avatarUrl: null });
    const b = repos.upsertGithubUser({ providerUserId: '42', displayName: 'Octo Renamed', login: 'octorenamed', email: 'o@gh.com', avatarUrl: 'x' });
    expect(b.id).toBe(a.id); // same identity → same user
    expect(b.display_name).toBe('Octo Renamed');
  });

  test('session lifecycle: create → resolve → expire → delete', () => {
    let clock = 1_000_000;
    const repos = createRepositories(openDb(':memory:'), () => clock);
    const user = repos.upsertGithubUser({ providerUserId: '1', displayName: 'U', login: 'u', email: null, avatarUrl: null });

    const { token } = repos.createSession(user.id, 60);
    expect(repos.getUserBySessionToken(token)?.id).toBe(user.id);

    clock += 61_000; // past TTL
    expect(repos.getUserBySessionToken(token)).toBeNull();

    clock = 1_000_000;
    const s2 = repos.createSession(user.id, 60);
    repos.deleteSession(s2.token);
    expect(repos.getUserBySessionToken(s2.token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('repositories: link codes & machines', () => {
  const ed = new Uint8Array(32).fill(7);
  const x = new Uint8Array(32).fill(9);

  test('claim binds a pending code to a machine and lists it', () => {
    const repos = freshRepos();
    const user = repos.upsertGithubUser({ providerUserId: '1', displayName: 'U', login: 'u', email: null, avatarUrl: null });
    const { code } = repos.createLinkCode('Will-MBP', ed, x, 600);

    const result = repos.claimLinkCode(code, user.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.machine.name).toBe('Will-MBP');
    expect(repos.listMachines(user.id)).toHaveLength(1);
  });

  test('a code cannot be claimed twice', () => {
    const repos = freshRepos();
    const user = repos.upsertGithubUser({ providerUserId: '1', displayName: 'U', login: 'u', email: null, avatarUrl: null });
    const { code } = repos.createLinkCode('m', ed, x, 600);
    expect(repos.claimLinkCode(code, user.id).ok).toBe(true);
    const again = repos.claimLinkCode(code, user.id);
    expect(again).toEqual({ ok: false, reason: 'already_used' });
  });

  test('expired and unknown codes are rejected', () => {
    let clock = 1_000_000;
    const repos = createRepositories(openDb(':memory:'), () => clock);
    const user = repos.upsertGithubUser({ providerUserId: '1', displayName: 'U', login: 'u', email: null, avatarUrl: null });
    const { code } = repos.createLinkCode('m', ed, x, 1);
    clock += 2_000;
    expect(repos.claimLinkCode(code, user.id)).toEqual({ ok: false, reason: 'expired' });
    expect(repos.claimLinkCode('ZZZZ-ZZZZ', user.id)).toEqual({ ok: false, reason: 'not_found' });
  });

  test('re-linking the same ed25519 identity rebinds instead of duplicating', () => {
    const repos = freshRepos();
    const u1 = repos.upsertGithubUser({ providerUserId: '1', displayName: 'A', login: 'a', email: null, avatarUrl: null });
    const u2 = repos.upsertGithubUser({ providerUserId: '2', displayName: 'B', login: 'b', email: null, avatarUrl: null });
    repos.claimLinkCode(repos.createLinkCode('m', ed, x, 600).code, u1.id);
    repos.claimLinkCode(repos.createLinkCode('m-renamed', ed, x, 600).code, u2.id);
    expect(repos.listMachines(u1.id)).toHaveLength(0); // moved off u1
    expect(repos.listMachines(u2.id)).toHaveLength(1);
    expect(repos.listMachines(u2.id)[0]!.name).toBe('m-renamed');
  });
});

// ---------------------------------------------------------------------------
describe('router: /link + /link/claim (end to end)', () => {
  const { config } = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });

  async function signedLinkBody(machineName: string, overrides: Partial<{ issuedAt: number }> = {}) {
    const { pub, sign } = await ed25519Keypair();
    const xPub = new Uint8Array(32).fill(3);
    const issuedAt = overrides.issuedAt ?? Date.now();
    const ed25519Pub = b64(pub);
    const x25519Pub = b64(xPub);
    const sig = await sign(buildLinkMessage({ ed25519PubB64: ed25519Pub, x25519PubB64: x25519Pub, machineName, issuedAt }));
    return { machineName, ed25519Pub, x25519Pub, issuedAt, signature: b64(sig) };
  }

  test('a valid signed request yields a code; a user claims it and sees the machine', async () => {
    const repos = freshRepos();
    const route = createRouter({ config, logger, repos });
    const user = repos.upsertGithubUser({ providerUserId: '1', displayName: 'U', login: 'u', email: null, avatarUrl: null });
    const { token } = repos.createSession(user.id, 3600);

    const linkRes = await route(
      new Request('http://relay.test/link', { method: 'POST', body: JSON.stringify(await signedLinkBody('Will-MBP')) }),
    );
    expect(linkRes.status).toBe(200);
    const { code } = (await linkRes.json()) as { code: string };
    expect(code).toBeTruthy();

    const claimRes = await route(
      new Request('http://relay.test/link/claim', {
        method: 'POST',
        headers: { cookie: `bdl_session=${token}` },
        body: JSON.stringify({ code }),
      }),
    );
    expect(claimRes.status).toBe(200);
    const { machine } = (await claimRes.json()) as { machine: { name: string } };
    expect(machine.name).toBe('Will-MBP');

    const listRes = await route(
      new Request('http://relay.test/api/machines', { headers: { cookie: `bdl_session=${token}` } }),
    );
    expect(((await listRes.json()) as { machines: unknown[] }).machines).toHaveLength(1);
  });

  test('a tampered signature is rejected with 401', async () => {
    const repos = freshRepos();
    const route = createRouter({ config, logger, repos });
    const body = await signedLinkBody('m');
    body.machineName = 'different-name-not-signed'; // signature no longer matches
    const res = await route(new Request('http://relay.test/link', { method: 'POST', body: JSON.stringify(body) }));
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toEqual({ error: 'bad_signature' });
  });

  test('a stale issuedAt is rejected', async () => {
    const repos = freshRepos();
    const route = createRouter({ config, logger, repos });
    const body = await signedLinkBody('m', { issuedAt: Date.now() - 10 * 60 * 1000 });
    const res = await route(new Request('http://relay.test/link', { method: 'POST', body: JSON.stringify(body) }));
    expect(res.status).toBe(400);
  });

  test('claim without a session is unauthorized', async () => {
    const repos = freshRepos();
    const route = createRouter({ config, logger, repos });
    const res = await route(
      new Request('http://relay.test/link/claim', { method: 'POST', body: JSON.stringify({ code: 'X' }) }),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('router: rate limiting', () => {
  const { config } = loadConfig({});
  const PEER = '198.51.100.4';

  const claim = (route: ReturnType<typeof createRouter>, peerIp: string | null) =>
    route(
      new Request('http://relay.test/link/claim', { method: 'POST', body: JSON.stringify({ code: 'K7Q2-9F3D' }) }),
      peerIp,
    );

  test('a caller guessing link codes is cut off with 429 and a Retry-After', async () => {
    const route = createRouter({ config, logger, repos: freshRepos() });

    // Unauthenticated claims 401 all day; the limiter is what stops the guessing.
    for (let i = 0; i < 20; i++) {
      expect((await claim(route, PEER)).status).toBe(401);
    }

    const blocked = await claim(route, PEER);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('one caller being limited does not affect another address', async () => {
    const route = createRouter({ config, logger, repos: freshRepos() });
    for (let i = 0; i < 21; i++) await claim(route, PEER);

    expect((await claim(route, '203.0.113.9')).status).toBe(401);
  });

  test('a keypair is capped across addresses, so rotating IPs does not help', async () => {
    const repos = freshRepos();
    const route = createRouter({ config, logger, repos });
    const { pub, sign } = await ed25519Keypair();

    const linkOnce = async (from: string) => {
      const issuedAt = Date.now();
      const ed25519Pub = b64(pub);
      const x25519Pub = b64(new Uint8Array(32).fill(3));
      const signature = b64(
        await sign(buildLinkMessage({ ed25519PubB64: ed25519Pub, x25519PubB64: x25519Pub, machineName: 'm', issuedAt })),
      );
      return route(
        new Request('http://relay.test/link', {
          method: 'POST',
          body: JSON.stringify({ machineName: 'm', ed25519Pub, x25519Pub, issuedAt, signature }),
        }),
        from,
      );
    };

    for (let i = 0; i < 5; i++) {
      expect((await linkOnce(`198.51.100.${i}`)).status).toBe(200);
    }
    // Sixth attempt from yet another address: the per-key budget is spent.
    expect((await linkOnce('198.51.100.99')).status).toBe(429);
  });

  test('fails open when no address can be resolved', async () => {
    const route = createRouter({ config, logger, repos: freshRepos() });

    for (let i = 0; i < 25; i++) {
      expect((await claim(route, null)).status).toBe(401);
    }
  });
});

describe('router: GitHub OAuth', () => {
  // `membership`: 'active' → member, 'none' → 404 (not a member), undefined → org not checked.
  function makeMockFetch(membership?: 'active' | 'none') {
    return (async (input: Request | string | URL) => {
      const u = typeof input === 'string' ? input : input.toString();
      if (u.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gho_test' }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.endsWith('/user')) {
        return new Response(
          JSON.stringify({ id: 777, login: 'octocat', name: 'The Octocat', avatar_url: 'https://a/b.png', email: 'octo@gh.com' }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/user/memberships/orgs/')) {
        return membership === 'active'
          ? new Response(JSON.stringify({ state: 'active', role: 'member' }), { headers: { 'content-type': 'application/json' } })
          : new Response('Not Found', { status: 404 });
      }
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }
  const mockFetch = makeMockFetch();

  /** Run the OAuth callback and return the issued session token. */
  async function signIn(route: (req: Request) => Promise<Response> | Response): Promise<string> {
    const res = await route(
      new Request('http://relay.test/auth/github/callback?code=abc&state=xyz', {
        headers: { cookie: 'bdl_oauth_state=xyz' },
      }),
    );
    const session = res.headers.getSetCookie().find((c) => c.startsWith('bdl_session='))!;
    return session.slice('bdl_session='.length).split(';')[0]!;
  }

  test('login without OAuth config returns 503', async () => {
    const { config } = loadConfig({});
    const route = createRouter({ config, logger, repos: freshRepos() });
    const res = await route(new Request('http://relay.test/auth/github/login'));
    expect(res.status).toBe(503);
  });

  test('login redirects to GitHub and sets a state cookie', async () => {
    const { config } = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });
    const route = createRouter({ config, logger, repos: freshRepos() });
    const res = await route(new Request('http://relay.test/auth/github/login'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('github.com/login/oauth/authorize');
    expect(res.headers.get('set-cookie')).toContain('bdl_oauth_state=');
  });

  test('callback with matching state signs the user in and the session works', async () => {
    const { config } = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });
    const repos = freshRepos();
    const route = createRouter({ config, logger, repos, fetchImpl: mockFetch });

    const cbRes = await route(
      new Request('http://relay.test/auth/github/callback?code=abc&state=xyz', {
        headers: { cookie: 'bdl_oauth_state=xyz' },
      }),
    );
    expect(cbRes.status).toBe(302);
    const setCookies = cbRes.headers.getSetCookie();
    const session = setCookies.find((c) => c.startsWith('bdl_session='));
    expect(session).toBeTruthy();
    const token = session!.slice('bdl_session='.length).split(';')[0]!;

    const meRes = await route(new Request('http://relay.test/api/me', { headers: { cookie: `bdl_session=${token}` } }));
    expect(meRes.status).toBe(200);
    const { user } = (await meRes.json()) as { user: { displayName: string; email: string } };
    expect(user.displayName).toBe('The Octocat');
    expect(user.email).toBe('octo@gh.com');
  });

  // The client shows this handle, and shows a warning when it is missing —
  // an addressed invite matches on it, so an absent one is the difference
  // between a link working and being refused (#170).
  test('/api/me reports the GitHub handle the relay holds', async () => {
    const { config } = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });
    const route = createRouter({ config, logger, repos: freshRepos(), fetchImpl: mockFetch });
    const token = await signIn(route);

    const meRes = await route(new Request('http://relay.test/api/me', { headers: { cookie: `bdl_session=${token}` } }));
    const { user } = (await meRes.json()) as { user: { githubLogin: string | null } };
    expect(user.githubLogin).toBe('octocat');
  });

  test('logout destroys the session, so the same cookie stops working', async () => {
    const { config } = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });
    const route = createRouter({ config, logger, repos: freshRepos(), fetchImpl: mockFetch });
    const token = await signIn(route);
    const cookie = `bdl_session=${token}`;

    const outRes = await route(new Request('http://relay.test/auth/logout', { method: 'POST', headers: { cookie } }));
    expect(outRes.status).toBe(204);
    expect(outRes.headers.get('set-cookie')).toContain('bdl_session=;');

    // Clearing the cookie is only half of it. A cookie that was copied off the
    // machine has to die server-side too, or "sign out" is decoration.
    const after = await route(new Request('http://relay.test/api/me', { headers: { cookie } }));
    expect(after.status).toBe(401);
  });

  test('logout without a session is not an error', async () => {
    const { config } = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });
    const route = createRouter({ config, logger, repos: freshRepos() });
    const res = await route(new Request('http://relay.test/auth/logout', { method: 'POST' }));
    expect(res.status).toBe(204);
  });

  test('callback with mismatched state is rejected', async () => {
    const { config } = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });
    const route = createRouter({ config, logger, repos: freshRepos(), fetchImpl: mockFetch });
    const res = await route(
      new Request('http://relay.test/auth/github/callback?code=abc&state=evil', {
        headers: { cookie: 'bdl_oauth_state=xyz' },
      }),
    );
    expect(res.status).toBe(400);
  });

  test('with an org gate, login requests the read:org scope', async () => {
    const { config } = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ALLOWED_GITHUB_ORG: 'Acme' });
    const route = createRouter({ config, logger, repos: freshRepos() });
    const res = await route(new Request('http://relay.test/auth/github/login'));
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toContain('read:org');
  });

  test('org member is signed in', async () => {
    const { config } = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ALLOWED_GITHUB_ORG: 'Acme' });
    const repos = freshRepos();
    const route = createRouter({ config, logger, repos, fetchImpl: makeMockFetch('active') });
    const res = await route(
      new Request('http://relay.test/auth/github/callback?code=abc&state=xyz', { headers: { cookie: 'bdl_oauth_state=xyz' } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('bdl_session='))).toBe(true);
  });

  test('non-member is denied — no session, redirected with ?denied=org', async () => {
    const { config } = loadConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', ALLOWED_GITHUB_ORG: 'Acme' });
    const repos = freshRepos();
    const route = createRouter({ config, logger, repos, fetchImpl: makeMockFetch('none') });
    const res = await route(
      new Request('http://relay.test/auth/github/callback?code=abc&state=xyz', { headers: { cookie: 'bdl_oauth_state=xyz' } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('denied=org');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('bdl_session='))).toBe(false);
    // And no user was created.
    expect(repos.getUserBySessionToken('anything')).toBeNull();
  });
});
