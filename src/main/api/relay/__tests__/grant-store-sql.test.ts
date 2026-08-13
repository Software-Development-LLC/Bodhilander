/**
 * The grant store's SQL write path, against a real database.
 *
 * Raised in review on #159: `mintGrant`'s transaction is unreachable from any
 * production path until M5.2 wires up the approval flow, so a column in the
 * wrong position or a forgotten session insert would sit undetected until
 * exactly the moment it mattered. `insertGrant` takes its database handle so
 * this can run without Electron, and the schema comes from
 * `RELAY_SHARING_SCHEMA` rather than a hand-copied approximation — a copy
 * would hide the drift it is supposed to catch.
 *
 * Run with: bun test src/main/api/relay/__tests__/grant-store-sql.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type DatabaseCtor from 'better-sqlite3';
import {
  RELAY_SHARING_SCHEMA,
  clearAllGrants,
  clearPendingRevocation,
  getGrant,
  insertGrant,
  listGrants,
  pendingRevocations,
  revokeGrant,
  type GrantInsert,
} from '../grant-sql';

/**
 * An in-memory database with the real sharing schema on top of a stub
 * `sessions` table.
 *
 * Driven through `bun:sqlite` rather than `better-sqlite3` — the latter is a
 * native module built for Electron and does not load under bun. That is fine
 * for what is under test here: column order, CHECK constraints, foreign-key
 * cascades and transaction rollback are SQLite semantics, identical either
 * way. The prepare/run/all/get/transaction surface these statements use is
 * common to both drivers.
 */
function freshDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  // relay_grant_sessions references sessions(id); the real table has far more
  // columns, none of which this path touches.
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY);');
  db.exec(RELAY_SHARING_SCHEMA);
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run('s1');
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run('s2');
  return db as unknown as DatabaseCtor.Database & { close(): void };
}

const NOW = 1_800_000_000_000;
const EXPIRES = NOW + 3_600_000;

const request = (over: Partial<GrantInsert> = {}): GrantInsert => ({
  grantId: 'grant-1',
  relayOrigin: 'https://relay.example.com',
  granteeUserId: 'guest-1',
  granteeLogin: 'dana-k',
  role: 'viewer',
  sessions: [{ sessionId: 's1', ptyEpoch: 111 }],
  ...over,
});

describe('insertGrant', () => {
  test('writes every column to the position it claims', () => {
    // The unglamorous failure this exists for: a value landing in the wrong
    // column still inserts cleanly and reads back as nonsense.
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      const row = db.prepare('SELECT * FROM relay_grants WHERE id = ?').get('grant-1') as Record<string, unknown>;
      expect(row).toMatchObject({
        id: 'grant-1',
        relay_origin: 'https://relay.example.com',
        grantee_user_id: 'guest-1',
        grantee_login: 'dana-k',
        role: 'viewer',
        status: 'active',
        created_at: NOW,
        bound_at: NOW,
        expires_at: EXPIRES,
        revoke_pending: 0,
      });
    } finally {
      db.close();
    }
  });

  test('writes one session row per approved session, with its pty epoch', () => {
    const db = freshDb();
    try {
      insertGrant(
        db,
        request({
          sessions: [
            { sessionId: 's1', ptyEpoch: 111 },
            { sessionId: 's2', ptyEpoch: 222 },
          ],
        }),
        NOW,
        EXPIRES,
      );
      const rows = db
        .prepare('SELECT session_id, pty_epoch FROM relay_grant_sessions WHERE grant_id = ? ORDER BY session_id')
        .all('grant-1');
      expect(rows).toEqual([
        { session_id: 's1', pty_epoch: 111 },
        { session_id: 's2', pty_epoch: 222 },
      ]);
    } finally {
      db.close();
    }
  });

  test('a failing session insert rolls the grant row back too', () => {
    // A grant row whose session rows did not land is a grant with an empty
    // scope — and an empty scope plus a valid certificate is a machine-wide
    // grant wearing session-scope clothing.
    const db = freshDb();
    try {
      expect(() =>
        insertGrant(db, request({ sessions: [{ sessionId: 'does-not-exist', ptyEpoch: 1 }] }), NOW, EXPIRES),
      ).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS n FROM relay_grants').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM relay_grant_sessions').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test('the role CHECK constraint rejects a non-mintable role', () => {
    const db = freshDb();
    try {
      // `owner` must never reach this table — a persisted owner grant is a
      // skeleton key.
      expect(() => insertGrant(db, request({ role: 'owner' as never }), NOW, EXPIRES)).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS n FROM relay_grants').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test('deleting a session cascades its grant scope away', () => {
    // Otherwise a grant would keep naming a session id that no longer exists,
    // which a future session could in principle reuse.
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      db.prepare('DELETE FROM sessions WHERE id = ?').run('s1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM relay_grant_sessions').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test('deleting a grant cascades its scope away', () => {
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      db.prepare('DELETE FROM relay_grants WHERE id = ?').run('grant-1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM relay_grant_sessions').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test('the same grant id cannot be inserted twice', () => {
    // A reused grantId would silently hand one grant's holder another grant's
    // session set.
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      expect(() => insertGrant(db, request(), NOW, EXPIRES)).toThrow();
    } finally {
      db.close();
    }
  });

  test('two grants may name the same person and the same session', () => {
    // Sharing a second session with the same colleague is a second grant, not
    // an in-place widening of the first.
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      insertGrant(db, request({ grantId: 'grant-2' }), NOW, EXPIRES);
      expect(db.prepare('SELECT COUNT(*) AS n FROM relay_grants').get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
});

describe('reading grants back', () => {
  test('getGrant hydrates the row and its session scope', () => {
    const db = freshDb();
    try {
      insertGrant(
        db,
        request({
          sessions: [
            { sessionId: 's1', ptyEpoch: 111 },
            { sessionId: 's2', ptyEpoch: 222 },
          ],
        }),
        NOW,
        EXPIRES,
      );
      const grant = getGrant(db, 'grant-1')!;
      expect(grant).toMatchObject({
        id: 'grant-1',
        relayOrigin: 'https://relay.example.com',
        granteeUserId: 'guest-1',
        granteeLogin: 'dana-k',
        role: 'viewer',
        status: 'active',
        revokePending: false,
      });
      expect([...grant.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
        { sessionId: 's1', ptyEpoch: 111 },
        { sessionId: 's2', ptyEpoch: 222 },
      ]);
    } finally {
      db.close();
    }
  });

  test('getGrant returns null for an id that does not exist', () => {
    const db = freshDb();
    try {
      expect(getGrant(db, 'nope')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('listGrants returns every grant, each with its own scope', () => {
    // Scope must not bleed between grants — that is the failure the missing
    // UNIQUE(machine, grantee) makes possible if hydration is wrong.
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      insertGrant(db, request({ grantId: 'grant-2', sessions: [{ sessionId: 's2', ptyEpoch: 222 }] }), NOW, EXPIRES);
      const byId = Object.fromEntries(listGrants(db).map((g) => [g.id, g.sessions.map((s) => s.sessionId)]));
      expect(byId).toEqual({ 'grant-1': ['s1'], 'grant-2': ['s2'] });
    } finally {
      db.close();
    }
  });
});

describe('revocation', () => {
  test('revokeGrant marks it revoked and queues the relay side', () => {
    // Local status is the authority, so this takes effect at the next
    // client:open whether or not the relay ever hears about it.
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      expect(revokeGrant(db, 'grant-1', NOW + 5)).toBe(true);
      const grant = getGrant(db, 'grant-1')!;
      expect(grant.status).toBe('revoked');
      expect(grant.revokePending).toBe(true);
    } finally {
      db.close();
    }
  });

  test('revoking twice reports no change the second time', () => {
    // Otherwise a repeated revoke would re-queue a relay notification for a
    // grant that is already gone.
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      expect(revokeGrant(db, 'grant-1', NOW + 5)).toBe(true);
      expect(revokeGrant(db, 'grant-1', NOW + 6)).toBe(false);
    } finally {
      db.close();
    }
  });

  test('revoking an unknown grant reports no change', () => {
    const db = freshDb();
    try {
      expect(revokeGrant(db, 'nope', NOW)).toBe(false);
    } finally {
      db.close();
    }
  });

  test('pending revocations are listed until explicitly cleared', () => {
    // The queue is what makes revoking while the agent is offline honest
    // rather than a lie.
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      insertGrant(db, request({ grantId: 'grant-2' }), NOW, EXPIRES);
      expect(pendingRevocations(db)).toEqual([]);

      revokeGrant(db, 'grant-1', NOW + 5);
      revokeGrant(db, 'grant-2', NOW + 5);
      expect(pendingRevocations(db).sort()).toEqual(['grant-1', 'grant-2']);

      clearPendingRevocation(db, 'grant-1');
      expect(pendingRevocations(db)).toEqual(['grant-2']);
    } finally {
      db.close();
    }
  });

  test('clearing the queue does not un-revoke the grant', () => {
    // Flushing to the relay must not resurrect access.
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      revokeGrant(db, 'grant-1', NOW + 5);
      clearPendingRevocation(db, 'grant-1');
      expect(getGrant(db, 'grant-1')!.status).toBe('revoked');
    } finally {
      db.close();
    }
  });
});

describe('clearAllGrants', () => {
  test('removes every grant and its scope', () => {
    // Called on a relayUrl change and on re-link: certificates are bound to a
    // relay origin, so keeping rows would leave un-honourable ghosts.
    const db = freshDb();
    try {
      insertGrant(db, request(), NOW, EXPIRES);
      insertGrant(db, request({ grantId: 'grant-2' }), NOW, EXPIRES);
      clearAllGrants(db);
      expect(listGrants(db)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM relay_grant_sessions').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
