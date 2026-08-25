/**
 * Automatic account failover — what happens to live sessions when the account
 * behind them runs out of quota, and how they get back.
 *
 * Runs the real repositories against bun:sqlite, because most of what can go
 * wrong here is a wrong row rather than a wrong branch: an override written
 * where an inheritance belonged, a cooldown overwritten by a vaguer one, a
 * "home" that quietly becomes the backup account after two hops.
 *
 * Run with: bun test src/main/__tests__/account-failover.test.ts
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let db: Database;

mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
}));

mock.module('../database', () => ({
  getDatabase: () => db,
}));

/**
 * Preferences, held in a map this file owns.
 *
 * mock.module is process-global and other suites replace this same module —
 * one of them with a stub that has no setPreference at all — so a preference
 * written through the real repository here is read back through whichever
 * implementation happened to register last. Owning the map removes the
 * ordering dependency; re-registering in beforeEach (below) takes the module
 * back from any suite that loaded before this one.
 */
const prefs = new Map<string, string>();
const prefsModule = () => ({
  getPreference: (key: string) => prefs.get(key) ?? null,
  setPreference: (key: string, value: string) => { prefs.set(key, value); },
  deletePreference: (key: string) => { prefs.delete(key); },
});
mock.module('../repositories/preferences', prefsModule);

const realAccountSwitch = await import('../account-switch');
// A direct function reference, captured before anything re-mocks the module.
// `realAccountSwitch.assignSessionAccount` is a LIVE binding: read after
// mock.module it resolves to the mock, so a mock that reached through the
// namespace to reach "the real one" would call itself until the stack died.
const realAssignSessionAccount = realAccountSwitch.assignSessionAccount;
const failover = await import('../account-failover');
const accountsRepo = await import('../repositories/accounts');
const sessionsRepo = await import('../repositories/sessions');

const HOUR = 60 * 60 * 1000;

function freshDb(): Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      working_dir TEXT,
      state TEXT,
      shell_type TEXT DEFAULT 'claude',
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
    );
    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT,
      working_dir TEXT,
      "order" INTEGER DEFAULT 0,
      created_at TEXT,
      parent_id TEXT DEFAULT NULL,
      collapsed INTEGER DEFAULT 0,
      claude_account_id TEXT DEFAULT NULL
    );
    CREATE TABLE claude_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      config_dir TEXT NOT NULL UNIQUE,
      email TEXT,
      color TEXT DEFAULT '#888888',
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      fallback_rank INTEGER DEFAULT NULL,
      limited_until TEXT DEFAULT NULL,
      limited_at TEXT DEFAULT NULL
    );
    CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT);
  `);
  return d;
}

function addAccount(id: string, rank: number | null, isDefault = false): void {
  db.prepare(`
    INSERT INTO claude_accounts (id, label, config_dir, is_default, created_at, fallback_rank)
    VALUES (?, ?, ?, ?, '2026-08-01T00:00:00Z', ?)
  `).run(id, id, `/tmp/bodhilander-test/${id}`, isDefault ? 1 : 0, rank);
}

function addGroup(id: string, accountId: string | null = null): void {
  db.prepare(`
    INSERT INTO groups (id, name, created_at, claude_account_id)
    VALUES (?, ?, '2026-08-01T00:00:00Z', ?)
  `).run(id, id, accountId);
}

function addSession(id: string, groupId: string, accountId: string | null, state = 'working'): void {
  db.prepare(`
    INSERT INTO sessions (id, group_id, name, working_dir, state, created_at, last_activity_at, claude_account_id)
    VALUES (?, ?, ?, '/tmp', ?, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', ?)
  `).run(id, groupId, id, state, accountId);
}

/** The live-binding map the pty manager hands over. */
function live(bindings: Record<string, string>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(bindings).map(([sessionId, accountId]) => [
      sessionId,
      { accountId, configDir: `/tmp/bodhilander-test/${accountId}`, spawnedAt: 0 },
    ]),
  );
}

beforeEach(() => {
  db = freshDb();
  mock.module('../repositories/preferences', prefsModule);
  prefs.clear();
  // Failover is opt-in. These tests are about what it does once
  // switched on; the off case is asserted explicitly below.
  prefs.set('accountFailoverEnabled', 'true');
});

describe('handleUsageLimit', () => {
  test('records the reset time the CLI gave us', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addGroup('g');
    addSession('s1', 'g', 'primary');

    const resetAt = new Date(Date.now() + 2 * HOUR);
    failover.handleUsageLimit({
      sessionId: 's1', accountId: 'primary', resetAt, liveAccounts: live({ s1: 'primary' }),
    });

    expect(accountsRepo.getAccount('primary')!.limitedUntil!.toISOString())
      .toBe(resetAt.toISOString());
  });

  /**
   * No reset time in the message means the account is held for a full rolling
   * window rather than released optimistically — an account handed back early
   * is a second failover, and a second restart, for every session on it.
   */
  test('falls back to a full window when the message named no reset', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addGroup('g');
    addSession('s1', 'g', 'primary');

    const before = Date.now();
    failover.handleUsageLimit({
      sessionId: 's1', accountId: 'primary', resetAt: null, liveAccounts: live({ s1: 'primary' }),
    });

    const until = accountsRepo.getAccount('primary')!.limitedUntil!.getTime();
    expect(until).toBeGreaterThanOrEqual(before + accountsRepo.DEFAULT_COOLDOWN_MS);
  });

  /**
   * The limit belongs to the account, not to the session that noticed it, so
   * every session on that account is already dead in the water. Moving them
   * one at a time as each hits the wall would restart them minutes apart for
   * no gain.
   */
  test('moves every live session on the spent account, not just the reporter', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addGroup('g');
    addSession('s1', 'g', 'primary');
    addSession('s2', 'g', 'primary');
    addSession('elsewhere', 'g', 'backup');

    const event = failover.handleUsageLimit({
      sessionId: 's1',
      accountId: 'primary',
      resetAt: null,
      liveAccounts: live({ s1: 'primary', s2: 'primary', elsewhere: 'backup' }),
    });

    expect(event!.sessionIds.sort()).toEqual(['s1', 's2']);
    expect(sessionsRepo.getSession('s2')!.claudeAccountId).toBe('backup');
    expect(sessionsRepo.getSession('elsewhere')!.claudeAccountId).toBe('backup');
  });

  test('follows the fallback order and skips an account already limited', () => {
    addAccount('primary', 0, true);
    addAccount('second', 1);
    addAccount('third', 2);
    accountsRepo.markAccountLimited('second', new Date(Date.now() + HOUR));
    addGroup('g');
    addSession('s1', 'g', 'primary');

    const event = failover.handleUsageLimit({
      sessionId: 's1', accountId: 'primary', resetAt: null, liveAccounts: live({ s1: 'primary' }),
    });

    expect(event!.to!.id).toBe('third');
  });

  test('says so, rather than nothing, when every account is spent', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    accountsRepo.markAccountLimited('backup', new Date(Date.now() + HOUR));
    addGroup('g');
    addSession('s1', 'g', 'primary');

    const event = failover.handleUsageLimit({
      sessionId: 's1', accountId: 'primary', resetAt: null, liveAccounts: live({ s1: 'primary' }),
    });

    expect(event!.blocked).toBe('no-healthy-account');
    expect(event!.sessionIds).toEqual([]);
    expect(sessionsRepo.getSession('s1')!.claudeAccountId).toBe('primary');
  });

  /**
   * Switched off, nothing is recorded either.
   *
   * When detection is wrong the marking IS the harm — an account shown as
   * spent and skipped as a target for hours — so the control has to stop it.
   */
  test('records nothing at all when failover is switched off', () => {
    prefs.set('accountFailoverEnabled', 'false');
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addGroup('g');
    addSession('s1', 'g', 'primary');

    expect(failover.handleUsageLimit({
      sessionId: 's1', accountId: 'primary', resetAt: null, liveAccounts: live({ s1: 'primary' }),
    })).toBeNull();
    expect(sessionsRepo.getSession('s1')!.claudeAccountId).toBe('primary');
    expect(accountsRepo.getAccount('primary')!.limitedUntil).toBeNull();
  });

  test('is on unless explicitly switched off', () => {
    prefs.clear();
    expect(failover.isFailoverEnabled()).toBe(true);
  });

  /**
   * A session the user has already redirected is restarted, not re-pointed.
   * The respawn applies the switch they chose, which gets it off the spent
   * account just as well — and rewriting the assignment would throw away a
   * decision they made on purpose.
   */
  test('restarts a session with a pending manual switch without overriding it', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addAccount('chosen', 2);
    addGroup('g');
    addSession('s1', 'g', 'chosen');

    const event = failover.handleUsageLimit({
      // The pty is still billing 'primary' — that is why it reported the limit.
      sessionId: 's1', accountId: 'primary', resetAt: null, liveAccounts: live({ s1: 'primary' }),
    });

    expect(event!.sessionIds).toEqual(['s1']);
    expect(sessionsRepo.getSession('s1')!.claudeAccountId).toBe('chosen');
    expect(sessionsRepo.getSession('s1')!.failoverFromAccountId).toBeNull();
  });

  test('does nothing for a session with no account bound', () => {
    addGroup('g');
    addSession('s1', 'g', null);
    expect(failover.handleUsageLimit({
      sessionId: 's1', accountId: null, resetAt: null, liveAccounts: {},
    })).toBeNull();
  });
});

describe('going home', () => {
  /**
   * A session that inherited its account from its group must go back to
   * INHERITING, not to the account that inheritance happened to resolve to.
   * Pinning it would quietly convert a group-wide setting into a per-session
   * override that then ignores every future group change.
   */
  test('restores an inherited assignment rather than pinning it', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addGroup('g', 'primary');
    addSession('s1', 'g', null);

    failover.handleUsageLimit({
      sessionId: 's1', accountId: 'primary', resetAt: null, liveAccounts: live({ s1: 'primary' }),
    });
    expect(sessionsRepo.getSession('s1')!.claudeAccountId).toBe('backup');

    accountsRepo.clearAccountLimit('primary');
    failover.failBackSession('s1');

    const after = sessionsRepo.getSession('s1')!;
    expect(after.claudeAccountId).toBeNull();
    expect(after.failoverFromAccountId).toBeNull();
  });

  /**
   * Two hops: primary runs dry, then the backup does too. Home is still the
   * primary — the backup is just as spent, and it was never where the user put
   * this session.
   */
  test('keeps the original home across a second failover', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addAccount('third', 2);
    addGroup('g');
    addSession('s1', 'g', 'primary');

    failover.handleUsageLimit({
      sessionId: 's1', accountId: 'primary', resetAt: null, liveAccounts: live({ s1: 'primary' }),
    });
    failover.handleUsageLimit({
      sessionId: 's1', accountId: 'backup', resetAt: null, liveAccounts: live({ s1: 'backup' }),
    });

    expect(sessionsRepo.getSession('s1')!.claudeAccountId).toBe('third');
    expect(sessionsRepo.getSession('s1')!.failoverFromAccountId).toBe('primary');

    accountsRepo.clearAccountLimit('primary');
    const event = failover.failBackSession('s1');
    expect(event!.to!.id).toBe('primary');
    expect(sessionsRepo.getSession('s1')!.claudeAccountId).toBe('primary');
  });

  test('offers no candidate while the original account is still limited', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addGroup('g');
    addSession('s1', 'g', 'primary');

    failover.handleUsageLimit({
      sessionId: 's1',
      accountId: 'primary',
      resetAt: new Date(Date.now() + HOUR),
      liveAccounts: live({ s1: 'primary' }),
    });

    expect(failover.failbackCandidates()).toEqual([]);
    // ...and offers it once the cooldown has run out.
    const later = new Date(Date.now() + 2 * HOUR);
    expect(failover.failbackCandidates(later).map(c => c.sessionId)).toEqual(['s1']);
  });

  /**
   * Going home costs a respawn, and a respawn mid-turn throws away work in
   * flight. This gate is the only reason an unprompted switch back is safe.
   */
  test('only moves a session that is between turns', () => {
    expect(failover.canFailBackNow('idle')).toBe(true);
    expect(failover.canFailBackNow('stopped')).toBe(true);
    expect(failover.canFailBackNow('working')).toBe(false);
    expect(failover.canFailBackNow('waiting')).toBe(false);
  });

  test('a deleted home retires the pending move instead of stranding it', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addGroup('g');
    addSession('s1', 'g', 'primary');

    failover.handleUsageLimit({
      sessionId: 's1', accountId: 'primary', resetAt: null, liveAccounts: live({ s1: 'primary' }),
    });
    db.prepare("DELETE FROM claude_accounts WHERE id = 'primary'").run();

    expect(failover.failbackCandidates()).toEqual([]);
    expect(sessionsRepo.getSession('s1')!.failoverFromAccountId).toBeNull();
  });

  test('a hand-picked account retires the pending move', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addGroup('g');
    addSession('s1', 'g', 'primary');

    failover.handleUsageLimit({
      sessionId: 's1', accountId: 'primary', resetAt: null, liveAccounts: live({ s1: 'primary' }),
    });
    failover.clearFailoverRecord('s1');
    accountsRepo.clearAccountLimit('primary');

    expect(failover.failbackCandidates()).toEqual([]);
    expect(failover.failBackSession('s1')).toBeNull();
  });
});

describe('cooldown bookkeeping', () => {
  /**
   * Two sessions hit the wall seconds apart and the second message is usually
   * the vaguer one — no "resets at" clause, so the default window. Taking the
   * later of the two stops a precise reset time being overwritten by a guess.
   */
  test('a second, vaguer report cannot shorten a precise cooldown', () => {
    addAccount('primary', 0, true);
    const precise = new Date(Date.now() + 4 * HOUR);
    accountsRepo.markAccountLimited('primary', precise);
    accountsRepo.markAccountLimited('primary', new Date(Date.now() + HOUR));

    expect(accountsRepo.getAccount('primary')!.limitedUntil!.toISOString())
      .toBe(precise.toISOString());
  });

  test('an expired cooldown is not a limit', () => {
    addAccount('primary', 0, true);
    accountsRepo.markAccountLimited('primary', new Date(Date.now() + HOUR));

    const account = accountsRepo.getAccount('primary')!;
    expect(accountsRepo.isAccountHealthy(account)).toBe(false);
    expect(accountsRepo.isAccountHealthy(account, new Date(Date.now() + 2 * HOUR))).toBe(true);
  });

  /**
   * SQLite sorts NULL first, so an unranked account would otherwise outrank
   * every account the user deliberately placed.
   */
  test('unranked accounts sort after ranked ones', () => {
    addAccount('unranked', null);
    addAccount('second', 1);
    addAccount('first', 0);

    expect(accountsRepo.getAccountsInFallbackOrder().map(a => a.id))
      .toEqual(['first', 'second', 'unranked']);
  });

  test('setFallbackOrder writes the order it was given', () => {
    addAccount('a', 0);
    addAccount('b', 1);
    addAccount('c', 2);

    accountsRepo.setFallbackOrder(['c', 'a', 'b']);
    expect(accountsRepo.getAccountsInFallbackOrder().map(a => a.id)).toEqual(['c', 'a', 'b']);
  });
});

/**
 * The desktop notification's wording.
 *
 * Tested for the same failure its in-window counterpart is: a sentence that
 * claims sessions moved when none did. The notification is the harder case of
 * the two — it is often the only account of the switch a user ever sees, since
 * the window may be behind something when it fires.
 */
describe('describeFailover', () => {
  const account = (id: string, label: string) => ({ id, label } as any);

  test('names the new account and how many sessions moved', () => {
    const { title, body } = failover.describeFailover({
      reason: 'limit',
      from: account('a', 'Personal'),
      to: account('b', 'Work'),
      sessionIds: ['s1', 's2'],
      resetAt: null,
    });
    expect(title).toContain('Work');
    expect(body).toContain('Personal');
    expect(body).toContain('2 sessions moved to Work');
  });

  test('never claims a move when there was nowhere to go', () => {
    const { body } = failover.describeFailover({
      reason: 'limit',
      from: account('a', 'Personal'),
      to: null,
      sessionIds: [],
      resetAt: null,
      blocked: 'no-healthy-account',
    });
    expect(body).toContain('No other account is available');
    expect(body).not.toContain('moved to');
  });

  test('reads as a return on the way home', () => {
    const { title, body } = failover.describeFailover({
      reason: 'failback',
      from: account('b', 'Work'),
      to: account('a', 'Personal'),
      sessionIds: ['s1'],
      resetAt: null,
    });
    expect(title).toContain('Personal');
    expect(body).toContain('1 session returned');
  });
});

/**
 * One session failing to move must cost exactly one session.
 *
 * This is not a hypothetical tidy-up. handleUsageLimit's caller catches, so a
 * throw part-way through the loop used to mean publishFailover was never
 * reached for ANY of them: the sessions already reassigned stayed reassigned in
 * the database, the renderer never got its refresh, no pty was respawned onto
 * the new account, and the user was told nothing — while their sessions went on
 * billing the account that had just run dry.
 */
describe('a session that cannot be moved', () => {
  test('does not silence the switch for the ones that can', () => {
    addAccount('primary', 0, true);
    addAccount('backup', 1);
    addGroup('g');
    addSession('bad', 'g', 'primary');
    addSession('s1', 'g', 'primary');

    mock.module('../account-switch', () => ({
      assignSessionAccount: (sessionId: string, accountId: string | null) => {
        if (sessionId === 'bad') throw new Error('assign blew up');
        return realAssignSessionAccount(sessionId, accountId);
      },
    }));

    try {
      // 'bad' is iterated first, so the throw lands before the good move.
      const event = failover.handleUsageLimit({
        sessionId: 's1',
        accountId: 'primary',
        resetAt: null,
        liveAccounts: live({ bad: 'primary', s1: 'primary' }),
      });

      expect(event).not.toBeNull();
      expect(event!.sessionIds).toEqual(['s1']);
      expect(event!.to!.id).toBe('backup');
      expect(sessionsRepo.getSession('s1')!.claudeAccountId).toBe('backup');
      // The one that threw is left where it was, not half-moved.
      expect(sessionsRepo.getSession('bad')!.claudeAccountId).toBe('primary');
    } finally {
      mock.module('../account-switch', () => ({ assignSessionAccount: realAssignSessionAccount }));
    }
  });
});
