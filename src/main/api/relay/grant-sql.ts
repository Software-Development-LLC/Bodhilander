/**
 * The sharing schema and every statement that touches it.
 *
 * This module imports nothing from Electron — each function takes its database
 * handle — so the SQL can be exercised against a real schema in tests.
 * `grant-store.ts` is the thin wrapper that binds these to the app database,
 * the same split as `session-tunnel.ts` / `session-tunnel-deps.ts`.
 *
 * The reason it is worth the split: this write path is unreachable from any
 * production path until M5.2 wires up the approval flow, so a column in the
 * wrong position or a forgotten insert would sit undetected until precisely
 * the moment it mattered.
 */

import type DatabaseCtor from 'better-sqlite3';

type Db = DatabaseCtor.Database;

/**
 * Session-sharing schema (docs/designs/session-sharing.md §4).
 *
 * Created eagerly by `initializeTables` rather than lazily like
 * `paired_devices`: the relay tunnel consults `relay_grants` on every
 * `client:open`, and a table that only appeared once sharing was first used
 * would make the deny path depend on setup order.
 *
 * This desktop is the AUTHORITY. The relay stores an opaque certificate and
 * routes; the session list a grant actually covers exists only here, and the
 * status column here is what decides revocation — consulted at every open,
 * not just for live sockets.
 */
export const RELAY_SHARING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS relay_grants (
    id TEXT PRIMARY KEY,
    -- In the signed byte string and re-checked at dispatch: the relay URL is a
    -- user-settable preference, so a certificate minted against relay A must
    -- not verify on relay B, whose operator controls its own user ids.
    relay_origin TEXT NOT NULL,
    grantee_user_id TEXT NOT NULL,
    grantee_login TEXT,
    role TEXT NOT NULL CHECK(role IN ('viewer','operator')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','revoked')),
    created_at INTEGER NOT NULL,
    bound_at INTEGER,
    expires_at INTEGER,
    revoked_at INTEGER,
    -- Revocation has to survive a disconnected agent: queued here and flushed
    -- to the relay on reconnect.
    revoke_pending INTEGER NOT NULL DEFAULT 0
  );

  -- A grant names sessions explicitly. There is no "share my machine".
  CREATE TABLE IF NOT EXISTS relay_grant_sessions (
    grant_id TEXT NOT NULL REFERENCES relay_grants(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- Binds the grant to the PTY INSTANCE, not the session row. sessions.id
    -- survives stop/restart, so without this a share of "Auth refactor" would
    -- follow the row into whatever it becomes weeks later. On restart the
    -- entry goes stale, subscribe is denied, and the owner is re-asked.
    pty_epoch INTEGER NOT NULL,
    PRIMARY KEY(grant_id, session_id)
  );

  -- Which session an invite was offered for.
  --
  -- The relay deliberately never learns this: no session id reaches it, which
  -- is what keeps guests structurally invisible to it. So the mapping has to
  -- live here, and the approval prompt reads it to pre-fill what the owner
  -- already chose when they created the link.
  CREATE TABLE IF NOT EXISTS relay_share_invites (
    invite_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- The PTY instance the owner was looking at when they offered the share.
    pty_epoch INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('viewer','operator')),
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_relay_grants_status ON relay_grants(status);
  CREATE INDEX IF NOT EXISTS idx_relay_grants_grantee ON relay_grants(grantee_user_id, status);
`;

export type GrantRole = 'viewer' | 'operator';

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

export interface GrantInsert {
  grantId: string;
  relayOrigin: string;
  granteeUserId: string;
  granteeLogin: string | null;
  role: GrantRole;
  sessions: StoredGrantSession[];
}

function hydrate(db: Db, row: GrantRow): StoredGrant {
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

export function getGrant(db: Db, grantId: string): StoredGrant | null {
  const row = db.prepare('SELECT * FROM relay_grants WHERE id = ?').get(grantId) as GrantRow | undefined;
  return row ? hydrate(db, row) : null;
}

export function listGrants(db: Db): StoredGrant[] {
  const rows = db.prepare('SELECT * FROM relay_grants ORDER BY created_at DESC').all() as GrantRow[];
  return rows.map((row) => hydrate(db, row));
}

/**
 * Write a grant and its scope.
 *
 * Both statements share one transaction: a grant row whose session rows failed
 * to land would be a grant with an empty scope, and an empty scope combined
 * with a valid certificate is a machine-wide grant wearing session-scope
 * clothing.
 */
export function insertGrant(db: Db, req: GrantInsert, now: number, expiresAt: number): void {
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
}

/**
 * Revoke locally and queue the relay side.
 *
 * Local status is the authority, so this takes effect at the next
 * `client:open` whether or not the relay ever hears about it. The queue is
 * what makes revoking while offline honest rather than a lie.
 */
export function revokeGrant(db: Db, grantId: string, now: number): boolean {
  const result = db
    .prepare(
      `UPDATE relay_grants SET status = 'revoked', revoked_at = ?, revoke_pending = 1
        WHERE id = ? AND status != 'revoked'`,
    )
    .run(now, grantId);
  return result.changes > 0;
}

/** Grants whose revocation has not yet reached the relay. */
export function pendingRevocations(db: Db): string[] {
  const rows = db.prepare('SELECT id FROM relay_grants WHERE revoke_pending = 1').all() as { id: string }[];
  return rows.map((r) => r.id);
}

export function clearPendingRevocation(db: Db, grantId: string): void {
  db.prepare('UPDATE relay_grants SET revoke_pending = 0 WHERE id = ?').run(grantId);
}

/**
 * Forget every grant. Called when `relayUrl` changes, on `clearIdentity()` and
 * on re-link — a certificate is bound to a relay origin and a machine
 * identity, so keeping rows across either change would leave ghosts in the
 * owner's settings that can never be honoured.
 */
export function clearAllGrants(db: Db): void {
  db.prepare('DELETE FROM relay_grants').run();
  db.prepare('DELETE FROM relay_share_invites').run();
}

export interface InviteScope {
  sessionId: string;
  ptyEpoch: number;
  role: GrantRole;
}

/** Remember what an invite was offered for, so approval can pre-fill it. */
export function recordInviteScope(db: Db, inviteId: string, scope: InviteScope, now: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO relay_share_invites (invite_id, session_id, pty_epoch, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(inviteId, scope.sessionId, scope.ptyEpoch, scope.role, now);
}

export function getInviteScope(db: Db, inviteId: string): InviteScope | null {
  const row = db
    .prepare('SELECT session_id, pty_epoch, role FROM relay_share_invites WHERE invite_id = ?')
    .get(inviteId) as { session_id: string; pty_epoch: number; role: GrantRole } | undefined;
  return row ? { sessionId: row.session_id, ptyEpoch: row.pty_epoch, role: row.role } : null;
}
