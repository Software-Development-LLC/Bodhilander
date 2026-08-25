/**
 * Sessions repository tests (#96) — provider persistence and the
 * resume-UUID invalidation that fires when a session's provider changes.
 *
 * Uses bun:sqlite (API-compatible with better-sqlite3 for the statements the
 * repo issues) so no native build is required to run the suite.
 *
 * Run with: bun test src/main/repositories
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Session } from '../../../shared/types';

let db: Database;

mock.module('../../database', () => ({
  getDatabase: () => db,
}));

const sessionsRepo = await import('../sessions');

function freshDb(): Database {
  const d = new Database(':memory:');
  // Post-migration sessions schema (subset ordering irrelevant)
  d.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      working_dir TEXT,
      state TEXT,
      shell_type TEXT DEFAULT 'bash',
      "order" INTEGER DEFAULT 0,
      created_at TEXT,
      last_activity_at TEXT,
      claude_session_id TEXT DEFAULT NULL,
      ended_at TEXT DEFAULT NULL,
      duration_seconds REAL DEFAULT 0,
      claude_account_id TEXT DEFAULT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      failover_from_account_id TEXT DEFAULT NULL,
      failover_prev_account_id TEXT DEFAULT NULL
    )
  `);
  return d;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    groupId: 'g1',
    name: 'test',
    workingDir: '/tmp',
    state: 'idle',
    shellType: 'claude',
    order: 0,
    createdAt: new Date('2026-07-13T00:00:00Z'),
    lastActivityAt: new Date('2026-07-13T00:00:00Z'),
    claudeSessionId: null,
    endedAt: null,
    durationSeconds: 0,
    claudeAccountId: null,
    provider: 'claude',
    ...overrides,
  };
}

beforeEach(() => {
  db = freshDb();
});

describe('provider persistence', () => {
  test('createSession/getAllSessions round-trips the provider', () => {
    sessionsRepo.createSession(makeSession({ id: 'grok-1', provider: 'grok' }));
    sessionsRepo.createSession(makeSession({ id: 'claude-1', provider: 'claude' }));

    const byId = new Map(sessionsRepo.getAllSessions().map((s) => [s.id, s]));
    expect(byId.get('grok-1')?.provider).toBe('grok');
    expect(byId.get('claude-1')?.provider).toBe('claude');
  });

  test('rows without a provider value read back as claude (pre-migration data)', () => {
    db.exec(`
      INSERT INTO sessions (id, group_id, name, created_at, last_activity_at, provider)
      VALUES ('legacy', 'g1', 'old', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'claude')
    `);
    expect(sessionsRepo.getAllSessions()[0].provider).toBe('claude');
  });
});

describe('updateSession provider change invalidates the stored resume UUID', () => {
  beforeEach(() => {
    sessionsRepo.createSession(makeSession());
    sessionsRepo.setClaudeSessionId('s1', 'uuid-belonging-to-claude');
  });

  test('changing provider clears claude_session_id in the same statement', () => {
    sessionsRepo.updateSession('s1', { provider: 'codex' });
    const s = sessionsRepo.getAllSessions()[0];
    expect(s.provider).toBe('codex');
    expect(s.claudeSessionId).toBeNull();
  });

  test('setting provider to its current value preserves the UUID', () => {
    sessionsRepo.updateSession('s1', { provider: 'claude' });
    const s = sessionsRepo.getAllSessions()[0];
    expect(s.provider).toBe('claude');
    expect(s.claudeSessionId).toBe('uuid-belonging-to-claude');
  });

  test('updates without a provider field never touch the UUID', () => {
    sessionsRepo.updateSession('s1', { name: 'renamed', state: 'working' });
    const s = sessionsRepo.getAllSessions()[0];
    expect(s.name).toBe('renamed');
    expect(s.claudeSessionId).toBe('uuid-belonging-to-claude');
  });

  test('switching back to the original provider does not resurrect the UUID', () => {
    sessionsRepo.updateSession('s1', { provider: 'codex' });
    sessionsRepo.updateSession('s1', { provider: 'claude' });
    const s = sessionsRepo.getAllSessions()[0];
    expect(s.provider).toBe('claude');
    expect(s.claudeSessionId).toBeNull();
  });
});
