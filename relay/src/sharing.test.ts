import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
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
