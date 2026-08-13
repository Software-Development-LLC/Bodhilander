import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type RelayDb } from './db';
import { createRepositories, type Repositories } from './repositories';
import {
  buildGrantMessage,
  formatCertificate,
  GRANT_VERSION,
  MINTABLE_ROLES,
  parseCertificate,
  type GrantParts,
} from './protocol';
import { verifyEd25519, fromBase64 } from './crypto';

/**
 * The relay's half of the cross-tree fixture check.
 *
 * The relay never evaluates capabilities — it is a coarse gate and the
 * certificate is opaque to it (§2). What it must agree with the desktop on is
 * the certificate *bytes*, since it stores and re-serves them, and the set of
 * mintable roles, since `002_sharing.sql` has a CHECK constraint naming them.
 * The role→capability table is asserted on the enforcing side, in
 * `src/main/api/relay/__tests__/grants.test.ts`.
 */
const FIXTURE = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dir, '../../fixtures/sharing-v1.json'), 'utf8'),
) as {
  certificate: {
    ed25519PubB64: string;
    parts: GrantParts;
    payload: string;
    payloadB64url: string;
    signatureB64url: string;
    certificate: string;
  };
  policy: { mintableRoles: string[] };
};

const VEC = FIXTURE.certificate;

describe('grant certificate wire format', () => {
  test('the builder reproduces the fixture payload byte for byte', () => {
    expect(Buffer.from(buildGrantMessage(VEC.parts)).toString('utf8')).toBe(VEC.payload);
  });

  test('the fixture signature verifies over that payload', async () => {
    const parsed = parseCertificate(VEC.certificate);
    expect(parsed).not.toBeNull();
    const pub = fromBase64(VEC.ed25519PubB64)!;
    expect(await verifyEd25519(pub, parsed!.signature, parsed!.payload)).toBe(true);
  });

  test('formatting reproduces the fixture certificate string', () => {
    const payload = buildGrantMessage(VEC.parts);
    const sig = new Uint8Array(Buffer.from(VEC.signatureB64url, 'base64url'));
    expect(formatCertificate(payload, sig)).toBe(VEC.certificate);
  });

  test('parsing yields exactly the fixture parts', () => {
    expect(parseCertificate(VEC.certificate)!.parts).toEqual(VEC.parts);
  });

  test('mintable roles match the fixture and exclude owner', () => {
    // There is deliberately no persisted owner certificate (§3) — one sitting
    // in the relay's database would be a skeleton key.
    expect([...MINTABLE_ROLES] as string[]).toEqual(FIXTURE.policy.mintableRoles);
    expect(FIXTURE.policy.mintableRoles).not.toContain('owner');
  });
});

describe('parseCertificate rejects malformed input', () => {
  test('junk of every shape returns null rather than throwing', () => {
    for (const bad of ['', GRANT_VERSION, 'grant:v1.a', 'a.b.c.d', 'grant:v2.a.b', null, 42, {}, []]) {
      expect(parseCertificate(bad)).toBeNull();
    }
  });

  test('a payload that would not re-serialise identically is refused', () => {
    const b64 = Buffer.from(`${VEC.payload}\n`, 'utf8').toString('base64url');
    expect(parseCertificate(`grant:v1.${b64}.${VEC.signatureB64url}`)).toBeNull();
  });

  test('the signed inner version must agree with the outer prefix', () => {
    const b64 = Buffer.from(VEC.payload.replace('grant:v1', 'grant:v2'), 'utf8').toString('base64url');
    expect(parseCertificate(`grant:v1.${b64}.${VEC.signatureB64url}`)).toBeNull();
  });

  test('a timestamp past MAX_SAFE_INTEGER returns null rather than throwing', () => {
    // The digit count alone cannot express the bound: 16 digits admits
    // 9999999999999999, which is not a safe integer, and handing that to the
    // builder would throw — on a function contracted to return null.
    const payload = VEC.payload
      .replace(String(VEC.parts.issuedAt), '9999999999999999')
      .replace(String(VEC.parts.expiresAt), '9999999999999999');
    const b64 = Buffer.from(payload, 'utf8').toString('base64url');
    let result: unknown;
    expect(() => {
      result = parseCertificate(`grant:v1.${b64}.${VEC.signatureB64url}`);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  test('owner is not accepted as a certificate role', () => {
    const b64 = Buffer.from(VEC.payload.replace('\nviewer\n', '\nowner\n'), 'utf8').toString('base64url');
    expect(parseCertificate(`grant:v1.${b64}.${VEC.signatureB64url}`)).toBeNull();
  });
});

describe('buildGrantMessage line-break safety', () => {
  test('a field containing a newline is refused', () => {
    expect(() => buildGrantMessage({ ...VEC.parts, machineId: 'a\nb' })).toThrow(/line break/);
    expect(() => buildGrantMessage({ ...VEC.parts, relayOrigin: 'a\rb' })).toThrow(/line break/);
  });

  test('empty fields and unsafe timestamps are refused', () => {
    expect(() => buildGrantMessage({ ...VEC.parts, granteeUserId: '' })).toThrow();
    expect(() => buildGrantMessage({ ...VEC.parts, issuedAt: Number.MAX_VALUE })).toThrow();
  });
});

// --- 002_sharing schema and getMachineAccess ---

interface Fixture {
  db: RelayDb;
  repos: Repositories;
  ownerId: string;
  guestId: string;
  machineId: string;
}

function freshFixture(): Fixture {
  const db = openDb(':memory:');
  const repos = createRepositories(db);
  const owner = repos.upsertGithubUser({ providerUserId: '1', displayName: 'Owner', login: 'owner', email: null, avatarUrl: null });
  const guest = repos.upsertGithubUser({ providerUserId: '2', displayName: 'Guest', login: 'guest', email: null, avatarUrl: null });
  const code = repos.createLinkCode('m', new Uint8Array(32).fill(7), new Uint8Array(32).fill(8), 600).code;
  const claim = repos.claimLinkCode(code, owner.id);
  return { db, repos, ownerId: owner.id, guestId: guest.id, machineId: claim.ok ? claim.machine.id : '' };
}

/**
 * Insert a grant directly. There is no repository write path until M5.2 —
 * invite redemption is what creates a grant — so the schema and the read path
 * are exercised from SQL here rather than through an interface method that
 * would otherwise have no caller.
 */
interface GrantOverrides {
  machine_id?: string;
  grantee_user_id?: string;
  certificate?: string | null;
  role?: string;
  status?: string;
  expires_at?: number | null;
}

function insertGrant(f: Fixture, over: GrantOverrides = {}): string {
  const id = crypto.randomUUID();
  f.db
    .query(
      `INSERT INTO machine_grants
         (id, machine_id, grantee_user_id, certificate, role, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      over.machine_id ?? f.machineId,
      over.grantee_user_id ?? f.guestId,
      over.certificate === undefined ? 'grant:v1.x.y' : over.certificate,
      over.role ?? 'viewer',
      over.status ?? 'active',
      Date.now(),
      over.expires_at === undefined ? Date.now() + 3_600_000 : over.expires_at,
    );
  return id;
}

describe('002_sharing schema', () => {
  test('role columns accept exactly the mintable roles', () => {
    const f = freshFixture();
    try {
      for (const role of FIXTURE.policy.mintableRoles) {
        expect(() => insertGrant(f, { role })).not.toThrow();
      }
      // The CHECK constraint and MINTABLE_ROLES must not drift apart — an
      // 'owner' row here would be a persisted skeleton key.
      expect(() => insertGrant(f, { role: 'owner' })).toThrow();
      expect(() => insertGrant(f, { role: 'admin' })).toThrow();
    } finally {
      f.db.close();
    }
  });

  test('grants are deleted with their machine', () => {
    const f = freshFixture();
    try {
      insertGrant(f);
      f.db.query('DELETE FROM machines WHERE id = ?').run(f.machineId);
      expect(f.db.query('SELECT COUNT(*) AS n FROM machine_grants').get()).toEqual({ n: 0 });
    } finally {
      f.db.close();
    }
  });

  test('many grants per person on one machine are allowed', () => {
    // Sharing a second session with the same colleague must be a second grant,
    // never an in-place widening of the first — so no UNIQUE(machine, grantee).
    const f = freshFixture();
    try {
      insertGrant(f);
      expect(() => insertGrant(f)).not.toThrow();
      expect(f.db.query('SELECT COUNT(*) AS n FROM machine_grants').get()).toEqual({ n: 2 });
    } finally {
      f.db.close();
    }
  });
});

describe('getMachineAccess', () => {
  test('the machine owner is the owner', () => {
    const f = freshFixture();
    try {
      const access = f.repos.getMachineAccess(f.machineId, f.ownerId);
      expect(access.relation).toBe('owner');
    } finally {
      f.db.close();
    }
  });

  test('a stranger gets none', () => {
    const f = freshFixture();
    try {
      expect(f.repos.getMachineAccess(f.machineId, f.guestId)).toEqual({ relation: 'none' });
    } finally {
      f.db.close();
    }
  });

  test('an unknown machine is indistinguishable from one that is not yours', () => {
    // Telling those apart would make the socket an oracle for which machine
    // ids exist.
    const f = freshFixture();
    try {
      expect(f.repos.getMachineAccess(crypto.randomUUID(), f.guestId)).toEqual({ relation: 'none' });
    } finally {
      f.db.close();
    }
  });

  test('an active, bound, unexpired grant makes a grantee', () => {
    const f = freshFixture();
    try {
      const id = insertGrant(f);
      const access = f.repos.getMachineAccess(f.machineId, f.guestId);
      expect(access.relation).toBe('grantee');
      expect(access.relation === 'grantee' && access.grant.id).toBe(id);
    } finally {
      f.db.close();
    }
  });

  test.each([
    ['pending', { status: 'pending' }],
    ['revoked', { status: 'revoked' }],
    ['expired', { expires_at: Date.now() - 1 }],
    ['not yet countersigned', { certificate: null }],
    ['never bound', { expires_at: null }],
  ])('a %s grant does not confer access', (_label, over) => {
    const f = freshFixture();
    try {
      insertGrant(f, over);
      expect(f.repos.getMachineAccess(f.machineId, f.guestId)).toEqual({ relation: 'none' });
    } finally {
      f.db.close();
    }
  });

  test('a grant on another machine does not leak across', () => {
    const f = freshFixture();
    try {
      const other = f.repos.createLinkCode('m2', new Uint8Array(32).fill(9), new Uint8Array(32).fill(9), 600).code;
      const claim = f.repos.claimLinkCode(other, f.ownerId);
      insertGrant(f, { machine_id: claim.ok ? claim.machine.id : '' });
      expect(f.repos.getMachineAccess(f.machineId, f.guestId)).toEqual({ relation: 'none' });
    } finally {
      f.db.close();
    }
  });

  test('ownership wins even when a grant also exists', () => {
    const f = freshFixture();
    try {
      insertGrant(f, { grantee_user_id: f.ownerId });
      expect(f.repos.getMachineAccess(f.machineId, f.ownerId).relation).toBe('owner');
    } finally {
      f.db.close();
    }
  });
});

// --- invite lifecycle (M5.2) ---

function guestUser(f: Fixture, login: string | null, providerUserId = '900') {
  const u = f.repos.upsertGithubUser({
    providerUserId,
    displayName: 'Guest',
    login: login ?? '',
    email: null,
    avatarUrl: null,
  });
  if (login === null) f.db.query('UPDATE users SET github_login = NULL WHERE id = ?').run(u.id);
  return f.repos.getUser(u.id)!;
}

const inviteInput = (f: Fixture, over: Partial<Parameters<Repositories['createShareInvite']>[0]> = {}) => ({
  machineId: f.machineId,
  expectedGithubLogin: 'dana-k',
  role: 'viewer' as const,
  label: null,
  grantTtlSeconds: 4 * 3600,
  inviteTtlSeconds: 3600,
  ...over,
});

describe('createShareInvite', () => {
  test('returns the raw code once and stores only its hash', () => {
    // Same discipline as link codes: a database leak must not yield a usable
    // invite.
    const f = freshFixture();
    try {
      const { invite, code } = f.repos.createShareInvite(inviteInput(f));
      expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      expect(invite.code_hash).not.toBe(code);
      const raw = f.db.query('SELECT * FROM share_invites WHERE id = ?').get(invite.id) as Record<string, unknown>;
      expect(JSON.stringify(raw)).not.toContain(code);
    } finally {
      f.db.close();
    }
  });

  test('normalises the addressed login to lowercase', () => {
    // GitHub logins compare case-insensitively; an invite for `Dana-K` must
    // match a session for `dana-k`.
    const f = freshFixture();
    try {
      const { invite } = f.repos.createShareInvite(inviteInput(f, { expectedGithubLogin: '  Dana-K  ' }));
      expect(invite.expected_github_login).toBe('dana-k');
    } finally {
      f.db.close();
    }
  });

  test('an empty login is an open link, not an invite addressed to nobody', () => {
    const f = freshFixture();
    try {
      expect(f.repos.createShareInvite(inviteInput(f, { expectedGithubLogin: '   ' })).invite.expected_github_login).toBeNull();
    } finally {
      f.db.close();
    }
  });
});

describe('redeemShareInvite', () => {
  test('an addressed invite redeemed by the named account creates a PENDING grant', () => {
    // Pending, not active: redeeming is asking. Until the owner's agent
    // countersigns, getMachineAccess will not honour it.
    const f = freshFixture();
    try {
      const { code } = f.repos.createShareInvite(inviteInput(f));
      const guest = guestUser(f, 'dana-k');
      const result = f.repos.redeemShareInvite(code, guest, crypto.randomUUID());

      expect(result.ok).toBe(true);
      expect(result.ok === true && result.grant.status).toBe('pending');
      expect(result.ok === true && result.grant.certificate).toBeNull();
      expect(f.repos.getMachineAccess(f.machineId, guest.id)).toEqual({ relation: 'none' });
    } finally {
      f.db.close();
    }
  });

  test('a different account cannot redeem an addressed invite', () => {
    // The whole point of addressing: a leaked link is not a working link.
    const f = freshFixture();
    try {
      const { code } = f.repos.createShareInvite(inviteInput(f));
      const result = f.repos.redeemShareInvite(code, guestUser(f, 'someone-else'), crypto.randomUUID());
      expect(result).toEqual({ ok: false, reason: 'wrong_account' });
    } finally {
      f.db.close();
    }
  });

  test('login matching is case-insensitive', () => {
    const f = freshFixture();
    try {
      const { code } = f.repos.createShareInvite(inviteInput(f, { expectedGithubLogin: 'dana-k' }));
      expect(f.repos.redeemShareInvite(code, guestUser(f, 'DANA-K'), crypto.randomUUID()).ok).toBe(true);
    } finally {
      f.db.close();
    }
  });

  test('a user with no stored login cannot satisfy an addressed invite', () => {
    // Users predating migration 003 have a NULL login. A NULL must never read
    // as "matches anything".
    const f = freshFixture();
    try {
      const { code } = f.repos.createShareInvite(inviteInput(f));
      const result = f.repos.redeemShareInvite(code, guestUser(f, null), crypto.randomUUID());
      expect(result).toEqual({ ok: false, reason: 'wrong_account' });
    } finally {
      f.db.close();
    }
  });

  test('an open link may be redeemed by anyone', () => {
    const f = freshFixture();
    try {
      const { code } = f.repos.createShareInvite(inviteInput(f, { expectedGithubLogin: null }));
      expect(f.repos.redeemShareInvite(code, guestUser(f, 'anyone'), crypto.randomUUID()).ok).toBe(true);
    } finally {
      f.db.close();
    }
  });

  test('the machine owner cannot redeem their own invite', () => {
    // It would create a grant that shadows ownership with something narrower.
    const f = freshFixture();
    try {
      const { code } = f.repos.createShareInvite(inviteInput(f, { expectedGithubLogin: null }));
      const owner = f.repos.getUser(f.ownerId)!;
      expect(f.repos.redeemShareInvite(code, owner, crypto.randomUUID())).toEqual({ ok: false, reason: 'own_machine' });
    } finally {
      f.db.close();
    }
  });

  test('a code cannot be redeemed twice', () => {
    const f = freshFixture();
    try {
      const { code } = f.repos.createShareInvite(inviteInput(f, { expectedGithubLogin: null }));
      expect(f.repos.redeemShareInvite(code, guestUser(f, 'a', '901'), crypto.randomUUID()).ok).toBe(true);
      expect(f.repos.redeemShareInvite(code, guestUser(f, 'b', '902'), crypto.randomUUID())).toEqual({
        ok: false,
        reason: 'already_used',
      });
    } finally {
      f.db.close();
    }
  });

  test('a revoked invite is refused, and says so distinctly from expired', () => {
    // Distinct reasons because the guest-facing copy differs.
    const f = freshFixture();
    try {
      const { invite, code } = f.repos.createShareInvite(inviteInput(f, { expectedGithubLogin: null }));
      expect(f.repos.revokeShareInvite(f.machineId, invite.id)).toBe(true);
      expect(f.repos.redeemShareInvite(code, guestUser(f, 'a'), crypto.randomUUID())).toEqual({
        ok: false,
        reason: 'revoked',
      });
    } finally {
      f.db.close();
    }
  });

  test('an unknown code is not distinguishable from a wrong one', () => {
    const f = freshFixture();
    try {
      expect(f.repos.redeemShareInvite('ZZZZ-ZZZZ', guestUser(f, 'a'), crypto.randomUUID())).toEqual({
        ok: false,
        reason: 'not_found',
      });
    } finally {
      f.db.close();
    }
  });

  test('every attempt is counted, including failures', () => {
    // Guessing should be visible rather than silent.
    const f = freshFixture();
    try {
      const { invite, code } = f.repos.createShareInvite(inviteInput(f));
      f.repos.redeemShareInvite(code, guestUser(f, 'wrong', '901'), crypto.randomUUID());
      f.repos.redeemShareInvite(code, guestUser(f, 'also-wrong', '902'), crypto.randomUUID());
      const row = f.db.query('SELECT attempt_count FROM share_invites WHERE id = ?').get(invite.id);
      expect(row).toEqual({ attempt_count: 2 });
    } finally {
      f.db.close();
    }
  });

  test('revoking an invite belonging to another machine does nothing', () => {
    const f = freshFixture();
    try {
      const { invite } = f.repos.createShareInvite(inviteInput(f));
      expect(f.repos.revokeShareInvite(crypto.randomUUID(), invite.id)).toBe(false);
    } finally {
      f.db.close();
    }
  });
});

describe('binding a redeemed grant', () => {
  function redeemed(f: Fixture) {
    const { code } = f.repos.createShareInvite(inviteInput(f, { expectedGithubLogin: null }));
    const guest = guestUser(f, 'dana-k');
    const result = f.repos.redeemShareInvite(code, guest, crypto.randomUUID());
    if (!result.ok) throw new Error('redeem failed');
    return { guest, grantId: result.grant.id };
  }

  test('binding a certificate makes the grantee reachable', () => {
    const f = freshFixture();
    try {
      const { guest, grantId } = redeemed(f);
      expect(f.repos.bindGrantCertificate(grantId, 'grant:v1.x.y', Date.now() + 3_600_000)).toBe(true);
      expect(f.repos.getMachineAccess(f.machineId, guest.id).relation).toBe('grantee');
    } finally {
      f.db.close();
    }
  });

  test('a grant cannot be bound twice', () => {
    // A replayed share:bind must not swap the certificate under a live guest.
    const f = freshFixture();
    try {
      const { grantId } = redeemed(f);
      expect(f.repos.bindGrantCertificate(grantId, 'grant:v1.a.a', Date.now() + 3_600_000)).toBe(true);
      expect(f.repos.bindGrantCertificate(grantId, 'grant:v1.b.b', Date.now() + 3_600_000)).toBe(false);
    } finally {
      f.db.close();
    }
  });

  test('a revoked grant cannot be resurrected by binding', () => {
    const f = freshFixture();
    try {
      const { grantId } = redeemed(f);
      expect(f.repos.revokeGrant(grantId)).toBe(true);
      expect(f.repos.bindGrantCertificate(grantId, 'grant:v1.x.y', Date.now() + 3_600_000)).toBe(false);
    } finally {
      f.db.close();
    }
  });

  test('revoking ends access immediately', () => {
    const f = freshFixture();
    try {
      const { guest, grantId } = redeemed(f);
      f.repos.bindGrantCertificate(grantId, 'grant:v1.x.y', Date.now() + 3_600_000);
      f.repos.revokeGrant(grantId);
      expect(f.repos.getMachineAccess(f.machineId, guest.id)).toEqual({ relation: 'none' });
    } finally {
      f.db.close();
    }
  });

  test('purgeDeadShares drops revoked grants and stale unredeemed invites', () => {
    const f = freshFixture();
    try {
      const { grantId } = redeemed(f);
      f.repos.revokeGrant(grantId);
      f.repos.createShareInvite(inviteInput(f, { expectedGithubLogin: null, inviteTtlSeconds: -1 }));
      expect(f.repos.purgeDeadShares()).toBeGreaterThanOrEqual(2);
    } finally {
      f.db.close();
    }
  });
});
