/**
 * startLoginFlow integration tests: legacy-transcript seeding fires for the
 * FIRST account only, and the first-account check stays atomic with account
 * creation (no await between check and insert), so overlapping calls can't
 * both become the default.
 *
 * electron, mcp-config, and the seed helper are stubbed (pty-manager is only
 * a type import); the flow's own fs usage (mkdir, watch) runs against a temp
 * userData dir. The accounts repository runs REAL against an in-memory bun:sqlite
 * standing in for '../database' — the same shape account-switch.test.ts uses.
 * It used to be a hand-rolled array fake, but bun's mock.module patches a
 * specifier for the whole test process, so that fake silently became the
 * subject of repositories/__tests__/accounts.test.ts. Going through the real
 * repository also makes the overlapping-login test mean more: the default flag
 * now has to survive the partial unique index the real schema carries.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PtyManager } from '../pty-manager';

let userDataDir = '';
mock.module('electron', () => ({
  app: { getPath: () => userDataDir },
}));

let db: Database;
mock.module('../database', () => ({
  getDatabase: () => db,
}));

/**
 * Post-migration schema for the tables the login flow can touch. sessions and
 * groups are here because the rollback path (spawn failure → deleteAccount)
 * NULLs their claude_account_id.
 */
function freshDb(): Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE claude_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      config_dir TEXT NOT NULL UNIQUE,
      email TEXT,
      color TEXT DEFAULT '#888888',
      is_default INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT
    );
    CREATE UNIQUE INDEX idx_claude_accounts_single_default
      ON claude_accounts(is_default) WHERE is_default = 1;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      group_id TEXT,
      name TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      claude_account_id TEXT DEFAULT NULL
    );
    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      claude_account_id TEXT DEFAULT NULL
    );
  `);
  return d;
}

// Stubbed so the flow never writes into a real ~/.claude. registerHooks is the
// only registration left now that the memory MCP server is gone; the calls are
// recorded so the tests can assert it targets the new account's isolated
// config dir. The stub covers the module's FULL export shape — a registered
// mock namespace can never gain names it was created without.
const realMcpConfig = { ...(await import('../mcp-config')) };
const hookRegistrations: Array<string | undefined> = [];
mock.module('../mcp-config', () => ({
  registerHooks: (configDir?: string) => {
    hookRegistrations.push(configDir);
    return { success: true, action: 'added' as const };
  },
  cleanupLegacyMcpServer: () => undefined,
  unregisterMcpServer: () => false,
  getHooksStatus: () => ({ configured: false }),
}));

// Seed spy with a controllable delay — a slow copy is exactly what widened
// the old check-then-act window across an await boundary.
const realLegacySeed = { ...(await import('../legacy-claude-seed')) };
const seedCalls: string[] = [];
let seedDelayMs = 0;
mock.module('../legacy-claude-seed', () => ({
  seedLegacyConversations: async (configDir: string) => {
    seedCalls.push(configDir);
    if (seedDelayMs > 0) await new Promise((r) => setTimeout(r, seedDelayMs));
    return true;
  },
}));

// Hand the REAL modules back when this file finishes — mcp-config.test.ts and
// legacy-claude-seed.test.ts drive them for real, and in a shared-registry run
// a stub left registered here would silently become their subject.
afterAll(() => {
  mock.module('../mcp-config', () => realMcpConfig);
  mock.module('../legacy-claude-seed', () => realLegacySeed);
});

const accountAuth = await import('../account-auth');

function fakePtyManager(): PtyManager & { loginSessions: string[] } {
  const stub = {
    loginSessions: [] as string[],
    createLoginSession(id: string) {
      stub.loginSessions.push(id);
    },
    on() {},
    off() {},
    kill() {},
  };
  return stub as unknown as PtyManager & { loginSessions: string[] };
}

/**
 * Registered accounts in creation order. Deliberately not getAllAccounts(),
 * which sorts the default first — that would hide which login was first, and
 * "the first caller is the one that became default" is the property these
 * tests exist to hold.
 */
function storedAccounts(): { id: string; isDefault: boolean }[] {
  return (db.prepare('SELECT id, is_default FROM claude_accounts ORDER BY created_at ASC, rowid ASC')
    .all() as { id: string; is_default: number }[])
    .map((r) => ({ id: r.id, isDefault: Boolean(r.is_default) }));
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-auth-'));
  db = freshDb();
  seedCalls.length = 0;
  hookRegistrations.length = 0;
  seedDelayMs = 0;
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('startLoginFlow legacy seeding', () => {
  test('first account: seeded into its config dir and marked default', async () => {
    const pty = fakePtyManager();
    const { account, ptyId } = await accountAuth.startLoginFlow(pty, null, 'Work');

    expect(seedCalls).toEqual([account.configDir]);
    expect(storedAccounts()).toEqual([{ id: account.id, isDefault: true }]);
    expect(pty.loginSessions).toEqual([ptyId]);
    // Hooks land in the account's isolated config dir, not the global ~/.claude
    // (BDHLNDR-31), and before the login pty spawns.
    expect(hookRegistrations).toEqual([account.configDir]);

    accountAuth.cancelLoginFlow(pty, ptyId, false);
  });

  test('subsequent accounts: no seeding, not default', async () => {
    const pty = fakePtyManager();
    const first = await accountAuth.startLoginFlow(pty, null, 'Work');
    const second = await accountAuth.startLoginFlow(pty, null, 'Personal');

    expect(seedCalls).toEqual([first.account.configDir]);
    expect(storedAccounts()).toEqual([
      { id: first.account.id, isDefault: true },
      { id: second.account.id, isDefault: false },
    ]);
    // Seeding is first-account-only; hook registration is per-account.
    expect(hookRegistrations).toEqual([first.account.configDir, second.account.configDir]);

    accountAuth.cancelLoginFlow(pty, first.ptyId, false);
    accountAuth.cancelLoginFlow(pty, second.ptyId, false);
  });

  test('overlapping calls produce exactly one default and one seed', async () => {
    const pty = fakePtyManager();
    seedDelayMs = 50; // hold the first call inside the seed await

    const [a, b] = await Promise.all([
      accountAuth.startLoginFlow(pty, null, 'One'),
      accountAuth.startLoginFlow(pty, null, 'Two'),
    ]);

    // Naming which account is default, not just counting them: the real
    // repository demotes the incumbent on every isDefault insert, so a widened
    // check-then-act window still yields exactly one default — it just makes it
    // the SECOND login. Only the first caller saw an empty table.
    expect(storedAccounts()).toEqual([
      { id: a.account.id, isDefault: true },
      { id: b.account.id, isDefault: false },
    ]);
    expect(seedCalls.length).toBe(1);

    accountAuth.cancelLoginFlow(pty, a.ptyId, false);
    accountAuth.cancelLoginFlow(pty, b.ptyId, false);
  });
});
