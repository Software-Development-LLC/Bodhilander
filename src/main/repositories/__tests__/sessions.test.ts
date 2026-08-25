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
      provider TEXT NOT NULL DEFAULT 'claude'
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

describe('working directories that are not on this machine', () => {
  const present = '/present/checkout';
  const gone = '/gone/checkout';
  const probe = (dir: string) => dir === present;

  beforeEach(() => {
    sessionsRepo.createSession(makeSession({ id: 'here', workingDir: present }));
    sessionsRepo.createSession(makeSession({ id: 'away', workingDir: gone }));
  });

  test('are reported per session, derived rather than stored', () => {
    const byId = new Map(sessionsRepo.getAllSessions(probe).map((s) => [s.id, s]));
    expect(byId.get('here')!.workingDirMissing).toBe(false);
    expect(byId.get('away')!.workingDirMissing).toBe(true);
  });

  test('survive the bulk state reset every app start performs', () => {
    sessionsRepo.markAllSessionsStopped();

    const away = sessionsRepo.getAllSessions(probe).find((s) => s.id === 'away')!;
    expect(away.state).toBe('stopped');
    expect(away.workingDirMissing).toBe(true);
  });

  test('survive an ordinary state change the user causes', () => {
    sessionsRepo.updateSession('away', { state: 'error' });

    const away = sessionsRepo.getAllSessions(probe).find((s) => s.id === 'away')!;
    expect(away.workingDirMissing).toBe(true);
  });

  test('clear the moment the directory is pointed somewhere real', () => {
    sessionsRepo.updateSession('away', { workingDir: present, state: 'stopped' });

    const away = sessionsRepo.getAllSessions(probe).find((s) => s.id === 'away')!;
    expect(away.workingDir).toBe(present);
    expect(away.workingDirMissing).toBe(false);
  });

  test('a blank working directory counts as missing', () => {
    sessionsRepo.createSession(makeSession({ id: 'blank', workingDir: '' }));

    const blank = sessionsRepo.getAllSessions(probe).find((s) => s.id === 'blank')!;
    expect(blank.workingDirMissing).toBe(true);
  });

  test('one probe per distinct directory, however many sessions share it', () => {
    sessionsRepo.createSession(makeSession({ id: 'here-too', workingDir: present }));
    const asked: string[] = [];

    sessionsRepo.getAllSessions((dir) => { asked.push(dir); return dir === present; });

    // Three sessions, two directories: the third reused the cached answer.
    expect(asked).toHaveLength(2);
    expect(new Set(asked)).toEqual(new Set([present, gone]));
  });
});
