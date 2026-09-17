/**
 * Central orchestration config tests (board-driven orchestration, Phase 2).
 *
 * Two seams: `parseConfig` (pure validation/normalization) and `loadConfig`
 * (fetch + TTL cache + fallback), with `gh`, cache and clock injected so no real
 * `gh`, DB or wall clock is in the room. The branches that matter: a malformed
 * file is a LOUD problem (never served stale over a bug), while a transient
 * fetch failure falls back to the last good cache marked stale.
 *
 * Run with: bun test src/main/github/__tests__/orchestration-config.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { parseConfig, loadConfig, configFetchArgv, type ConfigDeps } from '../orchestration-config';
import type { CommandResult } from '../../run-engine/reconcile';
import type { OrchestrationConfig } from '../../../shared/types';

const validRaw = JSON.stringify({
  version: 1,
  repos: {
    'bodhi-code': { keyPrefix: 'CO', integrationBranch: 'development', provision: 'bun install', ownerAgent: 'bodhi-code-lead', context: 'core' },
    'bodhi-service-ml': { keyPrefix: 'BSML', junk: 'ignored' },
  },
  owners: { 'bodhi-code-lead': { context: 'you own bodhi-code' } },
  projects: { '17': { context: 'Bodhi Pulse' } },
});

describe('parseConfig', () => {
  test('a valid config normalizes repos and ignores unknown repo keys', () => {
    const r = parseConfig(validRaw);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.config.version).toBe(1);
    expect(r.config.repos['bodhi-code'].keyPrefix).toBe('CO');
    expect(r.config.repos['bodhi-code'].ownerAgent).toBe('bodhi-code-lead');
    // Unknown key `junk` is dropped, not carried onto the RepoConfig.
    expect(Object.keys(r.config.repos['bodhi-service-ml'])).not.toContain('junk');
    expect(r.config.owners['bodhi-code-lead'].context).toBe('you own bodhi-code');
    expect(r.config.projects['17'].context).toBe('Bodhi Pulse');
  });

  test('parses a repo\'s expectedChecks and expectedChecksAfterReview', () => {
    const raw = JSON.stringify({
      version: 1,
      repos: { Bodhilander: { expectedChecks: ['quality-gate', 'test (ubuntu-latest)'], expectedChecksAfterReview: ['arbiter/review'] } },
    });
    const r = parseConfig(raw);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.config.repos['Bodhilander'].expectedChecks).toEqual(['quality-gate', 'test (ubuntu-latest)']);
    expect(r.config.repos['Bodhilander'].expectedChecksAfterReview).toEqual(['arbiter/review']);
  });

  test('a repo without check fields leaves them undefined', () => {
    const r = parseConfig(JSON.stringify({ version: 1, repos: { x: { keyPrefix: 'X' } } }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.config.repos['x'].expectedChecks).toBeUndefined();
  });

  test('invalid JSON is a problem', () => {
    const r = parseConfig('{ not json');
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('JSON');
  });

  test('a wrong version is a problem naming the expected version', () => {
    const r = parseConfig(JSON.stringify({ version: 2, repos: {} }));
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('version');
  });

  test('a non-object repos is a problem', () => {
    const r = parseConfig(JSON.stringify({ version: 1, repos: [] }));
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('repos');
  });

  test('a top-level non-object is a problem', () => {
    const r = parseConfig('42');
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('object');
  });

  test('parses a per-project eligibleApprovalValues override (dropping non-strings/blanks)', () => {
    const raw = JSON.stringify({
      version: 1,
      repos: { x: {} },
      projects: { '17': { eligibleApprovalValues: ['Approved', ' Auto-approved ', '', 5] } },
    });
    const r = parseConfig(raw);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.config.projects['17'].eligibleApprovalValues).toEqual(['Approved', 'Auto-approved']);
  });

  test('a project entry without eligibleApprovalValues leaves it undefined', () => {
    const r = parseConfig(JSON.stringify({ version: 1, repos: { x: {} }, projects: { '17': { context: 'c' } } }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.config.projects['17'].eligibleApprovalValues).toBeUndefined();
    expect(r.config.projects['17'].context).toBe('c');
  });

  test('owners and projects are optional (absent → empty maps)', () => {
    const r = parseConfig(JSON.stringify({ version: 1, repos: { 'x': {} } }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.config.owners).toEqual({});
    expect(r.config.projects).toEqual({});
  });
});

describe('configFetchArgv', () => {
  test('asks for raw content of the repo path', () => {
    expect(configFetchArgv('org/cfg', 'orchestration.json')).toEqual([
      'api', 'repos/org/cfg/contents/orchestration.json', '-H', 'Accept: application/vnd.github.raw',
    ]);
  });
});

const okGh = (stdout: string): ConfigDeps['gh'] => async () => ({ code: 0, stdout, stderr: '' });

function deps(gh: ConfigDeps['gh'], over: Partial<ConfigDeps> = {}): ConfigDeps {
  let store: { config: OrchestrationConfig; fetchedAt: string } | null = null;
  return {
    gh,
    repoSlug: 'org/cfg',
    path: 'orchestration.json',
    readCache: () => store,
    writeCache: (v) => { store = v; },
    now: () => 1_000_000,
    ttlMs: 5 * 60_000,
    ...over,
  };
}

describe('loadConfig', () => {
  test('no config repo configured is a fixable problem', async () => {
    const r = await loadConfig(deps(okGh(validRaw), { repoSlug: null }));
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('config repo');
  });

  test('a fresh fetch parses, caches, and returns ok', async () => {
    let store: { config: OrchestrationConfig; fetchedAt: string } | null = null;
    const r = await loadConfig(deps(okGh(validRaw), { readCache: () => store, writeCache: (v) => { store = v; } }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(Object.keys(r.config.repos)).toContain('bodhi-code');
    expect(store).not.toBeNull();
  });

  test('a fresh cache within the TTL is served without a fetch', async () => {
    let calls = 0;
    const gh: ConfigDeps['gh'] = async () => { calls += 1; return { code: 0, stdout: validRaw, stderr: '' }; };
    const parsed = parseConfig(validRaw);
    if (parsed.status !== 'ok') throw new Error('unreachable');
    const cached = { config: parsed.config, fetchedAt: new Date(1_000_000 - 60_000).toISOString() };
    const r = await loadConfig(deps(gh, { readCache: () => cached }));
    expect(r.status).toBe('ok');
    expect(calls).toBe(0);
  });

  test('an expired cache triggers a refetch', async () => {
    let calls = 0;
    const gh: ConfigDeps['gh'] = async () => { calls += 1; return { code: 0, stdout: validRaw, stderr: '' }; };
    const parsed = parseConfig(validRaw);
    if (parsed.status !== 'ok') throw new Error('unreachable');
    const cached = { config: parsed.config, fetchedAt: new Date(1_000_000 - 10 * 60_000).toISOString() };
    const r = await loadConfig(deps(gh, { readCache: () => cached }));
    expect(r.status).toBe('ok');
    expect(calls).toBe(1);
  });

  test('force refetches even within the TTL', async () => {
    let calls = 0;
    const gh: ConfigDeps['gh'] = async () => { calls += 1; return { code: 0, stdout: validRaw, stderr: '' }; };
    const parsed = parseConfig(validRaw);
    if (parsed.status !== 'ok') throw new Error('unreachable');
    const cached = { config: parsed.config, fetchedAt: new Date(1_000_000 - 60_000).toISOString() };
    await loadConfig(deps(gh, { readCache: () => cached }), { force: true });
    expect(calls).toBe(1);
  });

  test('a transient fetch failure falls back to the last good cache, marked stale', async () => {
    const failGh: ConfigDeps['gh'] = async () => ({ code: 1, stdout: '', stderr: 'gh: server error' } satisfies CommandResult);
    const parsed = parseConfig(validRaw);
    if (parsed.status !== 'ok') throw new Error('unreachable');
    const cached = { config: parsed.config, fetchedAt: new Date(1_000_000 - 10 * 60_000).toISOString() };
    const r = await loadConfig(deps(failGh, { readCache: () => cached }));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.stale).toBe(true);
  });

  test('a fetch failure with no cache is a problem carrying the stderr', async () => {
    const failGh: ConfigDeps['gh'] = async () => ({ code: 1, stdout: '', stderr: 'gh: 404 not found' });
    const r = await loadConfig(deps(failGh));
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('404');
  });

  test('a malformed file is a LOUD problem — never served stale over a bug', async () => {
    const parsed = parseConfig(validRaw);
    if (parsed.status !== 'ok') throw new Error('unreachable');
    // A good stale cache exists, but the fresh file is broken: we must surface it.
    const cached = { config: parsed.config, fetchedAt: new Date(1_000_000 - 10 * 60_000).toISOString() };
    const r = await loadConfig(deps(okGh('{ broken'), { readCache: () => cached }));
    expect(r.status).toBe('problem');
    if (r.status !== 'problem') throw new Error('unreachable');
    expect(r.problem).toContain('invalid');
  });
});
