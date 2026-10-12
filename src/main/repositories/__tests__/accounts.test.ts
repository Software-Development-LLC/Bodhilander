/**
 * Accounts repository tests (#165) — the default-account state machine.
 *
 * The default is the fallback every unassigned session launches under, so the
 * rows that carry `is_default` are what decide which login the CLI actually
 * runs as. The cases pinned here are the transitions that can strand the app
 * in "accounts exist, none is default": createAccount's opt-in promotion,
 * setDefaultAccount's demote-then-promote, and deleteAccount promoting the
 * oldest survivor when the deleted row was the default. Also pinned: the
 * SET NULL that deleteAccount hand-rolls over sessions and groups, because
 * SQLite ALTER TABLE could not give those columns a real foreign key.
 *
 * Uses bun:sqlite (API-compatible with better-sqlite3 for the statements the
 * repo issues) so no native build is required to run the suite.
 *
 * Mock discipline: bun's mock.module patches a specifier for the WHOLE test
 * process, keyed by resolved path, so this file can only test the real
 * accounts repository as long as no other file mocks it. Nothing else may
 * mock '../repositories/accounts' — pty-manager.test.ts and
 * account-auth.test.ts both used to, and both were switched to other means
 * (see their headers) precisely so this file's subject stays real. Mocking
 * '../../database' is safe: every repository test does it, and each supplies
 * the same getDatabase-returns-the-current-`db` shape.
 *
 * Run with: bun test src/main/repositories
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let db: Database;

mock.module('../../database', () => ({
  getDatabase: () => db,
}));

const accountsRepo = await import('../accounts');

function freshDb(): Database {
  const d = new Database(':memory:');
  // Post-migration schema. The partial unique index is part of the contract
  // being tested: any promotion that forgets to demote first fails loudly
  // here instead of quietly producing two defaults.
  d.exec(`
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
    CREATE UNIQUE INDEX idx_claude_accounts_single_default
      ON claude_accounts(is_default) WHERE is_default = 1;

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      name TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      claude_account_id TEXT DEFAULT NULL,
      failover_from_account_id TEXT DEFAULT NULL,
      failover_prev_account_id TEXT DEFAULT NULL
    );

    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      claude_account_id TEXT DEFAULT NULL,
      failover_from_account_id TEXT DEFAULT NULL,
      failover_prev_account_id TEXT DEFAULT NULL
    );
  `);
  return d;
}

/**
 * Create an account through the real repository, then pin its created_at.
 * createAccount stamps `new Date()`, and rows made in the same millisecond
 * leave "the oldest survivor" ambiguous — which is the exact thing the
 * promotion tests need to be unambiguous.
 */
function seedAccount(
  id: string,
  createdAt: string,
  opts: { isDefault?: boolean; color?: string } = {},
): void {
  accountsRepo.createAccount({
    id,
    label: `Account ${id}`,
    configDir: `/config/${id}`,
    ...opts,
  });
  db.prepare('UPDATE claude_accounts SET created_at = ? WHERE id = ?').run(createdAt, id);
}

function isDefaultOf(id: string): boolean {
  const row = db.prepare('SELECT is_default FROM claude_accounts WHERE id = ?').get(id) as
    { is_default: number } | undefined;
  return Boolean(row?.is_default);
}

/** Ids currently flagged default — a list so "two defaults" is visible, not collapsed. */
function defaultIds(): string[] {
  return (db.prepare('SELECT id FROM claude_accounts WHERE is_default = 1 ORDER BY id').all() as
    { id: string }[]).map((r) => r.id);
}

beforeEach(() => {
  db = freshDb();
});

describe('createAccount', () => {
  test('fills in the nullable columns: grey swatch, not default, never used', () => {
    const account = accountsRepo.createAccount({
      id: 'a',
      label: 'Work',
      configDir: '/config/a',
    });

    expect(account).toMatchObject({
      id: 'a',
      label: 'Work',
      configDir: '/config/a',
      email: null,
      color: '#888888',
      isDefault: false,
      lastUsedAt: null,
    });
    // The returned object is a promise about the row, so read the row back.
    expect(accountsRepo.getAccount('a')).toEqual(account);
  });

  test('stores the caller colour and returns a createdAt matching the row', () => {
    const account = accountsRepo.createAccount({
      id: 'a',
      label: 'Work',
      configDir: '/config/a',
      color: '#61afef',
    });

    const stored = accountsRepo.getAccount('a')!;
    expect(stored.color).toBe('#61afef');
    expect(stored.createdAt.getTime()).toBe(account.createdAt.getTime());
  });

  test('isDefault demotes the incumbent inside the same transaction', () => {
    seedAccount('first', '2026-01-01T00:00:00.000Z', { isDefault: true });
    seedAccount('second', '2026-02-01T00:00:00.000Z', { isDefault: true });

    // Insert-then-demote would trip the partial unique index; the repo demotes
    // first, so exactly one row survives as default.
    expect(defaultIds()).toEqual(['second']);
    expect(accountsRepo.getDefaultAccount()?.id).toBe('second');
  });

  test('a non-default insert leaves the incumbent alone', () => {
    seedAccount('first', '2026-01-01T00:00:00.000Z', { isDefault: true });
    seedAccount('second', '2026-02-01T00:00:00.000Z');

    expect(defaultIds()).toEqual(['first']);
  });
});

describe('getAllAccounts / getDefaultAccount', () => {
  test('the default sorts first, the rest oldest-first', () => {
    seedAccount('old', '2026-01-01T00:00:00.000Z');
    seedAccount('middle', '2026-02-01T00:00:00.000Z');
    seedAccount('newest', '2026-03-01T00:00:00.000Z', { isDefault: true });

    expect(accountsRepo.getAllAccounts().map((a) => a.id)).toEqual(['newest', 'old', 'middle']);
  });

  test('no rows: no default, no accounts, no throw', () => {
    expect(accountsRepo.getAllAccounts()).toEqual([]);
    expect(accountsRepo.getDefaultAccount()).toBeNull();
    expect(accountsRepo.getAccount('nope')).toBeNull();
  });
});

describe('updateAccount', () => {
  beforeEach(() => {
    seedAccount('a', '2026-01-01T00:00:00.000Z', { isDefault: true, color: '#61afef' });
  });

  test('writes only the fields present in the input', () => {
    accountsRepo.updateAccount('a', { label: 'Renamed' });

    const account = accountsRepo.getAccount('a')!;
    expect(account.label).toBe('Renamed');
    // Omitted fields are absent from the SET list, not written as undefined.
    expect(account.color).toBe('#61afef');
    expect(account.email).toBeNull();
    expect(account.isDefault).toBe(true);
  });

  test('an explicit null email clears the column (login flow found no address)', () => {
    accountsRepo.updateAccount('a', { email: 'user@example.com' });
    expect(accountsRepo.getAccount('a')!.email).toBe('user@example.com');

    accountsRepo.updateAccount('a', { email: null });
    expect(accountsRepo.getAccount('a')!.email).toBeNull();
  });

  test('an empty update is a no-op rather than invalid SQL', () => {
    // `UPDATE ... SET  WHERE id = ?` is a syntax error, so the early return is
    // load-bearing: handleLoginCompleted calls this with whatever it parsed.
    expect(() => accountsRepo.updateAccount('a', {})).not.toThrow();
    expect(accountsRepo.getAccount('a')!.label).toBe('Account a');
  });

  test('updating an unknown id changes nothing', () => {
    accountsRepo.updateAccount('ghost', { label: 'Nope' });
    expect(accountsRepo.getAllAccounts().map((a) => a.label)).toEqual(['Account a']);
  });
});

describe('setDefaultAccount', () => {
  test('demotes the incumbent before promoting, so only one default exists', () => {
    seedAccount('a', '2026-01-01T00:00:00.000Z', { isDefault: true });
    seedAccount('b', '2026-02-01T00:00:00.000Z');

    expect(accountsRepo.setDefaultAccount('b')).toBe(true);

    expect(defaultIds()).toEqual(['b']);
    expect(accountsRepo.getDefaultAccount()?.id).toBe('b');
  });

  test('re-defaulting the current default is idempotent, and still reports true', () => {
    seedAccount('a', '2026-01-01T00:00:00.000Z', { isDefault: true });

    expect(accountsRepo.setDefaultAccount('a')).toBe(true);

    expect(defaultIds()).toEqual(['a']);
  });

  test('pointing at an unknown id leaves the incumbent default and reports false', () => {
    // The renderer offers ids from a cached list, so it can ask for an account
    // another window already deleted. The demote must not land without a
    // matching promote — otherwise this is the same accountless state #165
    // closed on the delete path — and `false` is how a caller can tell the
    // switch it asked for never happened.
    seedAccount('a', '2026-01-01T00:00:00.000Z', { isDefault: true });

    expect(accountsRepo.setDefaultAccount('ghost')).toBe(false);

    expect(defaultIds()).toEqual(['a']);
    expect(accountsRepo.getDefaultAccount()?.id).toBe('a');
  });

  test('an unknown id against an empty table reports false without throwing', () => {
    expect(accountsRepo.setDefaultAccount('ghost')).toBe(false);
    expect(accountsRepo.getDefaultAccount()).toBeNull();
  });
});

describe('touchAccount', () => {
  test('stamps last_used_at without disturbing anything else', () => {
    seedAccount('a', '2026-01-01T00:00:00.000Z', { isDefault: true });
    expect(accountsRepo.getAccount('a')!.lastUsedAt).toBeNull();

    const before = Date.now();
    accountsRepo.touchAccount('a');

    const account = accountsRepo.getAccount('a')!;
    expect(account.lastUsedAt).not.toBeNull();
    expect(account.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(account.isDefault).toBe(true);
    expect(account.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  test('touching an unknown id is a no-op', () => {
    seedAccount('a', '2026-01-01T00:00:00.000Z');
    accountsRepo.touchAccount('ghost');
    expect(accountsRepo.getAccount('a')!.lastUsedAt).toBeNull();
  });
});

describe('deleteAccount promotes a survivor (#165)', () => {
  test('deleting the default hands it to the oldest remaining account', () => {
    // Deliberately not creation order: the newest row is the current default,
    // so promotion has to sort by created_at rather than take whatever the
    // table hands back first.
    seedAccount('old', '2026-01-01T00:00:00.000Z');
    seedAccount('middle', '2026-02-01T00:00:00.000Z');
    seedAccount('newest', '2026-03-01T00:00:00.000Z', { isDefault: true });

    accountsRepo.deleteAccount('newest');

    expect(defaultIds()).toEqual(['old']);
    expect(accountsRepo.getDefaultAccount()?.id).toBe('old');
  });

  test('deleting a non-default leaves the default where it was', () => {
    // 'old' outlives the delete and is older than the current default, so a
    // promotion that fired on every delete rather than only on the default's
    // would try to flag it while 'chosen' is still flagged — which the partial
    // unique index turns into a thrown transaction rather than a silent
    // second default.
    seedAccount('old', '2026-01-01T00:00:00.000Z');
    seedAccount('doomed', '2026-02-01T00:00:00.000Z');
    seedAccount('chosen', '2026-03-01T00:00:00.000Z', { isDefault: true });

    accountsRepo.deleteAccount('doomed');

    expect(defaultIds()).toEqual(['chosen']);
    expect(isDefaultOf('old')).toBe(false);
  });

  test('deleting the last account leaves an empty table instead of throwing', () => {
    // The promotion subquery selects no row here; the UPDATE must be a no-op,
    // not an error the login-flow rollback path would surface as a spawn failure.
    seedAccount('only', '2026-01-01T00:00:00.000Z', { isDefault: true });

    expect(() => accountsRepo.deleteAccount('only')).not.toThrow();
    expect(accountsRepo.getAllAccounts()).toEqual([]);
    expect(accountsRepo.getDefaultAccount()).toBeNull();
  });

  test('deleting a non-default last-but-one still promotes nobody by accident', () => {
    seedAccount('a', '2026-01-01T00:00:00.000Z');
    seedAccount('b', '2026-02-01T00:00:00.000Z');

    // Neither row is default (a state databases that predate the #165
    // promotion can still carry).
    accountsRepo.deleteAccount('b');

    expect(defaultIds()).toEqual([]);
    expect(isDefaultOf('a')).toBe(false);
  });

  test('deleting an id that is not in the table changes nothing', () => {
    seedAccount('a', '2026-01-01T00:00:00.000Z', { isDefault: true });
    seedAccount('b', '2026-02-01T00:00:00.000Z');

    accountsRepo.deleteAccount('ghost');

    expect(accountsRepo.getAllAccounts().map((a) => a.id)).toEqual(['a', 'b']);
    expect(defaultIds()).toEqual(['a']);
  });
});

describe('deleteAccount NULLs referring rows', () => {
  beforeEach(() => {
    seedAccount('doomed', '2026-01-01T00:00:00.000Z', { isDefault: true });
    seedAccount('keeper', '2026-02-01T00:00:00.000Z');
    db.exec(`
      INSERT INTO sessions (id, group_id, name, working_dir, claude_account_id) VALUES
        ('s-doomed', 'g1', 'one', '/tmp', 'doomed'),
        ('s-keeper', 'g1', 'two', '/tmp', 'keeper'),
        ('s-none',   'g1', 'three', '/tmp', NULL);
      INSERT INTO groups (id, name, claude_account_id) VALUES
        ('g-doomed', 'group one', 'doomed'),
        ('g-keeper', 'group two', 'keeper');
    `);
  });

  test('sessions and groups pointing at the deleted account are cleared', () => {
    accountsRepo.deleteAccount('doomed');

    const sessionAccounts = db.prepare(
      'SELECT id, claude_account_id FROM sessions ORDER BY id'
    ).all() as { id: string; claude_account_id: string | null }[];
    expect(sessionAccounts).toEqual([
      { id: 's-doomed', claude_account_id: null },
      { id: 's-keeper', claude_account_id: 'keeper' },
      { id: 's-none', claude_account_id: null },
    ]);

    const groupAccounts = db.prepare(
      'SELECT id, claude_account_id FROM groups ORDER BY id'
    ).all() as { id: string; claude_account_id: string | null }[];
    expect(groupAccounts).toEqual([
      { id: 'g-doomed', claude_account_id: null },
      { id: 'g-keeper', claude_account_id: 'keeper' },
    ]);
  });

  test('the surviving account is promoted in the same transaction as the SET NULLs', () => {
    accountsRepo.deleteAccount('doomed');

    // One trip: the rows are re-homed and a default exists again, so no
    // observer can see sessions with a dangling id or an accountless app.
    expect(defaultIds()).toEqual(['keeper']);
    expect(accountsRepo.getAccount('doomed')).toBeNull();
  });
});
