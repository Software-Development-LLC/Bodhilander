/**
 * Wire-format constants shared between the relay and the desktop agent (Slice
 * B). Kept in one place so both sides build/verify the exact same bytes.
 */

/** Canonical message an agent signs (Ed25519) to register a machine via /link. */
export const LINK_MESSAGE_VERSION = 'link:v1';

export interface LinkMessageParts {
  ed25519PubB64: string;
  x25519PubB64: string;
  machineName: string;
  issuedAt: number;
}

export function buildLinkMessage(p: LinkMessageParts): Uint8Array {
  const line = [LINK_MESSAGE_VERSION, p.ed25519PubB64, p.x25519PubB64, p.machineName, String(p.issuedAt)].join('\n');
  return new TextEncoder().encode(line);
}

/** How far `issuedAt` may drift from server time before /link is rejected. */
export const LINK_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Canonical message an agent signs (Ed25519) to answer the relay's WebSocket
 * auth challenge. Namespaced so a signature can't be replayed across the /link
 * flow or any other protocol.
 */
export const AGENT_AUTH_VERSION = 'agent-auth:v1';

export function buildAgentAuthMessage(nonce: string): Uint8Array {
  return new TextEncoder().encode(`${AGENT_AUTH_VERSION}\n${nonce}`);
}

/**
 * Capability an agent advertises in `agent:auth` to say it understands and
 * enforces grant certificates.
 *
 * This is load-bearing, not informational. `relay-client.ts` dispatches on
 * `msg.clientId` and ignores fields it doesn't know, and the pre-M5.1
 * `session-tunnel.open()` reads only `clientX25519Pub` — so an old desktop
 * build handed a guest `client:open` would grant that guest every command,
 * which is total machine compromise of someone who never opted into sharing.
 * The relay redeploys independently of shipped Electron builds, so this WILL
 * be the situation for a while. The relay therefore refuses to route any
 * certificate-bearing open to a machine that has not advertised this.
 */
export const CAP_GRANTS_V1 = 'grants:v1';

/**
 * Canonical message an agent signs to create a share invite.
 *
 * Signed rather than session-authenticated because invites originate on the
 * **desktop**, not in a browser: only the machine can countersign a grant, so
 * only the machine should be able to offer one. A stolen relay session cookie
 * therefore cannot mint invites for a machine it does not hold the key to.
 *
 * `expectedGithubLogin` is included so the addressing cannot be stripped in
 * transit — an open link is a materially different thing from an addressed
 * one, and the relay must not be able to downgrade one into the other.
 */
export const SHARE_CREATE_VERSION = 'share-create:v1';

export interface ShareCreateParts {
  machineId: string;
  /** Empty string for an open link. */
  expectedGithubLogin: string;
  role: string;
  /** Seconds of access once the guest joins; 0 means until the owner revokes. */
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

// --- grant certificates (design §5) ---

export const GRANT_VERSION = 'grant:v1';

/** Roles a certificate may carry. `owner` is deliberately not among them (§3). */
export const MINTABLE_ROLES = ['viewer', 'operator'] as const;
export type GrantRole = (typeof MINTABLE_ROLES)[number];

export interface GrantParts {
  grantId: string;
  machineId: string;
  /**
   * The relay this certificate is valid on. `relayUrl` is a user-settable
   * preference, so without this a certificate minted against relay A would
   * verify on relay B — whose operator controls its own `users` table and
   * could hand out a matching `granteeUserId`.
   */
  relayOrigin: string;
  granteeUserId: string;
  role: GrantRole;
  issuedAt: number;
  expiresAt: number;
}

/**
 * The exact bytes a grant signature covers. Line-oriented rather than JSON so
 * both trees produce identical bytes without a canonicalisation rule; none of
 * the fields may contain a newline (`assertGrantFieldsSafe` enforces that).
 */
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

/**
 * Reject any field that could forge a line break.
 *
 * Without this, a `machineId` of `"a\nb"` would shift every later field up a
 * line, letting one set of parts serialise identically to a different set —
 * a signature over one grant would then verify as another. The ids are all
 * server-generated UUIDs today, which is exactly the kind of assumption that
 * stops being true quietly.
 */
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

/** `grant:v1.<base64url(payload)>.<base64url(sig)>` */
export function formatCertificate(payload: Uint8Array, signature: Uint8Array): string {
  return `${GRANT_VERSION}.${Buffer.from(payload).toString('base64url')}.${Buffer.from(signature).toString('base64url')}`;
}

export interface ParsedCertificate {
  /** Exactly the bytes the signature covers. */
  payload: Uint8Array;
  signature: Uint8Array;
  parts: GrantParts;
}

/**
 * Split and structurally validate a certificate. Returns null on anything
 * malformed rather than throwing — callers are on a hostile input path.
 *
 * This does NOT verify the signature or check expiry; it only gets you to
 * bytes you can verify. Callers must do both.
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

  const lines = new TextDecoder().decode(payload).split('\n');
  if (lines.length !== 8) return null;
  const [inner, grantId, machineId, relayOrigin, granteeUserId, role, issuedAt, expiresAt] = lines as [
    string, string, string, string, string, string, string, string,
  ];
  // The outer prefix is unauthenticated; the inner one is signed. Requiring
  // them to agree means the cheap reject can't disagree with the real one.
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

  // Re-serialising must reproduce the input byte for byte. Anything the parse
  // above tolerated but the builder wouldn't emit dies here, so there is
  // exactly one byte string per set of parts.
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
