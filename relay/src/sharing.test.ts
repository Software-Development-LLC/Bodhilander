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
  const owner = repos.upsertGithubUser({ providerUserId: '1', displayName: 'Owner', email: null, avatarUrl: null });
  const guest = repos.upsertGithubUser({ providerUserId: '2', displayName: 'Guest', email: null, avatarUrl: null });
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
