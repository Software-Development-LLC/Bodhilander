/**
 * Account resolution for a run's gates (#327).
 *
 * The chain that matters: a run's group's account wins; else the default
 * account; else null (ambient ~/.claude, the pre-#327 behaviour). A partial DB
 * (no accounts table) must not throw a gate spawn — it falls back to ambient.
 *
 * Run with: bun test src/main/__tests__/account-resolver.test.ts
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let db: Database;
mock.module('../database', () => ({ getDatabase: () => db }));

const { resolveAccountForGroup } = await import('../account-resolver');
const usageStore = await import('../usage-store');

/** A fresh usage reading at `pct` in the 5-hour window. */
function usageAt(accountId: string, pct: number): void {
  usageStore.setUsage({
    accountId,
    fiveHour: { pct, resetsAt: Date.now() + 3_600_000, observedAt: Date.now() },
    sevenDay: null,
    source: 'poll',
    observedAt: Date.now(),
    unavailable: null,
  });
}

function freshDb(): Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE claude_accounts (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, config_dir TEXT NOT NULL,
      email TEXT, color TEXT, is_default INTEGER DEFAULT 0, created_at TEXT,
      last_used_at TEXT, fallback_rank INTEGER, limited_until TEXT, limited_at TEXT
    );
    CREATE TABLE groups (id TEXT PRIMARY KEY, claude_account_id TEXT);
  `);
  return d;
}

function seedAccount(id: string, isDefault = 0) {
  db.prepare(
    `INSERT INTO claude_accounts (id, label, config_dir, is_default, created_at)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
  ).run(id, id, `/cfg/${id}/.claude`, isDefault);
}

beforeEach(() => { db = freshDb(); usageStore.clearAllUsage(); });

describe('resolveAccountForGroup', () => {
  test('a group with an account resolves to that account', () => {
    seedAccount('work');
    seedAccount('def', 1);
    db.prepare("INSERT INTO groups (id, claude_account_id) VALUES ('g1', 'work')").run();
    expect(resolveAccountForGroup('g1')?.id).toBe('work');
  });

  test('a group with no account falls back to the default', () => {
    seedAccount('def', 1);
    db.prepare("INSERT INTO groups (id, claude_account_id) VALUES ('g1', NULL)").run();
    expect(resolveAccountForGroup('g1')?.id).toBe('def');
  });

  test('no group falls back to the default', () => {
    seedAccount('def', 1);
    expect(resolveAccountForGroup(null)?.id).toBe('def');
  });

  test('no group and no default resolves to null (ambient)', () => {
    seedAccount('work'); // exists but not default
    expect(resolveAccountForGroup(null)).toBeNull();
  });

  test('the resolved account carries its config dir (what CLAUDE_CONFIG_DIR is set to)', () => {
    seedAccount('def', 1);
    expect(resolveAccountForGroup(null)?.configDir).toBe('/cfg/def/.claude');
  });

  test('a partial DB (no accounts table) falls back to ambient rather than throwing', () => {
    db = new Database(':memory:'); // no tables at all
    expect(resolveAccountForGroup('g1')).toBeNull();
  });
});

describe('health-aware step-aside (CO-722 R1)', () => {
  const FUTURE = '2999-01-01T00:00:00Z';
  function seedLimited(id: string, isDefault: number, untilISO: string) {
    db.prepare(
      `INSERT INTO claude_accounts (id, label, config_dir, is_default, created_at, limited_until)
       VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z', ?)`,
    ).run(id, id, `/cfg/${id}/.claude`, isDefault, untilISO);
  }
  const rank = (id: string, n: number) =>
    db.prepare('UPDATE claude_accounts SET fallback_rank = ? WHERE id = ?').run(n, id);

  test('a rate-limited default steps aside to a healthy fallback account', () => {
    seedLimited('def', 1, FUTURE);
    seedAccount('backup'); // healthy
    rank('def', 0);
    rank('backup', 1);
    // Launching under a spent account just burns a 429; prefer the healthy one.
    expect(resolveAccountForGroup(null)?.id).toBe('backup');
  });

  test('a limited default with no healthy account keeps the default (nothing better)', () => {
    seedLimited('def', 1, FUTURE);
    expect(resolveAccountForGroup(null)?.id).toBe('def');
  });

  test('a healthy default is used even when a limited account also exists', () => {
    seedAccount('def', 1); // healthy
    seedLimited('other', 0, FUTURE);
    expect(resolveAccountForGroup(null)?.id).toBe('def');
  });
});

describe('resolveAccountForGroup near the usage limit', () => {
  test('steps aside from an account over the threshold when one below it exists', () => {
    seedAccount('work', 1);
    seedAccount('spare');
    usageAt('work', 92);
    usageAt('spare', 10);
    expect(resolveAccountForGroup(null)?.id).toBe('spare');
  });

  test('when every account is over, keeps the chosen one as today', () => {
    seedAccount('work', 1);
    seedAccount('spare');
    usageAt('work', 92);
    usageAt('spare', 95);
    expect(resolveAccountForGroup(null)?.id).toBe('work');
  });

  test('an account with no reading is not somewhere to move to', () => {
    seedAccount('work', 1);
    seedAccount('spare');
    usageAt('work', 92);
    expect(resolveAccountForGroup(null)?.id).toBe('work');
  });

  test('a default at 90% keeps a run’s gates when the secondary is signed out', () => {
    seedAccount('work', 1);
    seedAccount('spare');
    usageAt('work', 90);
    usageStore.setUsage({ ...usageStore.getUsage('work')!, accountId: 'spare', fiveHour: { pct: 5, resetsAt: null, observedAt: Date.now() }, unavailable: 'reauth' });
    expect(resolveAccountForGroup(null)?.id).toBe('work');
  });

  test('steps aside from an account holding its token pair in memory, unless nothing has room', () => {
    seedAccount('work', 1);
    seedAccount('spare');
    usageAt('work', 10);
    usageStore.markRotationHeld('work');
    expect(resolveAccountForGroup(null)?.id).toBe('work');
    usageAt('spare', 10);
    expect(resolveAccountForGroup(null)?.id).toBe('spare');
  });

  test('stale readings do not steer', () => {
    seedAccount('work', 1);
    seedAccount('spare');
    usageStore.setUsage({
      accountId: 'work', fiveHour: { pct: 99, resetsAt: null, observedAt: Date.now() - 60 * 60_000 }, sevenDay: null,
      source: 'poll', observedAt: Date.now() - 60 * 60_000, unavailable: null,
    });
    expect(resolveAccountForGroup(null)?.id).toBe('work');
  });
});

describe('resolveAccountForGroup and a group that chose its account', () => {
  function groupOn(id: string, accountId: string) {
    db.prepare('INSERT INTO groups (id, claude_account_id) VALUES (?, ?)').run(id, accountId);
  }

  test('keeps the group’s account under usage pressure', () => {
    seedAccount('work');
    seedAccount('spare', 1);
    groupOn('g', 'work');
    usageAt('work', 95);
    expect(resolveAccountForGroup('g')?.id).toBe('work');
  });

  test('keeps the group’s account while it holds a token pair in memory', () => {
    seedAccount('work');
    seedAccount('spare', 1);
    groupOn('g', 'work');
    usageAt('spare', 10);
    usageStore.markRotationHeld('work');
    expect(resolveAccountForGroup('g')?.id).toBe('work');
  });

  test('still steps aside when that account is rate-limited', () => {
    seedAccount('work');
    seedAccount('spare', 1);
    groupOn('g', 'work');
    db.prepare('UPDATE claude_accounts SET limited_until = ? WHERE id = ?').run(new Date(Date.now() + 3_600_000).toISOString(), 'work');
    expect(resolveAccountForGroup('g')?.id).toBe('spare');
  });
});
