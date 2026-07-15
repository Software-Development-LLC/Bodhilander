/**
 * startLoginFlow integration tests: legacy-transcript seeding fires for the
 * FIRST account only, and the first-account check stays atomic with account
 * creation (no await between check and insert), so overlapping calls can't
 * both become the default.
 *
 * electron, the accounts repo (better-sqlite3), mcp-config, pty-manager
 * (node-pty), and the seed helper are all stubbed; the flow's own fs usage
 * (mkdir, watch) runs against a temp userData dir.
 *
 * Run with: bun test src/main/__tests__
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PtyManager } from '../pty-manager';

let userDataDir = '';
mock.module('electron', () => ({
  app: { getPath: () => userDataDir },
  BrowserWindow: class {},
}));

interface AccountRow {
  id: string;
  label: string;
  configDir: string;
  isDefault: boolean;
}
const accounts: AccountRow[] = [];
mock.module('../repositories/accounts', () => ({
  getAllAccounts: () => [...accounts],
  createAccount: (a: AccountRow) => {
    accounts.push(a);
    return { ...a, email: null, createdAt: new Date() };
  },
  updateAccount: () => undefined,
  deleteAccount: (id: string) => {
    const i = accounts.findIndex((a) => a.id === id);
    if (i >= 0) accounts.splice(i, 1);
  },
  getAccount: (id: string) => accounts.find((a) => a.id === id) ?? null,
}));

mock.module('../mcp-config', () => ({
  registerMcpServer: () => undefined,
  registerHooks: () => undefined,
}));

// Seed spy with a controllable delay — a slow copy is exactly what widened
// the old check-then-act window across an await boundary.
const seedCalls: string[] = [];
let seedDelayMs = 0;
mock.module('../legacy-claude-seed', () => ({
  seedLegacyConversations: async (configDir: string) => {
    seedCalls.push(configDir);
    if (seedDelayMs > 0) await new Promise((r) => setTimeout(r, seedDelayMs));
    return true;
  },
}));

// Keep node-pty out of the test process; the flow only calls methods on the
// instance we pass in.
mock.module('../pty-manager', () => ({ PtyManager: class {} }));

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

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-auth-'));
  accounts.length = 0;
  seedCalls.length = 0;
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
    expect(accounts.length).toBe(1);
    expect(accounts[0].isDefault).toBe(true);
    expect(pty.loginSessions).toEqual([ptyId]);

    accountAuth.cancelLoginFlow(pty, ptyId, false);
  });

  test('subsequent accounts: no seeding, not default', async () => {
    const pty = fakePtyManager();
    const first = await accountAuth.startLoginFlow(pty, null, 'Work');
    const second = await accountAuth.startLoginFlow(pty, null, 'Personal');

    expect(seedCalls).toEqual([first.account.configDir]);
    expect(accounts.map((a) => a.isDefault)).toEqual([true, false]);

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

    expect(accounts.length).toBe(2);
    expect(accounts.filter((acc) => acc.isDefault).length).toBe(1);
    expect(seedCalls.length).toBe(1);

    accountAuth.cancelLoginFlow(pty, a.ptyId, false);
    accountAuth.cancelLoginFlow(pty, b.ptyId, false);
  });
});
