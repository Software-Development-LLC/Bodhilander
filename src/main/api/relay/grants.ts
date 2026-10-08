/**
 * Grant certificates and the capability policy (agent side).
 *
 * This module is the authority on what a principal may do. It is deliberately
 * **pure** — `node:crypto` and nothing else, no Electron, no repositories, no
 * `electron-log` — so every branch here is unit-testable without
 * `mock.module()`, which is process-wide in bun and would break unrelated
 * suites (see `docs/designs/session-sharing.md` §6).
 *
 * The wire format is hand-duplicated with `relay/src/protocol.ts`. Both trees
 * assert themselves against `fixtures/sharing-v1.json` independently, so a
 * drift on either side fails that side's own suite instead of surfacing as a
 * guest who silently holds the wrong capabilities.
 *
 * A certificate is `grant:v1.<base64url(payload)>.<base64url(sig)>` where the
 * payload is exactly the bytes the signature covers.
 */

import crypto from 'crypto';

export const GRANT_VERSION = 'grant:v1';

/** Capability an agent advertises so the relay knows it enforces certificates. */
export const CAP_GRANTS_V1 = 'grants:v1';

/**
 * Capability an agent advertises to say it can seal web-push payloads itself.
 * The relay withholds subscription keys from any agent that has not said so.
 * Mirrors `CAP_PUSH_V1` in `relay/src/protocol.ts`.
 */
export const CAP_PUSH_V1 = 'push:v1';

/** Roles a certificate may carry. `owner` is deliberately not among them. */
export const MINTABLE_ROLES = ['viewer', 'operator'] as const;
export type GrantRole = (typeof MINTABLE_ROLES)[number];

/** Every capability the command table can require. */
export type Cap = 'view' | 'list' | 'input' | 'resize' | 'create' | 'browse';

/**
 * Role → capabilities.
 *
 * `owner` is here because the local owner branch resolves through the same
 * table as everyone else — one gate, not two. It is *not* a mintable role:
 * there is no persisted owner certificate (§3), because a machine-wide bearer
 * credential sitting in the relay's database is a skeleton key.
 *
 * `create` and `browse` appear in no guest role, which is what keeps
 * `session:create`, `group:create` and `dirs:list` unreachable for any guest.
 */
/**
 * Frozen **arrays**, not Sets. `Object.freeze` does not protect a Set — its
 * contents live in internal slots, so a frozen Set still accepts `.add()`.
 * Since `grantFrom` hands `ROLE_CAPS[role]` straight to a live grant, a
 * mutable Set here would let one line of code widen the policy globally, for
 * every grant issued afterwards. A frozen array actually throws.
 */
export const ROLE_CAPS: Readonly<Record<'owner' | GrantRole, readonly Cap[]>> = Object.freeze({
  owner: Object.freeze<Cap[]>(['view', 'list', 'input', 'resize', 'create', 'browse']),
  operator: Object.freeze<Cap[]>(['view', 'list', 'input']),
  viewer: Object.freeze<Cap[]>(['view', 'list']),
});

/**
 * Command → the capability it requires.
 *
 * A command absent from this table is refused. That direction matters: a new
 * command added to `dispatch()` without a policy entry fails closed rather
 * than inheriting whatever the last case did.
 */
export const COMMAND_CAPS: Readonly<Record<string, Cap>> = Object.freeze({
  'sessions:list': 'list',
  'groups:list': 'list',
  'terminal:subscribe': 'view',
  'terminal:unsubscribe': 'view',
  'terminal:input': 'input',
  'terminal:resize': 'resize',
  // ASKING is not resizing. A guest may say "this doesn't fit my screen" and
  // the owner's desktop decides — so this needs only what watching already
  // grants, and `resize` stays exactly as narrow as it was.
  'terminal:resize-request': 'view',
  'session:create': 'create',
  'group:create': 'create',
  'dirs:list': 'browse',
});

/**
 * Canonical message the agent signs to create a share invite. Mirrors
 * `relay/src/protocol.ts`; both sides must produce identical bytes.
 */
export const SHARE_CREATE_VERSION = 'share-create:v1';

export interface ShareCreateParts {
  machineId: string;
  /** Empty string for an open link. */
  expectedGithubLogin: string;
  role: string;
  grantTtlSeconds: number;
  inviteTtlSeconds: number;
  issuedAt: number;
}

export function buildShareCreateMessage(p: ShareCreateParts): Uint8Array {
  const line = [
    SHARE_CREATE_VERSION,
    p.machineId,
    p.expectedGithubLogin,
    p.role,
    String(p.grantTtlSeconds),
    String(p.inviteTtlSeconds),
    String(p.issuedAt),
  ].join('\n');
  return new TextEncoder().encode(line);
}

/**
 * `grantTtlSeconds: 0` means "until the owner revokes it".
 *
 * Zero rather than a magic large number because it is the value that travels:
 * it sits inside the signed `share-create:v1` message and in the relay's
 * `grant_ttl_seconds` column, and a sentinel that reads as "no duration" is
 * harder to mistake for a duration than 3155760000 is.
 *
 * This is safe here because a certificate's lifetime is not what bounds a
 * share. The desktop's own table decides whether a grant is still live and is
 * consulted on every `client:open`, the scope is bound to a PTY instance so a
 * session restart ends it regardless of clock, and revocation reaches live
 * sockets immediately. An unexpiring certificate is not an unrevocable one.
 */
export const GRANT_TTL_UNTIL_REVOKED = 0;

/**
 * The expiry an "until revoked" certificate carries: the largest timestamp
 * `Date` can represent. Every check on this value is a plain comparison, so
 * nothing needs to special-case it — and it stays a safe integer, which
 * `assertGrantFieldsSafe` requires and SQLite stores exactly.
 */
export const GRANT_NEVER_EXPIRES = 8_640_000_000_000_000;

/** When a grant minted now with `ttlSeconds` should stop being honoured. */
export function grantExpiryAt(now: number, ttlSeconds: number): number {
  return ttlSeconds === GRANT_TTL_UNTIL_REVOKED ? GRANT_NEVER_EXPIRES : now + ttlSeconds * 1000;
}

export interface GrantParts {
  grantId: string;
  machineId: string;
  relayOrigin: string;
  granteeUserId: string;
  role: GrantRole;
  issuedAt: number;
  expiresAt: number;
}

/**
 * What a connected client is allowed to do.
 *
 * `sessions` is the explicit scope — a grant names sessions, never a machine.
 * `null` means "every session", which only the owner ever gets.
 */
export interface Grant {
  role: 'owner' | GrantRole;
  /** Frozen; see the note on ROLE_CAPS for why this is an array. */
  caps: readonly Cap[];
  sessions: readonly string[] | null;
  grantId: string | null;
  expiresAt: number;
}

/**
 * The initial state of every client session, and the state a revoked one
 * returns to. Frozen so a bug cannot widen it in place.
 *
 * `ClientSession.grant` starts here rather than at owner: completing the E2E
 * handshake proves you are talking to this machine, which is not the same as
 * being allowed to drive it.
 */
export const DENY_ALL: Grant = Object.freeze({
  role: 'viewer' as const,
  caps: Object.freeze<Cap[]>([]),
  sessions: Object.freeze<string[]>([]),
  grantId: null,
  expiresAt: 0,
});

/** The owner's grant: every capability, every session, no expiry. */
export function ownerGrant(): Grant {
  return Object.freeze({
    role: 'owner' as const,
    caps: ROLE_CAPS.owner,
    sessions: null,
    grantId: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
}

/**
 * Whether `grant` permits `command` on `sessionId` at time `now`.
 *
 * Expiry, capability and scope are all checked here so there is exactly one
 * place that can be wrong. An unknown command is refused.
 */
export function permits(grant: Grant, command: string, sessionId: string | null, now: number): boolean {
  if (grant.expiresAt <= now) return false;
  const required = COMMAND_CAPS[command];
  if (!required) return false;
  if (!grant.caps.includes(required)) return false;
  // A null scope is every session. A non-null scope must name this one, and a
  // session-scoped command with no session id is malformed rather than global.
  if (grant.sessions === null) return true;
  if (sessionId === null) return !isSessionScoped(command);
  return grant.sessions.includes(sessionId);
}

/** Commands that act on one named session, and so must be scope-checked. */
export function isSessionScoped(command: string): boolean {
  return command.startsWith('terminal:');
}

/** Reject any field that could forge a line break — see the relay's copy. */
export function assertGrantFieldsSafe(p: GrantParts): void {
  for (const [name, value] of Object.entries({
    grantId: p.grantId,
    machineId: p.machineId,
    relayOrigin: p.relayOrigin,
    granteeUserId: p.granteeUserId,
    role: p.role,
  })) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`grant ${name} must be a non-empty string`);
    if (value.includes('\n') || value.includes('\r')) throw new Error(`grant ${name} must not contain a line break`);
  }
  if (!Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt)) {
    throw new Error('grant timestamps must be safe integers');
  }
}

/** The exact bytes a grant signature covers. */
export function buildGrantMessage(p: GrantParts): Uint8Array {
  assertGrantFieldsSafe(p);
  const line = [
    GRANT_VERSION,
    p.grantId,
    p.machineId,
    p.relayOrigin,
    p.granteeUserId,
    p.role,
    String(p.issuedAt),
    String(p.expiresAt),
  ].join('\n');
  return new TextEncoder().encode(line);
}

export function formatCertificate(payload: Uint8Array, signature: Uint8Array): string {
  return `${GRANT_VERSION}.${Buffer.from(payload).toString('base64url')}.${Buffer.from(signature).toString('base64url')}`;
}

export interface ParsedCertificate {
  payload: Uint8Array;
  signature: Uint8Array;
  parts: GrantParts;
}

/**
 * Split and structurally validate a certificate. Returns null on anything
 * malformed rather than throwing — this is a hostile input path.
 *
 * Does NOT verify the signature or check expiry.
 */
export function parseCertificate(cert: unknown): ParsedCertificate | null {
  if (typeof cert !== 'string') return null;
  const segments = cert.split('.');
  if (segments.length !== 3) return null;
  const [version, payloadB64, sigB64] = segments as [string, string, string];
  if (version !== GRANT_VERSION) return null;

  let payload: Uint8Array;
  let signature: Uint8Array;
  try {
    payload = new Uint8Array(Buffer.from(payloadB64, 'base64url'));
    signature = new Uint8Array(Buffer.from(sigB64, 'base64url'));
  } catch {
    return null;
  }
  if (signature.length !== 64 || payload.length === 0) return null;

  const lines = Buffer.from(payload).toString('utf8').split('\n');
  if (lines.length !== 8) return null;
  const [inner, grantId, machineId, relayOrigin, granteeUserId, role, issuedAt, expiresAt] = lines as [
    string, string, string, string, string, string, string, string,
  ];
  // The outer prefix is unauthenticated, the inner one is signed; requiring
  // them to agree stops the cheap reject disagreeing with the real one.
  if (inner !== GRANT_VERSION) return null;
  if (!(MINTABLE_ROLES as readonly string[]).includes(role)) return null;
  // Digits, then the SAME safe-integer test the builder applies, so what
  // parses and what can be built are one rule rather than two that have to be
  // kept in agreement. A digit-count alone cannot express it: 16 digits admits
  // 9999999999999999, which is past Number.MAX_SAFE_INTEGER, and handing that
  // to the builder below would THROW — on a path documented to return null
  // rather than throw, for hostile input.
  if (!/^\d{1,16}$/.test(issuedAt) || !/^\d{1,16}$/.test(expiresAt)) return null;
  if (!Number.isSafeInteger(Number(issuedAt)) || !Number.isSafeInteger(Number(expiresAt))) return null;
  if (!grantId || !machineId || !relayOrigin || !granteeUserId) return null;

  const parts: GrantParts = {
    grantId,
    machineId,
    relayOrigin,
    granteeUserId,
    role: role as GrantRole,
    issuedAt: Number(issuedAt),
    expiresAt: Number(expiresAt),
  };

  // Re-serialising must reproduce the input byte for byte, so there is exactly
  // one byte string per set of parts.
  // Wrapped: this function's contract is to return null on hostile input,
  // never to throw. The checks above should make the builder's own
  // validation unreachable, and that is exactly why it must not be load-
  // bearing — a future field rule added to only one of them would
  // otherwise turn a rejection into an exception.
  let rebuilt: Uint8Array;
  try {
    rebuilt = buildGrantMessage(parts);
  } catch {
    return null;
  }
  if (rebuilt.length !== payload.length) return null;
  for (let i = 0; i < rebuilt.length; i++) if (rebuilt[i] !== payload[i]) return null;

  return { payload, signature, parts };
}

/** Verify a certificate's Ed25519 signature against a raw pubkey (base64). */
export function verifyCertificateSignature(parsed: ParsedCertificate, ed25519PubB64: string): boolean {
  try {
    const key = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(ed25519PubB64, 'base64').toString('base64url') },
      format: 'jwk',
    });
    return crypto.verify(null, Buffer.from(parsed.payload), key, Buffer.from(parsed.signature));
  } catch {
    return false;
  }
}

export type CertificateRejection =
  | 'malformed'
  | 'bad_signature'
  | 'wrong_machine'
  | 'wrong_relay'
  | 'wrong_principal'
  | 'expired'
  | 'not_yet_valid';

export interface CertificateContext {
  /** This machine's id as the relay knows it. */
  machineId: string;
  /** The relay origin this agent is currently connected to. */
  relayOrigin: string;
  /** The machine's own Ed25519 public key — it signed the certificate. */
  ed25519PubB64: string;
  /** The user id the relay asserts for this socket. */
  principalUserId: string;
  now: number;
}

/**
 * Full certificate check, in fail-closed order.
 *
 * Signature first, then binding, then time. Everything after the signature is
 * reading fields an attacker chose, so nothing may branch on them until the
 * signature has established they are ours.
 *
 * The caller must ALSO confirm `grantId` is present and active in its own
 * table — a validly signed certificate for a revoked grant verifies fine here.
 */
export function checkCertificate(
  parsed: ParsedCertificate,
  ctx: CertificateContext,
): { ok: true; parts: GrantParts } | { ok: false; reason: CertificateRejection } {
  if (!verifyCertificateSignature(parsed, ctx.ed25519PubB64)) return { ok: false, reason: 'bad_signature' };

  const { parts } = parsed;
  if (parts.machineId !== ctx.machineId) return { ok: false, reason: 'wrong_machine' };
  // `relayUrl` is user-settable, so a certificate minted against relay A must
  // not verify on relay B, whose operator controls its own user ids.
  if (parts.relayOrigin !== ctx.relayOrigin) return { ok: false, reason: 'wrong_relay' };
  // The relay asserts the principal. Binding to it means a relay that lies
  // about a socket's user can only replay a certificate to the person it was
  // already issued to.
  if (parts.granteeUserId !== ctx.principalUserId) return { ok: false, reason: 'wrong_principal' };
  if (parts.expiresAt <= ctx.now) return { ok: false, reason: 'expired' };
  if (parts.issuedAt > ctx.now) return { ok: false, reason: 'not_yet_valid' };

  return { ok: true, parts };
}

/** Build a runtime `Grant` from verified parts plus the locally-held scope. */
export function grantFrom(parts: GrantParts, sessions: Iterable<string>): Grant {
  return Object.freeze({
    role: parts.role,
    caps: ROLE_CAPS[parts.role],
    // Deduplicated and frozen: the caller's array must not stay writable
    // through the grant it produced.
    sessions: Object.freeze([...new Set(sessions)]),
    grantId: parts.grantId,
    expiresAt: parts.expiresAt,
  });
}
