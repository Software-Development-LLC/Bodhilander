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
    kill: () => Promise.resolve(),
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

function storedEmail(id: string): string | null {
  const row = db.prepare('SELECT email FROM claude_accounts WHERE id = ?').get(id) as
    { email: string | null } | undefined;
  return row?.email ?? null;
}

function writeConfigFile(configDir: string, name: string, contents: unknown): void {
  fs.writeFileSync(path.join(configDir, name), JSON.stringify(contents));
}

/**
 * fs.watch delivers asynchronously, so the assertion has to outlast it. This
 * ceiling must stay below the per-test timeout the watch-driven tests declare,
 * or the two race and a real failure reports a bare timeout instead of the
 * message below, which says what was actually being waited on.
 */
const WATCH_TIMEOUT_MS = 15_000;
/** Per-test ceiling for the watch-driven tests; must exceed WATCH_TIMEOUT_MS. */
const WATCH_TEST_TIMEOUT_MS = 20_000;

async function waitFor(predicate: () => boolean, timeoutMs = WATCH_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition was never met');
}

type MainWindow = Parameters<typeof accountAuth.confirmLoginMacOS>[0];

interface SentEvent {
  channel: string;
  data: { accountId: string; email: string | null; verified: boolean };
}

/** Captures what the renderer is told, which is the claim the overlay words. */
function fakeWindow(): { sent: SentEvent[]; win: MainWindow } {
  const sent: SentEvent[] = [];
  const win = {
    webContents: {
      send: (channel: string, data: SentEvent['data']) => { sent.push({ channel, data }); },
    },
  };
  return { sent, win: win as unknown as MainWindow };
}

/**
 * Which writes into the config dir mean "a login landed". The watch used to
 * answer that with the presence of a token file, which a platform holding its
 * tokens in a keyring never writes.
 */
describe('login detection', () => {
  test('a login that writes only a profile completes the flow and takes its email', async () => {
    const pty = fakePtyManager();
    const { account, ptyId } = await accountAuth.startLoginFlow(pty, null, 'Work');

    // What Claude Code leaves in a dir it has started in but nobody has logged
    // into: the file is there, the profile block is not.
    writeConfigFile(account.configDir, '.claude.json', { userID: 'u1', projects: {} });
    await new Promise((r) => setTimeout(r, 150));
    expect(storedEmail(account.id)).toBeNull();

    writeConfigFile(account.configDir, '.claude.json', {
      userID: 'u1',
      oauthAccount: { accountUuid: 'u-1', emailAddress: 'will@acme.test' },
    });
    await waitFor(() => storedEmail(account.id) === 'will@acme.test');

    // And it got there without the artifact the old check demanded.
    expect(fs.existsSync(path.join(account.configDir, '.credentials.json'))).toBe(false);

    accountAuth.cancelLoginFlow(pty, ptyId, false);
  }, WATCH_TEST_TIMEOUT_MS);

  test('a token file appearing still completes the flow', async () => {
    const pty = fakePtyManager();
    const { account, ptyId } = await accountAuth.startLoginFlow(pty, null, 'Work');

    writeConfigFile(account.configDir, '.credentials.json', {
      claudeAiOauth: { accessToken: 'not-a-real-token', subscriptionEmail: 'will@linux.test' },
    });
    await waitFor(() => storedEmail(account.id) === 'will@linux.test');

    accountAuth.cancelLoginFlow(pty, ptyId, false);
  }, WATCH_TEST_TIMEOUT_MS);

  test('the manual confirmation records the email the watch would have', async () => {
    const pty = fakePtyManager();
    const { account, ptyId } = await accountAuth.startLoginFlow(pty, null, 'Work');

    writeConfigFile(account.configDir, '.claude.json', {
      oauthAccount: { accountUuid: 'u-1', emailAddress: 'will@acme.test' },
    });
    accountAuth.confirmLoginMacOS(null, ptyId);

    expect(storedEmail(account.id)).toBe('will@acme.test');
    accountAuth.cancelLoginFlow(pty, ptyId, false);
  });

  test('confirming with nothing on disk keeps the account rather than inventing an email', async () => {
    const pty = fakePtyManager();
    const { account, ptyId } = await accountAuth.startLoginFlow(pty, null, 'Work');

    accountAuth.confirmLoginMacOS(null, ptyId);

    expect(storedEmail(account.id)).toBeNull();
    expect(storedAccounts()).toEqual([{ id: account.id, isDefault: true }]);
    accountAuth.cancelLoginFlow(pty, ptyId, false);
  });

  // The button can be pressed before OAuth finishes. Main writes no address in
  // that case, so it must not let the overlay say the account is signed in
  // while the panel behind it reads the same empty dir and says otherwise.
  test('a confirmation main could not corroborate is reported as unverified', async () => {
    const pty = fakePtyManager();
    const { win, sent } = fakeWindow();
    const { ptyId } = await accountAuth.startLoginFlow(pty, win, 'Work');

    accountAuth.confirmLoginMacOS(win, ptyId);

    const completed = sent.filter((e) => e.channel === 'accounts:login-completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].data.verified).toBe(false);
    expect(completed[0].data.email).toBeNull();
    accountAuth.cancelLoginFlow(pty, ptyId, false);
  });

  test('a login main found on disk is reported verified, with its email', async () => {
    const pty = fakePtyManager();
    const { win, sent } = fakeWindow();
    const { account, ptyId } = await accountAuth.startLoginFlow(pty, win, 'Work');

    writeConfigFile(account.configDir, '.claude.json', {
      oauthAccount: { accountUuid: 'u-1', emailAddress: 'will@acme.test' },
    });
    accountAuth.confirmLoginMacOS(win, ptyId);

    const completed = sent.filter((e) => e.channel === 'accounts:login-completed');
    expect(completed[0].data.verified).toBe(true);
    expect(completed[0].data.email).toBe('will@acme.test');
    accountAuth.cancelLoginFlow(pty, ptyId, false);
  });
});

describe('cancelLoginFlow', () => {
  test('a rejecting kill is swallowed and cleanup still runs to completion', async () => {
    const pty = fakePtyManager();
    let kills = 0;
    pty.kill = () => {
      kills++;
      return Promise.reject(new Error('teardown glitched'));
    };
    const { ptyId } = await accountAuth.startLoginFlow(pty, null, 'Doomed');

    const escaped: unknown[] = [];
    const onUnhandled = (err: unknown) => { escaped.push(err); };
    process.on('unhandledRejection', onUnhandled);
    try {
      accountAuth.cancelLoginFlow(pty, ptyId, true);
      // Give a floating rejection an event-loop turn to surface.
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(escaped).toEqual([]);
    expect(kills).toBe(1);
    // The abort rollback ran past the failed kill: the account row is gone.
    expect(storedAccounts()).toEqual([]);
    // And so is the flow itself — a second cancel is a no-op, not a re-kill.
    accountAuth.cancelLoginFlow(pty, ptyId, true);
    expect(kills).toBe(1);
  });
});
