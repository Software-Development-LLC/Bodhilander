/**
 * The desktop's grant tables — the authority for session sharing.
 *
 * The relay stores an opaque certificate and routes. What a grant actually
 * covers lives only here, and `status` here is what decides revocation,
 * consulted at every `client:open` rather than only for live sockets. That
 * split is what makes guests structurally invisible to the relay: no session
 * id ever reaches it.
 *
 * Everything that needs Electron (`safeStorage` via `signWithIdentity`) is
 * confined to `mintGrant`; the read path is plain SQL so the tunnel's deny
 * branches stay testable through an injected port.
 */

import { getDatabase } from '../../database';
import { getPreference, setPreference } from '../../repositories/preferences';
import { signWithIdentity, ensureIdentity } from './relay-identity';
import {
  buildGrantMessage,
  formatCertificate,
  MINTABLE_ROLES,
  type GrantRole,
  type GrantParts,
} from './grants';

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

export interface StoredGrantSession {
  sessionId: string;
  /** The PTY instance the share was approved against. */
  ptyEpoch: number;
}

export interface StoredGrant {
  id: string;
  relayOrigin: string;
  granteeUserId: string;
  granteeLogin: string | null;
  role: GrantRole;
  status: 'pending' | 'active' | 'revoked';
  createdAt: number;
  boundAt: number | null;
  expiresAt: number | null;
  revokePending: boolean;
  sessions: StoredGrantSession[];
}

interface GrantRow {
  id: string;
  relay_origin: string;
  grantee_user_id: string;
  grantee_login: string | null;
  role: GrantRole;
  status: 'pending' | 'active' | 'revoked';
  created_at: number;
  bound_at: number | null;
  expires_at: number | null;
  revoke_pending: number;
}

function hydrate(row: GrantRow): StoredGrant {
  const db = getDatabase();
  const sessions = db
    .prepare('SELECT session_id, pty_epoch FROM relay_grant_sessions WHERE grant_id = ?')
    .all(row.id) as { session_id: string; pty_epoch: number }[];
  return {
    id: row.id,
    relayOrigin: row.relay_origin,
    granteeUserId: row.grantee_user_id,
    granteeLogin: row.grantee_login,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    boundAt: row.bound_at,
    expiresAt: row.expires_at,
    revokePending: row.revoke_pending !== 0,
    sessions: sessions.map((s) => ({ sessionId: s.session_id, ptyEpoch: s.pty_epoch })),
  };
}

export function getGrant(grantId: string): StoredGrant | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM relay_grants WHERE id = ?').get(grantId) as GrantRow | undefined;
  return row ? hydrate(row) : null;
}

export function listGrants(): StoredGrant[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM relay_grants ORDER BY created_at DESC').all() as GrantRow[];
  return rows.map(hydrate);
}

/** The confirmed owner id, or null while it is still unconfirmed. */
export function getOwnerUserId(): string | null {
  return getPreference(GRANT_PREF.ownerUserId);
}

/**
 * Record the owner id the human confirmed. Re-minting for a different id is a
 * deliberate act, so this overwrites only when told to.
 */
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
  sessions: StoredGrantSession[];
  ttlSeconds: number;
}

/**
 * Create a grant and sign its certificate.
 *
 * The row and the certificate are written in one transaction: a certificate
 * that verifies against a grant this machine has no record of would be a
 * bearer credential, and the tunnel refuses any `grantId` absent from this
 * table precisely so that cannot happen.
 *
 * Its caller — the approval flow — lands with M5.2. It exists here because
 * verification cannot be honestly tested without a real self-signed
 * certificate to verify.
 */
export function mintGrant(req: MintRequest, now = Date.now()): { grant: StoredGrant; certificate: string } {
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

  const db = getDatabase();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO relay_grants
         (id, relay_origin, grantee_user_id, grantee_login, role, status, created_at, bound_at, expires_at, revoke_pending)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 0)`,
    ).run(req.grantId, req.relayOrigin, req.granteeUserId, req.granteeLogin, req.role, now, now, expiresAt);
    const insertSession = db.prepare(
      'INSERT INTO relay_grant_sessions (grant_id, session_id, pty_epoch) VALUES (?, ?, ?)',
    );
    for (const s of req.sessions) insertSession.run(req.grantId, s.sessionId, s.ptyEpoch);
  })();

  return { grant: getGrant(req.grantId)!, certificate };
}

/**
 * Revoke locally and queue the relay side.
 *
 * Local status is the authority, so this takes effect at the next
 * `client:open` whether or not the relay ever hears about it. The queue is
 * what makes revoking while offline honest rather than a lie.
 */
export function revokeGrant(grantId: string, now = Date.now()): boolean {
  const db = getDatabase();
  const result = db
    .prepare(
      `UPDATE relay_grants SET status = 'revoked', revoked_at = ?, revoke_pending = 1
        WHERE id = ? AND status != 'revoked'`,
    )
    .run(now, grantId);
  return result.changes > 0;
}

/** Grants whose revocation has not yet reached the relay. */
export function pendingRevocations(): string[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT id FROM relay_grants WHERE revoke_pending = 1').all() as { id: string }[];
  return rows.map((r) => r.id);
}

export function clearPendingRevocation(grantId: string): void {
  const db = getDatabase();
  db.prepare('UPDATE relay_grants SET revoke_pending = 0 WHERE id = ?').run(grantId);
}

/**
 * Forget every grant. Called when `relayUrl` changes, on `clearIdentity()` and
 * on re-link — a certificate is bound to a relay origin and a machine
 * identity, so keeping rows across either change would leave ghosts in the
 * owner's settings that can never be honoured.
 */
export function clearAllGrants(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM relay_grants').run();
}
