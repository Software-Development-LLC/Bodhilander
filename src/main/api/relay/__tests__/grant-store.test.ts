/**
 * Grant minting rules.
 *
 * `grant-store.ts` reaches the real database through `getDatabase()`, so the
 * SQL paths are exercised by the tunnel and schema tests rather than here.
 * What is worth pinning without a database is the set of refusals in
 * `mintGrant` — the ones that stop a grant being wider than it looks.
 *
 * Run with: bun test src/main/api/relay/__tests__/grant-store.test.ts
 */
import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { buildGrantMessage, formatCertificate, parseCertificate, MINTABLE_ROLES } from '../grants';

const keys = crypto.generateKeyPairSync('ed25519');
const pubB64 = Buffer.from((keys.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString(
  'base64',
);

/**
 * `mintGrant`'s signing half, without its database half. Keeping the check
 * order identical to the real one is the point: the field validation has to
 * happen before anything is written, or a rejected mint leaves a row behind.
 */
function mintCertificateOnly(parts: Parameters<typeof buildGrantMessage>[0]): string {
  const payload = buildGrantMessage(parts);
  return formatCertificate(payload, new Uint8Array(crypto.sign(null, Buffer.from(payload), keys.privateKey)));
}

const parts = {
  grantId: 'g-1',
  machineId: 'm-1',
  relayOrigin: 'https://relay.example.com',
  granteeUserId: 'u-1',
  role: 'viewer' as const,
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_003_600_000,
};

describe('a minted certificate round-trips', () => {
  test('parses back to exactly the parts it was minted from', () => {
    expect(parseCertificate(mintCertificateOnly(parts))!.parts).toEqual(parts);
  });

  test('and its signature verifies against the machine key', () => {
    const parsed = parseCertificate(mintCertificateOnly(parts))!;
    const key = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pubB64, 'base64').toString('base64url') },
      format: 'jwk',
    });
    expect(crypto.verify(null, Buffer.from(parsed.payload), key, Buffer.from(parsed.signature))).toBe(true);
  });
});

describe('what cannot be minted', () => {
  test('owner is not a mintable role', () => {
    // There is deliberately no persisted owner certificate — a machine-wide
    // bearer credential in the relay's database is a skeleton key.
    expect(MINTABLE_ROLES as readonly string[]).not.toContain('owner');
  });

  test('a role outside the table cannot be serialised', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parseCertificate(mintCertificateOnly({ ...parts, role: 'admin' as any })),
    ).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseCertificate(mintCertificateOnly({ ...parts, role: 'admin' as any }))).toBeNull();
  });

  test('a field with a line break is refused before anything is signed', () => {
    expect(() => buildGrantMessage({ ...parts, granteeUserId: 'u\nadmin' })).toThrow(/line break/);
  });
});
