/**
 * The usage poller: what it polls, when it may refresh a token (never one a
 * running CLI owns), and what a failure becomes. Run with: bun test <this file>
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const prefs = new Map<string, string>();
const prefReads: string[] = [];
mock.module('../repositories/preferences', () => ({
  getPreference: (key: string) => {
    prefReads.push(key);
    return prefs.get(key) ?? null;
  },
  setPreference: (key: string, value: string) => { prefs.set(key, value); },
  deletePreference: (key: string) => { prefs.delete(key); },
}));

const { ownedAccountIds, runAccountIdsForOwnership, UsagePoller, USAGE_URL, USAGE_POLL_MS } = await import('../usage-poller');
const { OAUTH_TOKEN_URL } = await import('../usage-credentials');
const { credentialStoreFor, fileCredentialStore, keychainService } = await import('../credential-store');
const { isTokenRefreshing, tokenRefreshSettled } = await import('../token-refresh');
const usageStore = await import('../usage-store');
import type { ClaudeAccount } from '../../shared/types';
import type { FetchLike } from '../usage-credentials';
import type { SecurityExec } from '../credential-store';

const NOW = Date.parse('2026-09-30T12:00:00Z');
let root: string;
let clock: number;

function account(id: string): ClaudeAccount {
  const configDir = path.join(root, id);
  fs.mkdirSync(configDir, { recursive: true });
  return { id, label: id, configDir } as ClaudeAccount;
}

function writeCreds(acc: ClaudeAccount, expiresAt: number): void {
  fs.writeFileSync(path.join(acc.configDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: `${acc.id}-access`, refreshToken: `${acc.id}-refresh`, expiresAt, scopes: ['user:inference'], subscriptionType: 'max' },
  }));
}

interface Reply { status: number; body?: unknown; retryAfter?: string }
type Call = { url: string; auth?: string; beta?: string; body?: unknown };

function fakeFetch(route: (url: string, call: Call) => Reply): { calls: Call[]; fetch: FetchLike } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      auth: init.headers.Authorization,
      beta: init.headers['anthropic-beta'],
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = route(url, call);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name: string) => (name === 'retry-after' ? reply.retryAfter ?? null : null) },
      json: async () => reply.body,
    };
  };
  return { calls, fetch };
}

const USAGE_BODY = {
  five_hour: { utilization: 42, resets_at: '2026-09-30T14:00:00Z' },
  seven_day: { utilization: 12, resets_at: '2026-10-04T00:00:00Z' },
};

function poller(accounts: ClaudeAccount[], fetch: FetchLike, bound: string[] = []) {
  return new UsagePoller({
    listAccounts: () => accounts,
    boundAccountIds: () => new Set(bound),
    fetch,
    credentials: fileCredentialStore,
    now: () => clock,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-usage-'));
  clock = NOW;
  prefs.clear();
  usageStore.clearAllUsage();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('polling', () => {
  test('polls every account, with or without a session, using its own token', async () => {
    const work = account('work');
    const home = account('home');
    writeCreds(work, NOW + 3_600_000);
    writeCreds(home, NOW + 3_600_000);
    const { calls, fetch } = fakeFetch(() => ({ status: 200, body: USAGE_BODY }));
    await poller([work, home], fetch).pollAll();

    expect(calls.map(c => [c.url, c.auth, c.beta])).toEqual([
      [USAGE_URL, 'Bearer work-access', 'oauth-2025-04-20'],
      [USAGE_URL, 'Bearer home-access', 'oauth-2025-04-20'],
    ]);
    expect(usageStore.getUsage('home')).toMatchObject({
      fiveHour: { pct: 42, resetsAt: Date.parse('2026-09-30T14:00:00Z') },
      sevenDay: { pct: 12 },
      source: 'poll',
      observedAt: NOW,
      unavailable: null,
    });
  });

  test('an unrecognised body is "usage unavailable", never 0%', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { fetch } = fakeFetch(() => ({ status: 200, body: { five_hour: { pct: 0 } } }));
    await poller([work], fetch).pollAll();
    expect(usageStore.getUsage('work')).toMatchObject({ fiveHour: null, sevenDay: null, unavailable: 'error' });
    expect(usageStore.isUsagePressured('work', new Date(NOW))).toBe(false);
  });

  test('no token file reads as unavailable, without a request', async () => {
    const work = account('work');
    const { calls, fetch } = fakeFetch(() => ({ status: 200, body: USAGE_BODY }));
    await poller([work], fetch).pollAll();
    expect(calls).toHaveLength(0);
    expect(usageStore.getUsage('work')?.unavailable).toBe('no-credentials');
  });

  test('a 429 backs off instead of retrying on the next round', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { calls, fetch } = fakeFetch(() => ({ status: 429 }));
    const p = poller([work], fetch);
    await p.pollAll();
    await p.pollAll();
    expect(calls).toHaveLength(1);
    clock += USAGE_POLL_MS + 1;
    await p.pollAll();
    expect(calls).toHaveLength(2);
    clock += USAGE_POLL_MS + 1;
    await p.pollAll();
    expect(calls).toHaveLength(2);
  });

  test('a Retry-After longer than the backoff is honoured', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { calls, fetch } = fakeFetch(() => ({ status: 503, retryAfter: '1200' }));
    const p = poller([work], fetch);
    await p.pollAll();
    clock += 15 * 60_000;
    await p.pollAll();
    expect(calls).toHaveLength(1);
    clock += 6 * 60_000;
    await p.pollAll();
    expect(calls).toHaveLength(2);
  });

  test('refreshNow skips an account polled moments ago', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { calls, fetch } = fakeFetch(() => ({ status: 200, body: USAGE_BODY }));
    const p = poller([work], fetch);
    await p.pollAll();
    clock += 5_000;
    await p.refreshNow();
    expect(calls).toHaveLength(1);
  });
});

describe('expired tokens', () => {
  test('an idle account is refreshed, saved, then polled with the new token', async () => {
    const work = account('work');
    writeCreds(work, NOW - 1000);
    const { calls, fetch } = fakeFetch((url) => (url === OAUTH_TOKEN_URL
      ? { status: 200, body: { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 28_800 } }
      : { status: 200, body: USAGE_BODY }));
    await poller([work], fetch).pollAll();

    expect(calls.map(c => c.url)).toEqual([OAUTH_TOKEN_URL, USAGE_URL]);
    expect(calls[1].auth).toBe('Bearer fresh-access');
    const saved = JSON.parse(fs.readFileSync(path.join(work.configDir, '.credentials.json'), 'utf-8')).claudeAiOauth;
    expect(saved).toMatchObject({
      accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresAt: NOW + 28_800_000, subscriptionType: 'max',
    });
    expect(usageStore.getUsage('work')?.fiveHour?.pct).toBe(42);
  });

  test('an account a running CLI is bound to is never refreshed', async () => {
    const work = account('work');
    writeCreds(work, NOW - 1000);
    const before = fs.readFileSync(path.join(work.configDir, '.credentials.json'), 'utf-8');
    const { calls, fetch } = fakeFetch(() => ({ status: 200, body: {} }));
    await poller([work], fetch, ['work']).pollAll();
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(work.configDir, '.credentials.json'), 'utf-8')).toBe(before);
  });

  test('a bound account is polled with whatever token the CLI last wrote', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { calls, fetch } = fakeFetch(() => ({ status: 200, body: USAGE_BODY }));
    await poller([work], fetch, ['work']).pollAll();
    expect(calls.map(c => c.url)).toEqual([USAGE_URL]);
  });

  test('a failed refresh reads as re-auth needed and leaves the file alone', async () => {
    const work = account('work');
    writeCreds(work, NOW - 1000);
    const before = fs.readFileSync(path.join(work.configDir, '.credentials.json'), 'utf-8');
    const { calls, fetch } = fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    await poller([work], fetch).pollAll();
    expect(calls.map(c => c.url)).toEqual([OAUTH_TOKEN_URL]);
    expect(usageStore.getUsage('work')?.unavailable).toBe('reauth');
    expect(fs.readFileSync(path.join(work.configDir, '.credentials.json'), 'utf-8')).toBe(before);
  });

  test('a 401 on a clock-valid token is refreshed once, then asked again', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { calls, fetch } = fakeFetch((url, call) => {
      if (url === OAUTH_TOKEN_URL) return { status: 200, body: { access_token: 'fresh-access', expires_in: 28_800 } };
      return call.auth === 'Bearer fresh-access' ? { status: 200, body: USAGE_BODY } : { status: 401 };
    });
    await poller([work], fetch).pollAll();
    expect(calls.map(c => c.url)).toEqual([USAGE_URL, OAUTH_TOKEN_URL, USAGE_URL]);
    expect(usageStore.getUsage('work')).toMatchObject({ unavailable: null, fiveHour: { pct: 42 } });
  });

  test('a 401 on a token with no expiry is refreshed too', async () => {
    const work = account('work');
    fs.writeFileSync(path.join(work.configDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'work-access', refreshToken: 'work-refresh', scopes: ['user:inference'] },
    }));
    const { calls, fetch } = fakeFetch((url) => (url === OAUTH_TOKEN_URL
      ? { status: 200, body: { access_token: 'fresh-access', expires_in: 28_800 } }
      : { status: 401 }));
    await poller([work], fetch).pollAll();
    expect(calls.map(c => c.url)).toEqual([USAGE_URL, OAUTH_TOKEN_URL, USAGE_URL]);
    expect(usageStore.getUsage('work')?.unavailable).toBe('reauth');
  });

  test('a 401 whose refresh fails reads as re-auth needed', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { fetch } = fakeFetch((url) => (url === OAUTH_TOKEN_URL ? { status: 400 } : { status: 401 }));
    await poller([work], fetch).pollAll();
    expect(usageStore.getUsage('work')?.unavailable).toBe('reauth');
  });

  test('a 401 on an account a CLI owns is not refreshed', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { calls, fetch } = fakeFetch(() => ({ status: 401 }));
    await poller([work], fetch, ['work']).pollAll();
    expect(calls.map(c => c.url)).toEqual([USAGE_URL]);
    expect(usageStore.getUsage('work')?.unavailable).toBe('reauth');
  });

  test('an account a CLI binds to during the usage request is not refreshed on its 401', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const bound = new Set<string>();
    const { calls, fetch } = fakeFetch(() => {
      bound.add('work');
      return { status: 401 };
    });
    await new UsagePoller({
      listAccounts: () => [work], boundAccountIds: () => bound, fetch, credentials: fileCredentialStore, now: () => clock,
    }).pollAll();
    expect(calls.map(c => c.url)).toEqual([USAGE_URL]);
  });

  test('a launch waiting on the account sees the refresh finish first', async () => {
    const work = account('work');
    writeCreds(work, NOW - 1000);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { fetch } = fakeFetch((url) => (url === OAUTH_TOKEN_URL
      ? { status: 200, body: { access_token: 'fresh-access', expires_in: 28_800 } }
      : { status: 200, body: USAGE_BODY }));
    let started: () => void = () => undefined;
    const refreshing = new Promise<void>(resolve => { started = resolve; });
    const slowFetch: FetchLike = async (url, init) => {
      if (url === OAUTH_TOKEN_URL) {
        started();
        await gate;
      }
      return fetch(url, init);
    };
    const round = poller([work], slowFetch).pollAll();
    await refreshing;
    let settled = false;
    const waiting = tokenRefreshSettled(work.configDir).then(() => { settled = true; });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    release();
    await waiting;
    const saved = JSON.parse(fs.readFileSync(path.join(work.configDir, '.credentials.json'), 'utf-8')).claudeAiOauth;
    expect(saved.accessToken).toBe('fresh-access');
    await round;
  });
});

test('no tokens reads as unavailable with the store’s own reason', async () => {
  const work = account('work');
  const { calls, fetch } = fakeFetch(() => ({ status: 200, body: USAGE_BODY }));
  const keychain = { ...fileCredentialStore, read: async () => 'no-keychain-credentials' as const };
  await new UsagePoller({
    listAccounts: () => [work], boundAccountIds: () => new Set(), fetch, credentials: keychain, now: () => clock,
  }).pollAll();
  expect(calls).toHaveLength(0);
  expect(usageStore.getUsage('work')?.unavailable).toBe('no-keychain-credentials');
});

describe('the statusline sink', () => {
  test('a sink reading newer than the poll wins', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { fetch } = fakeFetch(() => ({ status: 200, body: USAGE_BODY }));
    const p = poller([work], fetch);
    await p.pollAll();
    fs.writeFileSync(path.join(work.configDir, 'bodhilander-usage.json'), JSON.stringify({
      observedAt: NOW + 60_000,
      rate_limits: { five_hour: { used_percentage: 77, resets_at: Math.floor(NOW / 1000) + 3600 } },
    }));
    expect(p.ingestSinkFile(work)).toBe(true);
    expect(usageStore.getUsage('work')).toMatchObject({
      fiveHour: { pct: 77 }, sevenDay: { pct: 12 }, source: 'statusline', observedAt: NOW + 60_000,
    });
  });

  test('a sink file with nothing usable changes nothing', () => {
    const work = account('work');
    fs.writeFileSync(path.join(work.configDir, 'bodhilander-usage.json'), '{"observedAt":1}');
    expect(poller([work], fakeFetch(() => ({ status: 200 })).fetch).ingestSinkFile(work)).toBe(false);
    expect(usageStore.getUsage('work')).toBeNull();
  });
});

describe('threshold notices', () => {
  test('crossing fires one notice per window, across rounds', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { fetch } = fakeFetch(() => ({ status: 200, body: { ...USAGE_BODY, five_hour: { utilization: 92, resets_at: '2026-09-30T12:40:00Z' } } }));
    const p = poller([work], fetch);
    const seen: string[] = [];
    p.on('crossing', ({ account: acc, crossing }) => seen.push(`${acc.id}:${crossing.window}:${crossing.pct}`));
    await p.pollAll();
    clock += USAGE_POLL_MS;
    await p.pollAll();
    expect(seen).toEqual(['work:fiveHour:92']);
  });

  test('the threshold preference decides what counts as crossing', async () => {
    prefs.set('usageWarnThreshold', '40');
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { fetch } = fakeFetch(() => ({ status: 200, body: USAGE_BODY }));
    const p = poller([work], fetch);
    const seen: string[] = [];
    p.on('crossing', ({ crossing }) => seen.push(crossing.window));
    await p.pollAll();
    expect(seen).toEqual(['fiveHour']);
    expect(usageStore.isUsagePressured('work', new Date(NOW))).toBe(true);
  });

  test('a round reads the threshold once, however many accounts it polls', async () => {
    const accounts = ['a', 'b', 'c'].map(account);
    for (const acc of accounts) writeCreds(acc, NOW + 3_600_000);
    const { fetch } = fakeFetch(() => ({ status: 200, body: USAGE_BODY }));
    prefReads.length = 0;
    await poller(accounts, fetch).pollAll();
    expect(prefReads.filter(key => key === 'usageWarnThreshold')).toHaveLength(1);
  });
});

test('a deleted account loses its record', async () => {
  const work = account('work');
  writeCreds(work, NOW + 3_600_000);
  const accounts = [work];
  const { fetch } = fakeFetch(() => ({ status: 200, body: USAGE_BODY }));
  const p = new UsagePoller({
    listAccounts: () => accounts, boundAccountIds: () => new Set(), fetch, credentials: fileCredentialStore, now: () => clock,
  });
  await p.pollAll();
  accounts.length = 0;
  await p.pollAll();
  expect(usageStore.getUsage('work')).toBeNull();
});

test('a token is owned by a live pty or an active run, never by a legacy login', () => {
  const owned = ownedAccountIds({
    s1: { accountId: 'work', configDir: '/w', spawnedAt: 0 },
    s2: { accountId: null, configDir: '/legacy', spawnedAt: 0 },
  }, ['gates', null]);
  expect([...owned].sort()).toEqual(['gates', 'work']);
});

describe('runAccountIdsForOwnership', () => {
  const dirs: Record<string, string> = { '/cfg/a': 'a', '/cfg/b': 'b', '/cfg/c': 'c' };

  test('a gate launched on A still owns A after routing moves the run to B', () => {
    const ids = runAccountIdsForOwnership([{ id: 'r1', groupId: 'g' }], {
      candidate: () => 'b',
      resolved: () => 'c',
      launchedDirs: () => ['/cfg/a'],
      accountIdForDir: dir => dirs[dir] ?? null,
    });
    expect([...ownedAccountIds({}, ids)].sort()).toEqual(['a', 'b', 'c']);
  });

  test('without a launch record the group account is still owned', () => {
    const ids = runAccountIdsForOwnership([{ id: 'r1', groupId: 'g' }], {
      candidate: () => 'a',
      resolved: () => 'b',
      launchedDirs: () => [],
      accountIdForDir: () => null,
    });
    expect(ids).toContain('a');
  });

  test('launch records are asked for by active run id', () => {
    const asked: string[][] = [];
    runAccountIdsForOwnership([{ id: 'r1', groupId: null }, { id: 'r2', groupId: 'g' }], {
      candidate: () => null,
      resolved: () => null,
      launchedDirs: ids => { asked.push(ids); return []; },
      accountIdForDir: () => null,
    });
    expect(asked).toEqual([['r1', 'r2']]);
  });
});

test('a token expired under a gate still running on it is not refreshed', async () => {
  const gateAccount = account('a');
  writeCreds(gateAccount, NOW - 1000);
  const owned = ownedAccountIds({}, runAccountIdsForOwnership([{ id: 'r1', groupId: 'g' }], {
    candidate: () => 'a',
    resolved: () => 'b',
    launchedDirs: () => [gateAccount.configDir],
    accountIdForDir: dir => (dir === gateAccount.configDir ? 'a' : null),
  }));
  const { calls, fetch } = fakeFetch(() => ({ status: 200, body: {} }));
  await poller([gateAccount], fetch, [...owned]).pollAll();
  expect(calls).toHaveLength(0);
});

describe('a rotation the Keychain will not take', () => {
  const FRESH = { status: 200, body: { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 28_800 } };
  const route = (url: string) => (url === OAUTH_TOKEN_URL ? FRESH : { status: 200, body: USAGE_BODY });

  /** A fake `security` over one item; `findCode` and `writeCode` fail its reads and writes on demand. */
  function keychain(acc: ClaudeAccount) {
    const service = keychainService(acc.configDir);
    const state = { findCode: 0, writeCode: 0, items: new Map<string, string>() };
    state.items.set(service, JSON.stringify({
      claudeAiOauth: { accessToken: 'work-access', refreshToken: 'work-refresh', expiresAt: NOW - 1000, scopes: ['user:inference'] },
    }));
    const exec: SecurityExec = async (args, input) => {
      if (args[0] === 'find-generic-password') {
        const secret = state.items.get(service);
        if (state.findCode !== 0) return { code: state.findCode, stdout: '' };
        return secret === undefined ? { code: 44, stdout: '' } : { code: 0, stdout: secret };
      }
      if (state.writeCode !== 0) return { code: state.writeCode, stdout: '' };
      const hex = /-X "([0-9a-f]+)"/.exec(input ?? '')![1];
      state.items.set(service, Buffer.from(hex, 'hex').toString('utf-8'));
      return { code: 0, stdout: '' };
    };
    const saved = () => JSON.parse(state.items.get(service)!).claudeAiOauth;
    return { state, saved, store: credentialStoreFor('darwin', exec) };
  }

  function keychainPoller(acc: ClaudeAccount, fetch: FetchLike, store: ReturnType<typeof credentialStoreFor>) {
    return new UsagePoller({
      listAccounts: () => [acc], boundAccountIds: () => new Set(), fetch, credentials: store, now: () => clock,
    });
  }

  const nextRound = () => { clock += USAGE_POLL_MS; };

  test('a Keychain locked at write time sends nothing to the token file', async () => {
    const work = account('work');
    writeCreds(work, NOW - 1000);
    const before = fs.readFileSync(path.join(work.configDir, '.credentials.json'), 'utf-8');
    const kc = keychain(work);
    const { fetch } = fakeFetch(url => {
      if (url === OAUTH_TOKEN_URL) kc.state.findCode = 36;
      return route(url);
    });
    const p = keychainPoller(work, fetch, kc.store);
    await p.pollAll();

    expect(fs.readFileSync(path.join(work.configDir, '.credentials.json'), 'utf-8')).toBe(before);
    expect(kc.saved().refreshToken).toBe('work-refresh');
    expect(usageStore.getUsage('work')?.unavailable).toBe('keychain-unavailable');
    expect(usageStore.isUnreachable('work')).toBe(true);
    expect(usageStore.isSignedOut('work')).toBe(false);

    nextRound();
    await p.pollAll();
    kc.state.findCode = 0;
    nextRound();
    await p.pollAll();
    expect(kc.saved()).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
    expect(fs.readFileSync(path.join(work.configDir, '.credentials.json'), 'utf-8')).toBe(before);
  });

  test('a refused write is retried on later polls, and the spent token is never refreshed again', async () => {
    const work = account('work');
    const kc = keychain(work);
    kc.state.writeCode = 1;
    const { calls, fetch } = fakeFetch(route);
    const p = keychainPoller(work, fetch, kc.store);
    await p.pollAll();
    expect(usageStore.getUsage('work')?.unavailable).toBe('keychain-unavailable');

    nextRound();
    await p.pollAll();
    expect(calls.map(c => c.url)).toEqual([OAUTH_TOKEN_URL]);
    expect(usageStore.getUsage('work')?.unavailable).toBe('keychain-unavailable');

    kc.state.writeCode = 0;
    nextRound();
    await p.pollAll();
    expect(kc.saved()).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
    expect(calls.map(c => c.url)).toEqual([OAUTH_TOKEN_URL, USAGE_URL]);
    expect(calls[1].auth).toBe('Bearer fresh-access');
    expect(usageStore.getUsage('work')).toMatchObject({ unavailable: null, fiveHour: { pct: 42 } });
    expect(isTokenRefreshing(work.configDir)).toBe(false);
  });

  test('a token file read is rotated back into the token file', async () => {
    const work = account('work');
    writeCreds(work, NOW - 1000);
    const kc = keychain(work);
    kc.state.items.clear();
    const { calls, fetch } = fakeFetch(route);
    await keychainPoller(work, fetch, kc.store).pollAll();

    const saved = JSON.parse(fs.readFileSync(path.join(work.configDir, '.credentials.json'), 'utf-8')).claudeAiOauth;
    expect(saved).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh', subscriptionType: 'max' });
    expect(kc.state.items.size).toBe(0);
    expect(calls.map(c => c.url)).toEqual([OAUTH_TOKEN_URL, USAGE_URL]);
  });

  test('a launch on the account makes one save attempt before the CLI reads the Keychain', async () => {
    const work = account('work');
    const kc = keychain(work);
    kc.state.writeCode = 1;
    const { calls, fetch } = fakeFetch(route);
    await keychainPoller(work, fetch, kc.store).pollAll();
    expect(isTokenRefreshing(work.configDir)).toBe(true);

    await tokenRefreshSettled(work.configDir);
    expect(kc.saved().refreshToken).toBe('work-refresh');

    kc.state.writeCode = 0;
    await tokenRefreshSettled(work.configDir);
    expect(kc.saved()).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
    expect(isTokenRefreshing(work.configDir)).toBe(false);
    expect(calls.map(c => c.url)).toEqual([OAUTH_TOKEN_URL]);
  });

  test('a sign-in made while a pair is held is not overwritten by it', async () => {
    const work = account('work');
    const kc = keychain(work);
    kc.state.writeCode = 1;
    const { fetch } = fakeFetch(route);
    const p = keychainPoller(work, fetch, kc.store);
    await p.pollAll();

    kc.state.writeCode = 0;
    const service = keychainService(work.configDir);
    kc.state.items.set(service, JSON.stringify({
      claudeAiOauth: { accessToken: 'login-access', refreshToken: 'login-refresh', expiresAt: NOW + 3_600_000, scopes: [] },
    }));
    nextRound();
    await p.pollAll();
    expect(kc.saved()).toMatchObject({ accessToken: 'login-access', refreshToken: 'login-refresh' });
    expect(isTokenRefreshing(work.configDir)).toBe(false);
  });
});
