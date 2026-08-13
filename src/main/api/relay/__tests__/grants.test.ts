import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildGrantMessage,
  checkCertificate,
  COMMAND_CAPS,
  DENY_ALL,
  formatCertificate,
  grantFrom,
  isSessionScoped,
  MINTABLE_ROLES,
  ownerGrant,
  parseCertificate,
  permits,
  ROLE_CAPS,
  verifyCertificateSignature,
  type Cap,
  type GrantParts,
} from '../grants';

const FIXTURE = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dir, '../../../../../fixtures/sharing-v1.json'), 'utf8'),
) as {
  certificate: {
    ed25519PubB64: string;
    ed25519PrivB64url: string;
    parts: GrantParts;
    payload: string;
    payloadB64url: string;
    signatureB64url: string;
    certificate: string;
  };
  policy: {
    caps: Cap[];
    roleCaps: Record<string, Cap[]>;
    mintableRoles: string[];
    commandCaps: Record<string, Cap>;
  };
};

const VEC = FIXTURE.certificate;

/** Sign with the fixture's private half, so we can mint variants. */
function signWithFixtureKey(payload: Uint8Array): Uint8Array {
  const key = crypto.createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(VEC.ed25519PubB64, 'base64').toString('base64url'),
      d: VEC.ed25519PrivB64url,
    },
    format: 'jwk',
  });
  return new Uint8Array(crypto.sign(null, Buffer.from(payload), key));
}

function mint(overrides: Partial<GrantParts> = {}): string {
  return mintWith({ ...VEC.parts, ...overrides });
}

function mintWith(parts: GrantParts): string {
  const payload = buildGrantMessage(parts);
  return formatCertificate(payload, signWithFixtureKey(payload));
}

const ctx = (over: Partial<Parameters<typeof checkCertificate>[1]> = {}) => ({
  machineId: VEC.parts.machineId,
  relayOrigin: VEC.parts.relayOrigin,
  ed25519PubB64: VEC.ed25519PubB64,
  principalUserId: VEC.parts.granteeUserId,
  now: VEC.parts.issuedAt + 1000,
  ...over,
});

describe('the checked-in certificate vector', () => {
  // These are the assertions that catch the relay and the desktop drifting
  // apart. If one fails, the wire format changed — that is the finding, not a
  // reason to regenerate the fixture.
  test('the builder reproduces the fixture payload byte for byte', () => {
    expect(Buffer.from(buildGrantMessage(VEC.parts)).toString('utf8')).toBe(VEC.payload);
  });

  test('the fixture signature verifies over that payload', () => {
    const parsed = parseCertificate(VEC.certificate);
    expect(parsed).not.toBeNull();
    expect(verifyCertificateSignature(parsed!, VEC.ed25519PubB64)).toBe(true);
  });

  test('formatting the vector reproduces the fixture certificate string', () => {
    const payload = buildGrantMessage(VEC.parts);
    const sig = new Uint8Array(Buffer.from(VEC.signatureB64url, 'base64url'));
    expect(formatCertificate(payload, sig)).toBe(VEC.certificate);
  });

  test('parsing the fixture yields exactly the fixture parts', () => {
    expect(parseCertificate(VEC.certificate)!.parts).toEqual(VEC.parts);
  });
});

describe('the checked-in policy', () => {
  test('role capabilities match the fixture', () => {
    for (const [role, caps] of Object.entries(FIXTURE.policy.roleCaps)) {
      expect([...ROLE_CAPS[role as keyof typeof ROLE_CAPS]].sort()).toEqual([...caps].sort());
    }
    expect(Object.keys(ROLE_CAPS).sort()).toEqual(Object.keys(FIXTURE.policy.roleCaps).sort());
  });

  test('the capability vocabulary matches the fixture', () => {
    const used = new Set<Cap>(Object.values(ROLE_CAPS).flatMap((caps) => [...caps]));
    expect([...used].sort()).toEqual([...FIXTURE.policy.caps].sort());
  });

  test('command capabilities match the fixture', () => {
    expect(COMMAND_CAPS).toEqual(FIXTURE.policy.commandCaps);
  });

  test('mintable roles match the fixture and exclude owner', () => {
    expect([...MINTABLE_ROLES]).toEqual(FIXTURE.policy.mintableRoles);
    expect(FIXTURE.policy.mintableRoles).not.toContain('owner');
  });

  test('no guest role can reach create or browse', () => {
    // This is what keeps session:create, group:create and dirs:list closed to
    // every guest, which is a stated v1 non-goal rather than a default.
    for (const role of MINTABLE_ROLES) {
      expect(ROLE_CAPS[role]).not.toContain('create');
      expect(ROLE_CAPS[role]).not.toContain('browse');
    }
  });

  test('every command in the table maps to a capability some role holds', () => {
    const held = new Set<Cap>(Object.values(ROLE_CAPS).flatMap((s) => [...s]));
    for (const cap of Object.values(COMMAND_CAPS)) expect(held.has(cap)).toBe(true);
  });
});

describe('parseCertificate', () => {
  test('rejects a payload whose re-serialisation differs', () => {
    // Non-canonical base64url of the same bytes, a trailing newline, a padded
    // integer — all decode to something, none of them are what we would emit.
    const payload = `${VEC.payload}\n`;
    const b64 = Buffer.from(payload, 'utf8').toString('base64url');
    expect(parseCertificate(`grant:v1.${b64}.${VEC.signatureB64url}`)).toBeNull();
  });

  test('rejects a mismatched inner version even when the outer one is right', () => {
    const payload = VEC.payload.replace('grant:v1', 'grant:v2');
    const b64 = Buffer.from(payload, 'utf8').toString('base64url');
    expect(parseCertificate(`grant:v1.${b64}.${VEC.signatureB64url}`)).toBeNull();
  });

  test('rejects owner as a certificate role', () => {
    const payload = VEC.payload.replace('\nviewer\n', '\nowner\n');
    const b64 = Buffer.from(payload, 'utf8').toString('base64url');
    expect(parseCertificate(`grant:v1.${b64}.${VEC.signatureB64url}`)).toBeNull();
  });

  test('rejects structural junk without throwing', () => {
    for (const bad of ['', 'grant:v1', 'grant:v1.a', 'a.b.c.d', 'grant:v2.a.b', null, 42, {}]) {
      expect(parseCertificate(bad)).toBeNull();
    }
  });

  test('returns null rather than throwing on a timestamp past MAX_SAFE_INTEGER', () => {
    // 16 digits admits 9999999999999999, which is not a safe integer. The
    // builder rejects it by throwing, and this function's contract is to
    // return null on hostile input — so the parser applies the same
    // safe-integer rule itself rather than reaching the builder's check.
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

  test('accepts a 16-digit timestamp that IS a safe integer', () => {
    // The bound is the safe-integer ceiling, not the digit count.
    const safe16 = 9007199254740991; // Number.MAX_SAFE_INTEGER, 16 digits
    const parts = { ...VEC.parts, issuedAt: 1, expiresAt: safe16 };
    expect(parseCertificate(mintWith(parts))!.parts.expiresAt).toBe(safe16);
  });

  test('rejects a signature that is not 64 bytes', () => {
    expect(parseCertificate(`grant:v1.${VEC.payloadB64url}.${Buffer.from('short').toString('base64url')}`)).toBeNull();
  });
});

describe('buildGrantMessage line-break safety', () => {
  test('refuses a field containing a newline', () => {
    // Without this a machineId of "a\nb" shifts every later field up a line,
    // so one set of parts serialises identically to a different set and a
    // signature over one grant verifies as another.
    expect(() => buildGrantMessage({ ...VEC.parts, machineId: 'a\nb' })).toThrow(/line break/);
    expect(() => buildGrantMessage({ ...VEC.parts, granteeUserId: 'a\rb' })).toThrow(/line break/);
  });

  test('refuses empty fields and unsafe timestamps', () => {
    expect(() => buildGrantMessage({ ...VEC.parts, grantId: '' })).toThrow();
    expect(() => buildGrantMessage({ ...VEC.parts, expiresAt: 1.5 })).toThrow();
  });

  test('a forged shift does not collide with a real grant', () => {
    // The concrete attack the guard prevents: cram two fields into one so the
    // remaining lines slide, and the byte string equals a different grant's.
    const honest = buildGrantMessage({ ...VEC.parts, machineId: 'M', relayOrigin: 'R' });
    expect(() => buildGrantMessage({ ...VEC.parts, machineId: 'M\nR', relayOrigin: 'X' })).toThrow();
    expect(Buffer.from(honest).toString('utf8').split('\n')).toHaveLength(8);
  });
});

describe('checkCertificate', () => {
  test('accepts a well-formed, correctly-bound certificate', () => {
    const result = checkCertificate(parseCertificate(mint())!, ctx());
    expect(result.ok).toBe(true);
  });

  test('rejects a signature from a different key', () => {
    const other = crypto.generateKeyPairSync('ed25519');
    const otherPub = Buffer.from((other.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString(
      'base64',
    );
    const result = checkCertificate(parseCertificate(mint())!, ctx({ ed25519PubB64: otherPub }));
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('rejects a certificate minted for another machine', () => {
    const result = checkCertificate(parseCertificate(mint({ machineId: 'other-machine' }))!, ctx());
    expect(result).toEqual({ ok: false, reason: 'wrong_machine' });
  });

  test('rejects a certificate minted against another relay', () => {
    // relayUrl is a user-settable preference, and relay B controls its own
    // users table — it could assign an id matching this certificate's grantee.
    const result = checkCertificate(parseCertificate(mint({ relayOrigin: 'https://evil.example.com' }))!, ctx());
    expect(result).toEqual({ ok: false, reason: 'wrong_relay' });
  });

  test('rejects a certificate replayed onto a different principal', () => {
    // A relay that lies about which user owns a socket can only ever replay a
    // certificate to the person it was already issued to.
    const result = checkCertificate(parseCertificate(mint())!, ctx({ principalUserId: 'someone-else' }));
    expect(result).toEqual({ ok: false, reason: 'wrong_principal' });
  });

  test('rejects an expired certificate', () => {
    const result = checkCertificate(parseCertificate(mint())!, ctx({ now: VEC.parts.expiresAt + 1 }));
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  test('rejects one that is not valid yet', () => {
    const result = checkCertificate(parseCertificate(mint())!, ctx({ now: VEC.parts.issuedAt - 1 }));
    expect(result).toEqual({ ok: false, reason: 'not_yet_valid' });
  });

  test('checks the signature before anything an attacker chose', () => {
    // Fail-closed ordering: every field after the signature is attacker-supplied,
    // so a certificate that is wrong in several ways must report the signature.
    const forged = `grant:v1.${VEC.payloadB64url}.${Buffer.alloc(64).toString('base64url')}`;
    const result = checkCertificate(parseCertificate(forged)!, ctx({ machineId: 'other', now: 0 }));
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('permits', () => {
  const at = VEC.parts.issuedAt + 1000;
  const viewer = grantFrom({ ...VEC.parts, role: 'viewer' }, ['s1']);
  const operator = grantFrom({ ...VEC.parts, role: 'operator' }, ['s1']);

  test('DENY_ALL refuses every command in the table', () => {
    // Per-command rather than in aggregate: a table entry added without a
    // policy entry must not slip through on someone else's pass.
    for (const command of Object.keys(COMMAND_CAPS)) {
      expect(permits(DENY_ALL, command, 's1', at)).toBe(false);
    }
  });

  test('the owner may run every command in the table', () => {
    for (const command of Object.keys(COMMAND_CAPS)) {
      expect(permits(ownerGrant(), command, 's1', at)).toBe(true);
    }
  });

  test('a viewer may watch and list but not type or resize', () => {
    expect(permits(viewer, 'terminal:subscribe', 's1', at)).toBe(true);
    expect(permits(viewer, 'sessions:list', null, at)).toBe(true);
    expect(permits(viewer, 'terminal:input', 's1', at)).toBe(false);
    expect(permits(viewer, 'terminal:resize', 's1', at)).toBe(false);
  });

  test('an operator may type but still cannot resize, create or browse', () => {
    expect(permits(operator, 'terminal:input', 's1', at)).toBe(true);
    expect(permits(operator, 'terminal:resize', 's1', at)).toBe(false);
    expect(permits(operator, 'session:create', null, at)).toBe(false);
    expect(permits(operator, 'group:create', null, at)).toBe(false);
    expect(permits(operator, 'dirs:list', null, at)).toBe(false);
  });

  test('scope is enforced per session, not per machine', () => {
    expect(permits(viewer, 'terminal:subscribe', 's1', at)).toBe(true);
    expect(permits(viewer, 'terminal:subscribe', 's2', at)).toBe(false);
  });

  test('a session-scoped command with no session id is refused', () => {
    expect(permits(viewer, 'terminal:subscribe', null, at)).toBe(false);
    expect(isSessionScoped('terminal:subscribe')).toBe(true);
    expect(isSessionScoped('sessions:list')).toBe(false);
  });

  test('an expired grant permits nothing', () => {
    expect(permits(viewer, 'terminal:subscribe', 's1', VEC.parts.expiresAt + 1)).toBe(false);
  });

  test('an unknown command is refused even for the owner', () => {
    expect(permits(ownerGrant(), 'shell:exec', null, at)).toBe(false);
    expect(permits(ownerGrant(), '', null, at)).toBe(false);
  });
});

describe('policy immutability', () => {
  // These are frozen arrays rather than Sets for a specific reason:
  // Object.freeze does NOT protect a Set (its contents are internal slots), so
  // a frozen Set still accepts .add(). Since grantFrom hands ROLE_CAPS[role]
  // straight into a live grant, a mutable Set would let one line widen the
  // policy globally for every grant issued afterwards.
  test('DENY_ALL cannot be widened in place', () => {
    expect(Object.isFrozen(DENY_ALL)).toBe(true);
    expect(() => (DENY_ALL.caps as Cap[]).push('input')).toThrow();
    expect(() => (DENY_ALL.sessions as string[]).push('s1')).toThrow();
    expect(DENY_ALL.caps).toHaveLength(0);
  });

  test('ROLE_CAPS cannot be widened, which would escalate every future grant', () => {
    expect(() => (ROLE_CAPS.viewer as Cap[]).push('input')).toThrow();
    expect(ROLE_CAPS.viewer).not.toContain('input');
    // And the escalation it would have caused does not happen.
    expect(permits(grantFrom({ ...VEC.parts, role: 'viewer' }, ['s1']), 'terminal:input', 's1', VEC.parts.issuedAt + 1)).toBe(
      false,
    );
  });

  test("a grant's scope cannot be widened after it is built", () => {
    const g = grantFrom({ ...VEC.parts, role: 'viewer' }, ['s1']);
    expect(() => (g.sessions as string[]).push('s2')).toThrow();
    expect(permits(g, 'terminal:subscribe', 's2', VEC.parts.issuedAt + 1)).toBe(false);
  });

  test('mutating the array passed to grantFrom does not widen the grant', () => {
    const scope = ['s1'];
    const g = grantFrom({ ...VEC.parts, role: 'viewer' }, scope);
    scope.push('s2');
    expect(permits(g, 'terminal:subscribe', 's2', VEC.parts.issuedAt + 1)).toBe(false);
  });
});
