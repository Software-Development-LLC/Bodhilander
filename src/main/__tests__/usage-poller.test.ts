/**
 * The usage poller: what it polls, when it may refresh a token (never one a
 * running CLI owns), and what a failure becomes. Run with: bun test <this file>
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

const { ownedAccountIds, UsagePoller, USAGE_URL, USAGE_POLL_MS } = await import('../usage-poller');
const { OAUTH_TOKEN_URL } = await import('../usage-credentials');
const usageStore = await import('../usage-store');
import type { ClaudeAccount } from '../../shared/types';
import type { FetchLike } from '../usage-credentials';

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
type Call = { url: string; auth?: string; body?: unknown };

function fakeFetch(route: (url: string, call: Call) => Reply): { calls: Call[]; fetch: FetchLike } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined };
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

    expect(calls.map(c => [c.url, c.auth])).toEqual([
      [USAGE_URL, 'Bearer work-access'],
      [USAGE_URL, 'Bearer home-access'],
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

  test('a 401 from the usage endpoint reads as re-auth needed', async () => {
    const work = account('work');
    writeCreds(work, NOW + 3_600_000);
    const { fetch } = fakeFetch(() => ({ status: 401 }));
    await poller([work], fetch).pollAll();
    expect(usageStore.getUsage('work')?.unavailable).toBe('reauth');
  });
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
});

test('a deleted account loses its record', async () => {
  const work = account('work');
  writeCreds(work, NOW + 3_600_000);
  const accounts = [work];
  const { fetch } = fakeFetch(() => ({ status: 200, body: USAGE_BODY }));
  const p = new UsagePoller({ listAccounts: () => accounts, boundAccountIds: () => new Set(), fetch, now: () => clock });
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
