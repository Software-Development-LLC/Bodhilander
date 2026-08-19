/**
 * The sharing HTTP surface (M5.2).
 *
 * The tests that matter here are the boundaries: who may mint an invite, who
 * may see one, who may redeem it, and what the responses are allowed to
 * contain. The invite lifecycle itself is covered in `sharing.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config';
import { createLogger } from './logger';
import { openDb, type RelayDb } from './db';
import { createRepositories, type Repositories, type User } from './repositories';
import { createRouter } from './http';
import { buildShareCreateMessage } from './protocol';
import { toArrayBuffer } from './crypto';

const logger = createLogger('error');
const { config } = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://relay.test' });

interface Fixture {
  db: RelayDb;
  repos: Repositories;
  route: ReturnType<typeof createRouter>;
  owner: User;
  guest: User;
  machineId: string;
  ownerCookie: string;
  guestCookie: string;
  sign: (m: Uint8Array) => Promise<Uint8Array>;
  redeemed: string[];
  revoked: string[];
}

async function fixture(): Promise<Fixture> {
  const db = openDb(':memory:');
  const repos = createRepositories(db);
  const redeemed: string[] = [];
  const revoked: string[] = [];
  const route = createRouter({
    config,
    logger,
    repos,
    onGrantRedeemed: (g) => redeemed.push(g.id),
    onGrantRevoked: (g) => revoked.push(g.id),
  });

  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const sign = async (m: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, toArrayBuffer(m)));

  const owner = repos.upsertGithubUser({
    providerUserId: '1',
    displayName: 'Will',
    login: 'will-l',
    email: null,
    avatarUrl: null,
  });
  const guest = repos.upsertGithubUser({
    providerUserId: '2',
    displayName: 'Dana',
    login: 'dana-k',
    email: null,
    avatarUrl: null,
  });
  const code = repos.createLinkCode('laptop', pub, new Uint8Array(32).fill(1), 600).code;
  const claim = repos.claimLinkCode(code, owner.id);

  return {
    db,
    repos,
    route,
    owner,
    guest,
    machineId: claim.ok ? claim.machine.id : '',
    ownerCookie: `bdl_session=${repos.createSession(owner.id, 3600).token}`,
    guestCookie: `bdl_session=${repos.createSession(guest.id, 3600).token}`,
    sign,
    redeemed,
    revoked,
  };
}

async function createInvite(f: Fixture, over: Record<string, unknown> = {}) {
  const body = {
    expectedGithubLogin: 'dana-k',
    role: 'viewer',
    grantTtlSeconds: 4 * 3600,
    inviteTtlSeconds: 3600,
    issuedAt: Date.now(),
    ...over,
  } as Record<string, unknown>;
  const signature = Buffer.from(
    await f.sign(
      buildShareCreateMessage({
        machineId: (over.machineId as string) ?? f.machineId,
        expectedGithubLogin: (body.expectedGithubLogin as string | null) ?? '',
        role: body.role as string,
        grantTtlSeconds: body.grantTtlSeconds as number,
        inviteTtlSeconds: body.inviteTtlSeconds as number,
        issuedAt: body.issuedAt as number,
      }),
    ),
  ).toString('base64');
  delete over.machineId;
  return f.route(
    new Request(`http://relay.test/api/machines/${f.machineId}/shares`, {
      method: 'POST',
      body: JSON.stringify({ ...body, signature }),
    }),
  );
}

describe('POST /api/machines/:id/shares', () => {
  test('returns the code and NEVER a URL', async () => {
    // If the relay authored the invite link it could put its own fingerprint
    // in the `#fp=` fragment and serve the matching key, making the guest's
    // three-way check agree perfectly and manufacturing a false "verified".
    // The desktop composes the URL locally.
    const f = await fixture();
    try {
      const res = await createInvite(f);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.code).toBe('string');
      const serialised = JSON.stringify(body);
      expect(serialised).not.toContain('http');
      expect(serialised).not.toContain('#fp');
      expect(Object.keys(body).sort()).toEqual(['code', 'expiresAt', 'inviteId']);
    } finally {
      f.db.close();
    }
  });

  test('a session cookie alone cannot mint an invite', async () => {
    // Only the machine can countersign a grant, so only the machine may offer
    // one — a stolen session cookie must not be enough.
    const f = await fixture();
    try {
      const res = await f.route(
        new Request(`http://relay.test/api/machines/${f.machineId}/shares`, {
          method: 'POST',
          headers: { cookie: f.ownerCookie },
          body: JSON.stringify({
            expectedGithubLogin: null,
            role: 'viewer',
            grantTtlSeconds: 3600,
            inviteTtlSeconds: 3600,
            issuedAt: Date.now(),
            signature: Buffer.alloc(64).toString('base64'),
          }),
        }),
      );
      expect(res.status).toBe(401);
    } finally {
      f.db.close();
    }
  });

  test('the addressing is covered by the signature', async () => {
    // An open link is a materially different thing from an addressed one; the
    // relay must not be able to downgrade one into the other in transit.
    const f = await fixture();
    try {
      const issuedAt = Date.now();
      const signature = Buffer.from(
        await f.sign(
          buildShareCreateMessage({
            machineId: f.machineId,
            expectedGithubLogin: 'dana-k',
            role: 'viewer',
            grantTtlSeconds: 3600,
            inviteTtlSeconds: 3600,
            issuedAt,
          }),
        ),
      ).toString('base64');
      const res = await f.route(
        new Request(`http://relay.test/api/machines/${f.machineId}/shares`, {
          method: 'POST',
          // Signed for dana-k, sent as an open link.
          body: JSON.stringify({
            expectedGithubLogin: null,
            role: 'viewer',
            grantTtlSeconds: 3600,
            inviteTtlSeconds: 3600,
            issuedAt,
            signature,
          }),
        }),
      );
      expect(res.status).toBe(401);
    } finally {
      f.db.close();
    }
  });

  test('rejects a role outside the mintable set', async () => {
    const f = await fixture();
    try {
      expect((await createInvite(f, { role: 'owner' })).status).toBe(400);
      expect((await createInvite(f, { role: 'admin' })).status).toBe(400);
    } finally {
      f.db.close();
    }
  });

  test('rejects a TTL beyond the ceiling, or one that is not a whole count', async () => {
    const f = await fixture();
    try {
      expect((await createInvite(f, { grantTtlSeconds: 400 * 24 * 3600 })).status).toBe(400);
      expect((await createInvite(f, { inviteTtlSeconds: 400 * 24 * 3600 })).status).toBe(400);
      expect((await createInvite(f, { grantTtlSeconds: -1 })).status).toBe(400);
      expect((await createInvite(f, { grantTtlSeconds: 1.5 })).status).toBe(400);
    } finally {
      f.db.close();
    }
  });

  test('accepts 0 — the owner asking for access that lasts until they revoke it', async () => {
    // The relay is not the authority on how long a grant lives: the machine
    // that signs the certificate is, and it ends the grant on revoke or on a
    // restart of the shared session whatever the clock says. Storing 0 is
    // storing the owner's answer, not granting anything.
    const f = await fixture();
    try {
      const res = await createInvite(f, { grantTtlSeconds: 0 });
      expect(res.status).toBe(200);
      const { inviteId } = (await res.json()) as { inviteId: string };
      expect(f.repos.listShareInvites(f.machineId).find((i) => i.id === inviteId)?.grant_ttl_seconds).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test('rejects a stale request', async () => {
    const f = await fixture();
    try {
      expect((await createInvite(f, { issuedAt: Date.now() - 10 * 60 * 1000 })).status).toBe(400);
    } finally {
      f.db.close();
    }
  });
});

describe('GET /api/machines/:id/shares', () => {
  test('the owner sees invites and grants, without codes or hashes', async () => {
    const f = await fixture();
    try {
      await createInvite(f);
      const res = await f.route(
        new Request(`http://relay.test/api/machines/${f.machineId}/shares`, { headers: { cookie: f.ownerCookie } }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { invites: Record<string, unknown>[] };
      expect(body.invites).toHaveLength(1);
      expect(body.invites[0]).not.toHaveProperty('code');
      expect(body.invites[0]).not.toHaveProperty('code_hash');
      expect(body.invites[0]!.expectedGithubLogin).toBe('dana-k');
    } finally {
      f.db.close();
    }
  });

  test('someone else gets 404, not 403', async () => {
    // A 403 would confirm the machine exists.
    const f = await fixture();
    try {
      const res = await f.route(
        new Request(`http://relay.test/api/machines/${f.machineId}/shares`, { headers: { cookie: f.guestCookie } }),
      );
      expect(res.status).toBe(404);
    } finally {
      f.db.close();
    }
  });
});

describe('POST /api/shares/redeem', () => {
  async function codeFor(f: Fixture, over: Record<string, unknown> = {}) {
    const res = await createInvite(f, over);
    return ((await res.json()) as { code: string }).code;
  }

  test('the addressed account redeems into a PENDING grant and notifies the gateway', async () => {
    const f = await fixture();
    try {
      const code = await codeFor(f);
      const res = await f.route(
        new Request('http://relay.test/api/shares/redeem', {
          method: 'POST',
          headers: { cookie: f.guestCookie },
          body: JSON.stringify({ code }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      // The guest is waiting on the owner; the client must render that rather
      // than a broken terminal.
      expect(body.status).toBe('pending');
      expect(f.redeemed).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });

  test('a different account is refused', async () => {
    const f = await fixture();
    try {
      const code = await codeFor(f);
      const other = f.repos.upsertGithubUser({
        providerUserId: '3',
        displayName: 'Other',
        login: 'other',
        email: null,
        avatarUrl: null,
      });
      const res = await f.route(
        new Request('http://relay.test/api/shares/redeem', {
          method: 'POST',
          headers: { cookie: `bdl_session=${f.repos.createSession(other.id, 3600).token}` },
          body: JSON.stringify({ code }),
        }),
      );
      expect(res.status).toBe(409);
      expect((await res.json()) as unknown).toEqual({ error: 'invite_wrong_account' });
      expect(f.redeemed).toHaveLength(0);
    } finally {
      f.db.close();
    }
  });

  test('requires a session', async () => {
    const f = await fixture();
    try {
      const code = await codeFor(f);
      const res = await f.route(
        new Request('http://relay.test/api/shares/redeem', { method: 'POST', body: JSON.stringify({ code }) }),
      );
      expect(res.status).toBe(401);
    } finally {
      f.db.close();
    }
  });
});

describe('GET /api/machines with a grant', () => {
  test('a bound grant appears as a grantee entry carrying its certificate', async () => {
    const f = await fixture();
    try {
      const code = ((await (await createInvite(f)).json()) as { code: string }).code;
      await f.route(
        new Request('http://relay.test/api/shares/redeem', {
          method: 'POST',
          headers: { cookie: f.guestCookie },
          body: JSON.stringify({ code }),
        }),
      );
      const grantId = f.repos.listGrantsForUser(f.guest.id)[0]!.id;

      // Before the agent countersigns, there is nothing to present.
      let res = await f.route(new Request('http://relay.test/api/machines', { headers: { cookie: f.guestCookie } }));
      expect(((await res.json()) as { machines: unknown[] }).machines).toHaveLength(0);

      f.repos.bindGrantCertificate(grantId, 'grant:v1.aa.bb', Date.now() + 3_600_000);
      res = await f.route(new Request('http://relay.test/api/machines', { headers: { cookie: f.guestCookie } }));
      const machines = ((await res.json()) as { machines: Record<string, unknown>[] }).machines;
      expect(machines).toHaveLength(1);
      expect(machines[0]).toMatchObject({
        relation: 'grantee',
        // Labelled by person: "machine" is owner vocabulary.
        ownerName: 'Will',
        role: 'viewer',
        certificate: 'grant:v1.aa.bb',
        grantId,
      });
    } finally {
      f.db.close();
    }
  });

  test('the owner still sees their own machine as owner', async () => {
    const f = await fixture();
    try {
      const res = await f.route(new Request('http://relay.test/api/machines', { headers: { cookie: f.ownerCookie } }));
      const machines = ((await res.json()) as { machines: Record<string, unknown>[] }).machines;
      expect(machines).toHaveLength(1);
      expect(machines[0]!.relation).toBe('owner');
      expect(machines[0]!.certificate).toBeNull();
    } finally {
      f.db.close();
    }
  });
});

describe('DELETE /api/shares/:grantId', () => {
  async function boundGrant(f: Fixture) {
    const code = ((await (await createInvite(f)).json()) as { code: string }).code;
    await f.route(
      new Request('http://relay.test/api/shares/redeem', {
        method: 'POST',
        headers: { cookie: f.guestCookie },
        body: JSON.stringify({ code }),
      }),
    );
    const grantId = f.repos.listGrantsForUser(f.guest.id)[0]!.id;
    f.repos.bindGrantCertificate(grantId, 'grant:v1.aa.bb', Date.now() + 3_600_000);
    return grantId;
  }

  test('the owner may revoke', async () => {
    const f = await fixture();
    try {
      const grantId = await boundGrant(f);
      const res = await f.route(
        new Request(`http://relay.test/api/shares/${grantId}`, { method: 'DELETE', headers: { cookie: f.ownerCookie } }),
      );
      expect(res.status).toBe(204);
      expect(f.repos.getMachineAccess(f.machineId, f.guest.id)).toEqual({ relation: 'none' });
      expect(f.revoked).toEqual([grantId]);
    } finally {
      f.db.close();
    }
  });

  test('the grantee may hand access back', async () => {
    const f = await fixture();
    try {
      const grantId = await boundGrant(f);
      const res = await f.route(
        new Request(`http://relay.test/api/shares/${grantId}`, { method: 'DELETE', headers: { cookie: f.guestCookie } }),
      );
      expect(res.status).toBe(204);
    } finally {
      f.db.close();
    }
  });

  test('a third party gets 404, not 403', async () => {
    const f = await fixture();
    try {
      const grantId = await boundGrant(f);
      const other = f.repos.upsertGithubUser({
        providerUserId: '3',
        displayName: 'Other',
        login: 'other',
        email: null,
        avatarUrl: null,
      });
      const res = await f.route(
        new Request(`http://relay.test/api/shares/${grantId}`, {
          method: 'DELETE',
          headers: { cookie: `bdl_session=${f.repos.createSession(other.id, 3600).token}` },
        }),
      );
      expect(res.status).toBe(404);
      // And it really did not revoke.
      expect(f.repos.getGrant(grantId)!.status).toBe('active');
    } finally {
      f.db.close();
    }
  });

  test('/api/shares/redeem is not treated as a grant id', async () => {
    // The two routes share a prefix; a careless matcher would let DELETE
    // /api/shares/redeem look like a grant deletion.
    const f = await fixture();
    try {
      const res = await f.route(
        new Request('http://relay.test/api/shares/redeem', { method: 'DELETE', headers: { cookie: f.ownerCookie } }),
      );
      expect(res.status).toBe(404);
    } finally {
      f.db.close();
    }
  });
});
