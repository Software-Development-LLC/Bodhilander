/**
 * The usage meters as the app wires them: token ownership, the sink following
 * its preference, and where readings and notices go. Run with: bun test <this file>
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const prefs = new Map<string, string>();
mock.module('../repositories/preferences', () => ({
  getPreference: (key: string) => prefs.get(key) ?? null,
  setPreference: (key: string, value: string) => { prefs.set(key, value); },
  deletePreference: (key: string) => { prefs.delete(key); },
}));

const { createUsageService, tokenOwnedAccountIds } = await import('../usage-service');
const usageStore = await import('../usage-store');
import type { ClaudeAccount } from '../../shared/types';
import type { CredentialStore } from '../credential-store';
import type { FetchLike } from '../usage-credentials';
import type { UsageServiceDeps } from '../usage-service';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const SINK = { scriptPath: '/opt/b/dist/hooks/bodhilander-statusline.js', execPath: '/opt/b/Bodhilander', platform: 'darwin' as const };

let root: string;
let accounts: ClaudeAccount[];

const credentials: CredentialStore = {
  missing: 'no-credentials',
  read: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3_600_000, scopes: [] }),
  writeRotated: async () => true,
};

const fetchAt = (pct: number): FetchLike => async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ five_hour: { utilization: pct, resets_at: null }, seven_day: null }),
});

const noOwnership = {
  candidate: () => null, resolved: () => null, launchedDirs: () => [], accountIdForDir: () => null,
};

function deps(overrides: Partial<UsageServiceDeps> = {}): UsageServiceDeps {
  return {
    listAccounts: () => accounts,
    getPreference: key => prefs.get(key) ?? null,
    liveAccounts: () => ({}),
    activeRuns: () => [],
    ownership: noOwnership,
    fetch: fetchAt(10),
    credentials,
    sink: SINK,
    publish: () => undefined,
    notify: () => undefined,
    now: () => NOW,
    watchSinks: false,
    ...overrides,
  };
}

const statusLine = (acc: ClaudeAccount) =>
  JSON.parse(fs.readFileSync(path.join(acc.configDir, 'settings.json'), 'utf-8')).statusLine;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-usage-svc-'));
  accounts = ['work', 'home'].map(id => {
    const configDir = path.join(root, id);
    fs.mkdirSync(configDir);
    return { id, label: id, configDir } as ClaudeAccount;
  });
  prefs.clear();
  usageStore.clearAllUsage();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('tokenOwnedAccountIds', () => {
  test('counts live ptys and the accounts active runs hold', () => {
    const owned = tokenOwnedAccountIds({
      liveAccounts: () => ({ p1: { accountId: 'work', configDir: '/cfg/work' } }),
      activeRuns: () => [{ id: 'r1', groupId: 'g' }],
      ownership: { ...noOwnership, candidate: () => 'home' },
    });
    expect([...owned].sort()).toEqual(['home', 'work']);
  });

  test('a failed run listing still counts the live ptys', () => {
    const owned = tokenOwnedAccountIds({
      liveAccounts: () => ({ p1: { accountId: 'work', configDir: '/cfg/work' } }),
      activeRuns: () => { throw new Error('no such table: runs'); },
      ownership: noOwnership,
    });
    expect([...owned]).toEqual(['work']);
  });
});

describe('the sink follows its preference', () => {
  test('a round installs the sink in every account', async () => {
    await createUsageService(deps()).poller.pollAll();
    for (const acc of accounts) expect(statusLine(acc).command).toContain('ELECTRON_RUN_AS_NODE=1');
  });

  test('turning the preference off takes it out everywhere; another key touches nothing', async () => {
    const service = createUsageService(deps());
    await service.poller.pollAll();
    prefs.set('usageStatuslineSink', 'false');
    service.preferenceChanged('usageWarnThreshold');
    expect(statusLine(accounts[0])).toBeDefined();
    service.preferenceChanged('usageStatuslineSink');
    for (const acc of accounts) expect(statusLine(acc)).toBeUndefined();
  });

  test('a build without the script installs nothing', async () => {
    await createUsageService(deps({ sink: null })).poller.pollAll();
    expect(fs.existsSync(path.join(accounts[0].configDir, 'settings.json'))).toBe(false);
  });
});

describe('where readings go', () => {
  test('each round is published, and a crossing becomes one notice', async () => {
    const published: string[][] = [];
    const notices: { title: string; body: string }[] = [];
    const service = createUsageService(deps({
      listAccounts: () => [accounts[0]],
      fetch: fetchAt(92),
      publish: usage => published.push(Object.keys(usage)),
      notify: (title, body) => notices.push({ title, body }),
    }));
    await service.poller.pollAll();
    await service.poller.pollAll();
    expect(published).toEqual([['work'], ['work']]);
    expect(notices).toEqual([{ title: 'work is near its usage limit', body: 'work is at 92% of its 5-hour limit' }]);
  });

  test('a CLI-owned account is not refreshed by the service’s poller', async () => {
    let refreshed = 0;
    const expired: CredentialStore = {
      ...credentials,
      read: async () => ({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW - 1000, scopes: [] }),
      writeRotated: async () => { refreshed++; return true; },
    };
    const service = createUsageService(deps({
      credentials: expired,
      liveAccounts: () => ({ p1: { accountId: 'work', configDir: accounts[0].configDir } }),
      listAccounts: () => [accounts[0]],
    }));
    await service.poller.pollAll();
    expect(refreshed).toBe(0);
  });
});
