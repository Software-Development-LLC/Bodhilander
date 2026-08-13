/**
 * The desktop's grant tables bound to the app database.
 *
 * This desktop is the authority for session sharing: the relay stores an
 * opaque certificate and routes, while what a grant actually covers — and
 * whether it is still live — exists only here. That split is what makes guests
 * structurally invisible to the relay, since no session id ever reaches it.
 *
 * Every statement lives in `grant-sql.ts`, which imports nothing from
 * Electron; this module is the thin wrapper that supplies `getDatabase()` and
 * the signing key. Same split as `session-tunnel.ts` / `session-tunnel-deps.ts`,
 * and for the same reason: the SQL is testable against a real schema.
 */

import { getDatabase } from '../../database';
import { getPreference, setPreference } from '../../repositories/preferences';
import { signWithIdentity, ensureIdentity } from './relay-identity';
import * as sql from './grant-sql';
import { buildGrantMessage, formatCertificate, MINTABLE_ROLES, type GrantRole, type GrantParts } from './grants';

export type { StoredGrant, StoredGrantSession } from './grant-sql';
export { RELAY_SHARING_SCHEMA } from './grant-sql';

export const GRANT_PREF = {
  /**
   * The relay user id this machine belongs to, confirmed once by the human.
   *
   * The desktop cannot learn this from anywhere trustworthy — `agent:ready`
   * carries only `machineId` — so minting an owner credential for whatever id
   * the relay asserted would hand the relay owner capability. A person
   * confirms it instead.
   */
  ownerUserId: 'relay.ownerUserId',
  /**
   * One-way latch. Set the first time a certificate is enforced on this
   * machine; from then on a certificate-less non-owner open is never accepted,
   * even if `ownerUserId` is somehow cleared. This, not a deletion date, is
   * what makes the beta window safe.
   */
  grantsEnforced: 'relay.grantsEnforced',
} as const;

export function getGrant(grantId: string): sql.StoredGrant | null {
  return sql.getGrant(getDatabase(), grantId);
}

export function listGrants(): sql.StoredGrant[] {
  return sql.listGrants(getDatabase());
}

export function revokeGrant(grantId: string, now = Date.now()): boolean {
  return sql.revokeGrant(getDatabase(), grantId, now);
}

export function pendingRevocations(): string[] {
  return sql.pendingRevocations(getDatabase());
}

export function clearPendingRevocation(grantId: string): void {
  sql.clearPendingRevocation(getDatabase(), grantId);
}

export function clearAllGrants(): void {
  sql.clearAllGrants(getDatabase());
}

/** The confirmed owner id, or null while it is still unconfirmed. */
export function getOwnerUserId(): string | null {
  return getPreference(GRANT_PREF.ownerUserId);
}

/** Record the owner id the human confirmed. */
export function setOwnerUserId(userId: string): void {
  setPreference(GRANT_PREF.ownerUserId, userId);
}

/** Whether a certificate has ever been enforced on this machine. */
export function grantsEnforced(): boolean {
  return getPreference(GRANT_PREF.grantsEnforced) === 'true';
}

/**
 * Latch enforcement on, permanently.
 *
 * One-way on purpose: there is no un-latch. An old build silently reverting to
 * "whoever connects is the owner" is the failure this exists to prevent, and a
 * reversible flag would be one relay message away from being that build again.
 */
export function latchGrantsEnforced(): void {
  if (grantsEnforced()) return;
  setPreference(GRANT_PREF.grantsEnforced, 'true');
}

export interface MintRequest {
  grantId: string;
  machineId: string;
  relayOrigin: string;
  granteeUserId: string;
  granteeLogin: string | null;
  role: GrantRole;
  /** Sessions the owner approved, with the PTY instance each was approved on. */
  sessions: sql.StoredGrantSession[];
  ttlSeconds: number;
}

/**
 * Create a grant and sign its certificate.
 *
 * The row and the certificate are written together: a certificate that
 * verifies against a grant this machine has no record of would be a bearer
 * credential, and the tunnel refuses any `grantId` absent from this table
 * precisely so that cannot happen.
 *
 * Its caller — the approval flow — lands with M5.2. It exists here because
 * verification cannot be honestly tested without a real self-signed
 * certificate to verify.
 */
export function mintGrant(req: MintRequest, now = Date.now()): { grant: sql.StoredGrant; certificate: string } {
  if (!(MINTABLE_ROLES as readonly string[]).includes(req.role)) {
    // `owner` is not mintable: a machine-wide bearer credential sitting in the
    // relay's database is a skeleton key, not a simplification.
    throw new Error(`refusing to mint a ${req.role} certificate`);
  }
  if (req.sessions.length === 0) {
    // A grant names sessions explicitly. An empty scope would be a
    // machine-wide grant wearing session-scope clothing.
    throw new Error('refusing to mint a grant with no sessions');
  }

  const expiresAt = now + req.ttlSeconds * 1000;
  const parts: GrantParts = {
    grantId: req.grantId,
    machineId: req.machineId,
    relayOrigin: req.relayOrigin,
    granteeUserId: req.granteeUserId,
    role: req.role,
    issuedAt: now,
    expiresAt,
  };
  // Throws on a line break in any field, before anything is written.
  const payload = buildGrantMessage(parts);
  ensureIdentity();
  const certificate = formatCertificate(payload, signWithIdentity(payload));

  sql.insertGrant(getDatabase(), req, now, expiresAt);
  return { grant: getGrant(req.grantId)!, certificate };
}
