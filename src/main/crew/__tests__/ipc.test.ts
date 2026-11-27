import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));

const { activityFor, crewStatusFrom, readHire, readHires, readHireUsage, registerCrewIpc, USAGE_WINDOW_MS } = await import('../ipc');
import type { ClaudeAccount } from '../../../shared/types';
import type { UsageFrame } from '../protocol';
import { crewDb, HIRE, HIRE_B, MACHINE, type Db } from './crew-db';

const OTHER_MACHINE = '55555555-5555-4555-8555-555555555555';
const NOW = Date.parse('2026-11-27T12:00:00Z');

const account = (id: string, label: string): ClaudeAccount => ({ id, label, configDir: `/d/${id}`, email: `${id}@x.com`, color: '#000', isDefault: false }) as ClaudeAccount;

function putHire(db: Db, hireId: string, body: Record<string, unknown>, rev = 1): void {
  db.prepare(`INSERT OR REPLACE INTO crew_hire_cache (hire_id, rev, home_machine_id, epoch, data) VALUES (?, ?, ?, ?, ?)`).run(
    hireId,
    rev,
    (body.homeMachineId as string | null) ?? null,
    (body.epoch as number) ?? 1,
    JSON.stringify(body),
  );
}

function hireBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Fresh PO',
    roleId: 'fresh-po',
    skillBundleId: 'bundle-1',
    skillBundleHash: 'abc123',
    repos: ['acme/bodhi-fresh', 'acme/bodhi-care'],
    sharedWith: [],
    accountRef: { accountUuid: 'u-1', email: 'a@x.com', label: 'Work' },
    homeMachineId: MACHINE,
    epoch: 3,
    state: 'active',
    dailyTokenCap: null,
    ...over,
  };
}

describe('the status the renderer sees', () => {
  test('no Hub client at all reads as unlinked, never as an error', () => {
    expect(crewStatusFrom(null, null)).toEqual({ availability: 'unlinked', owner: null });
  });

  test('an idle client is still connecting', () => {
    expect(crewStatusFrom('idle', null).availability).toBe('connecting');
  });

  test('every other Hub status passes through with the owner', () => {
    const owner = { name: 'Brannon', upn: 'b@x.com' };
    expect(crewStatusFrom('online', owner)).toEqual({ availability: 'online', owner });
    expect(crewStatusFrom('unavailable', null).availability).toBe('unavailable');
    expect(crewStatusFrom('update-required', null).availability).toBe('update-required');
  });
});

describe('what a hire is doing', () => {
  test('a running job wins over an active state', () => {
    expect(activityFor('active', MACHINE, MACHINE, true)).toEqual({ activity: 'running', cause: null });
  });

  test('an active hire with nothing running is idle', () => {
    expect(activityFor('active', MACHINE, MACHINE, false)).toEqual({ activity: 'idle', cause: null });
  });

  test('a hold names its cause', () => {
    expect(activityFor('held:signed-out', MACHINE, MACHINE, false)).toEqual({ activity: 'held', cause: 'signed-out' });
    expect(activityFor('held:no-home', null, MACHINE, false)).toEqual({ activity: 'held', cause: 'no-home' });
  });

  test('a hire whose home is another machine is shown as elsewhere', () => {
    expect(activityFor('active', OTHER_MACHINE, MACHINE, false)).toEqual({ activity: 'elsewhere', cause: null });
  });

  test('provisioning, paused and let go are their own states', () => {
    expect(activityFor('provisioning:waiting-admin', MACHINE, MACHINE, false)).toEqual({ activity: 'provisioning', cause: 'waiting-admin' });
    expect(activityFor('paused:backstop', MACHINE, MACHINE, false)).toEqual({ activity: 'paused', cause: 'backstop' });
    expect(activityFor('let_go', MACHINE, MACHINE, false)).toEqual({ activity: 'let-go', cause: null });
  });
});

describe('reading hires from the local store', () => {
  let db: Db;
  const accounts = [account('acc-1', 'Work')];
  const resolve = (ref: { accountUuid: string | null }) => (ref.accountUuid === 'u-1' ? accounts[0] : null);

  beforeEach(() => {
    db = crewDb().db;
  });

  test('lists synced hires by name, skipping fence-only rows that have no body', () => {
    putHire(db, HIRE, hireBody({ name: 'Zed' }));
    putHire(db, HIRE_B, hireBody({ name: 'Ada' }));
    db.prepare(`INSERT INTO crew_hire_cache (hire_id, rev, epoch) VALUES ('fence-only', 0, 2)`).run();
    const hires = readHires(db, MACHINE, resolve);
    expect(hires.map((h) => h.name)).toEqual(['Ada', 'Zed']);
  });

  test('marks a hire running when one of its jobs is', () => {
    putHire(db, HIRE, hireBody());
    db.prepare(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, state) VALUES ('j1', ?, 3, 'owner', 'p', 'running')`).run(HIRE);
    expect(readHires(db, MACHINE, resolve)[0].activity).toBe('running');
  });

  test('a hire carries the label of the local account it resolves to', () => {
    putHire(db, HIRE, hireBody());
    expect(readHires(db, MACHINE, resolve)[0].accountLabel).toBe('Work');
  });

  test('a hire whose account resolves to nothing keeps the label from its reference', () => {
    putHire(db, HIRE, hireBody({ accountRef: { accountUuid: 'u-gone', email: 'g@x.com', label: 'Gone' } }));
    const detail = readHire(db, HIRE, MACHINE, resolve);
    expect(detail?.accountLabel).toBe('Gone');
    expect(detail?.accountId).toBeNull();
  });

  test("the detail lists the cached skill bundles for the hire's role that carry a hash, to pin from", () => {
    putHire(db, HIRE, hireBody());
    const bundle = (id: string, body: Record<string, unknown>) => db.prepare(`INSERT INTO crew_skill_cache (skill_id, rev, data) VALUES (?, 1, ?)`).run(id, JSON.stringify(body));
    bundle('b-po', { role: 'fresh-po', files: [{ path: 'a.md', content: 'a' }, { path: 'b.md', content: 'b' }], hash: 'h-po' });
    bundle('b-other', { role: 'care-po', files: [], hash: 'h-other' });
    bundle('b-nohash', { role: 'fresh-po', files: [] });
    expect(readHire(db, HIRE, MACHINE, resolve)?.bundles).toEqual([{ id: 'b-po', files: 2 }]);
  });

  test('a corrupt row is skipped, not thrown', () => {
    db.prepare(`INSERT INTO crew_hire_cache (hire_id, rev, data) VALUES ('bad', 1, '{not json')`).run();
    putHire(db, HIRE, hireBody());
    expect(readHires(db, MACHINE, resolve).map((h) => h.hireId)).toEqual([HIRE]);
  });

  test('the detail carries repos, cap, bundle pin and the hire routines', () => {
    putHire(db, HIRE, hireBody({ dailyTokenCap: 500_000 }));
    db.prepare(`INSERT INTO crew_routine_cache (routine_id, hire_id, rev, data) VALUES ('r1', ?, 1, ?)`).run(
      HIRE,
      JSON.stringify({ hireId: HIRE, cron: '0 9 * * 1-5', timezone: 'America/Chicago', prompt: 'Standup', lastFired: 1000, lastRun: null }),
    );
    db.prepare(`INSERT INTO crew_routine_cache (routine_id, hire_id, rev, data) VALUES ('r2', ?, 1, '{}')`).run(HIRE_B);
    const detail = readHire(db, HIRE, MACHINE, resolve);
    expect(detail).toMatchObject({
      repos: ['acme/bodhi-fresh', 'acme/bodhi-care'],
      dailyTokenCap: 500_000,
      skillBundleId: 'bundle-1',
      skillBundleHash: 'abc123',
      accountId: 'acc-1',
      accountEmail: 'a@x.com',
    });
    expect(detail?.routines).toEqual([{ routineId: 'r1', cron: '0 9 * * 1-5', timezone: 'America/Chicago', prompt: 'Standup', lastFired: 1000 }]);
  });

  test('an unknown hire has no detail', () => {
    expect(readHire(db, 'nope', MACHINE, resolve)).toBeNull();
  });
});

describe("the hire's 7-day usage", () => {
  const frame = (over: Partial<UsageFrame> = {}): UsageFrame => ({
    type: 'usage',
    id: 'u',
    hireId: HIRE,
    since: NOW - USAGE_WINDOW_MS,
    inputTokens: 1200,
    outputTokens: 300,
    cacheCreationTokens: 50,
    records: 5,
    ...over,
  });

  test('asks the Hub for the last 7 days and returns its tokens', async () => {
    let asked: { hireId: string; epoch: number; since: number } | null = null;
    const usage = await readHireUsage(
      { online: () => true, epochOf: () => 3, usageRead: async (hireId, epoch, since) => ((asked = { hireId, epoch, since }), frame()) },
      HIRE,
      NOW,
    );
    expect(asked).toEqual({ hireId: HIRE, epoch: 3, since: NOW - 7 * 24 * 3_600_000 });
    expect(usage).toEqual({ available: true, since: NOW - USAGE_WINDOW_MS, inputTokens: 1200, outputTokens: 300, cacheCreationTokens: 50, records: 5 });
  });

  test('offline is not available, and the Hub is not asked', async () => {
    let asked = false;
    const usage = await readHireUsage({ online: () => false, epochOf: () => 3, usageRead: async () => ((asked = true), frame()) }, HIRE, NOW);
    expect(usage).toEqual({ available: false, reason: 'offline' });
    expect(asked).toBe(false);
  });

  test('no answer is unreachable, and a thrown read is failed; neither is zero', async () => {
    expect(await readHireUsage({ online: () => true, epochOf: () => 3, usageRead: async () => null }, HIRE, NOW)).toEqual({ available: false, reason: 'unreachable' });
    const failed = await readHireUsage({ online: () => true, epochOf: () => 3, usageRead: async () => { throw new Error('boom'); } }, HIRE, NOW);
    expect(failed).toEqual({ available: false, reason: 'failed' });
  });

  test('an answer for another hire, or with a missing count, is failed', async () => {
    const other = await readHireUsage({ online: () => true, epochOf: () => 3, usageRead: async () => frame({ hireId: HIRE_B }) }, HIRE, NOW);
    expect(other).toEqual({ available: false, reason: 'failed' });
    const partial = await readHireUsage(
      { online: () => true, epochOf: () => 3, usageRead: async () => ({ ...frame(), outputTokens: undefined }) as unknown as UsageFrame },
      HIRE,
      NOW,
    );
    expect(partial).toEqual({ available: false, reason: 'failed' });
  });

  test('a hire with no known epoch is not asked about', async () => {
    const usage = await readHireUsage({ online: () => true, epochOf: () => null, usageRead: async () => frame() }, HIRE, NOW);
    expect(usage).toEqual({ available: false, reason: 'failed' });
  });
});

describe('the channels', () => {
  let handlers: Map<string, (...args: unknown[]) => unknown>;
  let db: Db;
  let edits: { hireId: string; fields: Record<string, unknown> }[];
  let changed: [string, string][];
  let hired: unknown[];
  let imported: [string, string][];

  beforeEach(() => {
    db = crewDb().db;
    putHire(db, HIRE, hireBody());
    handlers = new Map();
    edits = [];
    changed = [];
    hired = [];
    imported = [];
    registerCrewIpc({
      handle: (channel, handler) => handlers.set(channel, handler),
      db: () => db,
      machineId: () => MACHINE,
      resolveAccount: () => null,
      accounts: () => [account('acc-1', 'Work')],
      status: () => ({ availability: 'online', owner: null }),
      online: () => true,
      epochOf: () => 3,
      usageRead: async () => null,
      sendHireEdit: (hireId, fields) => {
        edits.push({ hireId, fields });
        return true;
      },
      changeAccount: (hireId, accountId) => {
        changed.push([hireId, accountId]);
        return { ok: true };
      },
      cards: () => null,
      openCard: () => false,
      letGo: async () => ({ ok: false, error: 'not yet' }),
      createHire: async (input) => (hired.push(input), { ok: true, hireId: 'h-new' }),
      hireAccounts: () => [{ id: 'acc-1', label: 'Work', needs: null }],
      beginLink: async () => ({ step: 'stopped', message: 'x' }),
      confirmLinkOwner: () => false,
      officeEmployees: () => ['fresh-po'],
      makeHome: (hireId) => (imported.push([hireId, 'home']), { ok: true }),
      unlink: () => ({ ok: true }),
      pinSkillBundle: async (hireId, bundleId) => (imported.push([hireId, `pin:${bundleId}`]), { ok: true }),
      importFromOffice: async (hireId, handle) => (imported.push([hireId, handle]), { ok: true, skills: 2, notes: 0, work: 3, skipped: [], failed: [] }),
      now: () => NOW,
    });
  });

  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args);

  test('registers every crew channel', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'crew:beginLink',
      'crew:changeAccount',
      'crew:confirmLinkOwner',
      'crew:createHire',
      'crew:getHire',
      'crew:getHireUsage',
      'crew:getStatus',
      'crew:hireAccounts',
      'crew:importFromOffice',
      'crew:letGo',
      'crew:listCards',
      'crew:listHires',
      'crew:listRoles',
      'crew:makeHome',
      'crew:officeEmployees',
      'crew:openCard',
      'crew:pinSkillBundle',
      'crew:setDailyCap',
      'crew:setRepos',
      'crew:unlink',
    ]);
  });

  test('a daily cap is a positive whole number of tokens, or null for off', () => {
    expect(call('crew:setDailyCap', HIRE, 250_000)).toEqual({ ok: true });
    expect(call('crew:setDailyCap', HIRE, null)).toEqual({ ok: true });
    expect(edits.map((e) => e.fields)).toEqual([{ dailyTokenCap: 250_000 }, { dailyTokenCap: null }]);
    for (const bad of [0, -5, 1.5, Number.NaN, '100']) {
      expect((call('crew:setDailyCap', HIRE, bad) as { ok: boolean }).ok).toBe(false);
    }
    expect(edits).toHaveLength(2);
  });

  test('repos can only be removed: trimmed, deduplicated, and any addition is refused here', () => {
    expect(call('crew:setRepos', HIRE, [' ACME/bodhi-fresh ', 'acme/bodhi-fresh'])).toEqual({ ok: true });
    expect(edits[0].fields).toEqual({ repos: ['ACME/bodhi-fresh'] });
    expect(call('crew:setRepos', HIRE, ['acme/bodhi-care'])).toEqual({ ok: true });
    const added = call('crew:setRepos', HIRE, ['acme/bodhi-care', 'acme/bodhi-pulse']) as { ok: boolean; error?: string };
    expect(added.ok).toBe(false);
    expect(added.error).toContain('grant card');
    expect((call('crew:setRepos', HIRE, ['acme/bodhi-care', '']) as { ok: boolean }).ok).toBe(false);
    expect((call('crew:setRepos', HIRE, 'acme/bodhi-care') as { ok: boolean }).ok).toBe(false);
    expect(edits).toHaveLength(2);
  });

  test('a bundle pin names a synced hire and a bundle id', async () => {
    expect(await call('crew:pinSkillBundle', HIRE, 'b-po')).toEqual({ ok: true });
    expect(((await call('crew:pinSkillBundle', 'unknown', 'b-po')) as { ok: boolean }).ok).toBe(false);
    expect(((await call('crew:pinSkillBundle', HIRE, 42)) as { ok: boolean }).ok).toBe(false);
    expect(imported).toEqual([[HIRE, 'pin:b-po']]);
  });

  test('an Office import names a synced hire and an Office employee found here', async () => {
    expect(call('crew:officeEmployees')).toEqual(['fresh-po']);
    expect(await call('crew:importFromOffice', HIRE, 'fresh-po')).toMatchObject({ ok: true, skills: 2, work: 3 });
    expect(((await call('crew:importFromOffice', HIRE, '../core-po')) as { ok: boolean }).ok).toBe(false);
    expect(((await call('crew:importFromOffice', 'unknown', 'fresh-po')) as { ok: boolean }).ok).toBe(false);
    expect(imported).toEqual([[HIRE, 'fresh-po']]);
  });

  test('make this machine home names a synced hire', () => {
    expect(call('crew:makeHome', HIRE)).toEqual({ ok: true });
    expect((call('crew:makeHome', 'unknown') as { ok: boolean }).ok).toBe(false);
    expect(imported).toEqual([[HIRE, 'home']]);
    expect(call('crew:unlink')).toEqual({ ok: true });
  });

  test('an edit to a hire this machine has not synced is refused', () => {
    expect((call('crew:setDailyCap', 'unknown', 10) as { ok: boolean }).ok).toBe(false);
    expect(edits).toHaveLength(0);
  });

  test('an account change names a local account', () => {
    expect(call('crew:changeAccount', HIRE, 'acc-1')).toEqual({ ok: true });
    expect(changed).toEqual([[HIRE, 'acc-1']]);
    expect((call('crew:changeAccount', HIRE, 'nobody') as { ok: boolean }).ok).toBe(false);
  });

  test('unreadable cards stay null, so the inbox never claims to be empty', () => {
    expect(call('crew:listCards')).toBeNull();
  });

  test('a hire is made from the four fields the form sends, and nothing else', async () => {
    const input = { name: 'Fresh PO', roleId: 'fresh-po', repos: ['acme/app'], accountId: 'acc-1', homeMachineId: 'other' };
    expect(await call('crew:createHire', input)).toEqual({ ok: true, hireId: 'h-new' });
    expect(hired).toEqual([{ name: 'Fresh PO', roleId: 'fresh-po', repos: ['acme/app'], accountId: 'acc-1' }]);
  });

  test('a hire request that is not an object is refused before it reaches the Hub', async () => {
    for (const bad of [null, 'x', ['a']]) expect(((await call('crew:createHire', bad)) as { ok: boolean }).ok).toBe(false);
    expect(hired).toHaveLength(0);
  });

  test('roles come from the synced cache by name, without deleted ones', () => {
    db.prepare(`INSERT INTO crew_role_cache (role_id, rev, data) VALUES ('fresh-po', 1, '{"role":"fresh-po","roleMd":"# Fresh"}')`).run();
    db.prepare(`INSERT INTO crew_role_cache (role_id, rev, data) VALUES ('care-po', 1, '{"role":"care-po"}')`).run();
    db.prepare(`INSERT INTO crew_role_cache (role_id, rev, data) VALUES ('gone', 1, '{"deleted":true}')`).run();
    db.prepare(`INSERT INTO crew_role_cache (role_id, rev, data) VALUES ('bad', 1, '{not json')`).run();
    expect(call('crew:listRoles')).toEqual([
      { roleId: 'care-po', name: 'care-po' },
      { roleId: 'fresh-po', name: 'fresh-po' },
    ]);
  });

  test("the usage channel answers not available when the Hub doesn't", async () => {
    expect(await call('crew:getHireUsage', HIRE)).toEqual({ available: false, reason: 'unreachable' });
  });
});

describe('linking from the renderer', () => {
  test('a machine with no machine id is unlinked whatever the client says', () => {
    expect(crewStatusFrom('idle', null, false)).toEqual({ availability: 'unlinked', owner: null });
  });

  test('the codes and the owner question pass through', async () => {
    const { linkViewFrom } = await import('../ipc');
    expect(linkViewFrom({ step: 'show-codes', name: 'Mac', confirmCode: 'ABC123' })).toEqual({ step: 'show-codes', name: 'Mac', confirmCode: 'ABC123' });
    expect(linkViewFrom({ step: 'confirm-owner', ownerName: 'B', ownerUpn: 'b@x' })).toEqual({ step: 'confirm-owner', ownerName: 'B', ownerUpn: 'b@x' });
  });

  test('a Hub that cannot be reached reads as unavailable, not an error', async () => {
    const { linkViewFrom } = await import('../ipc');
    const view = linkViewFrom({ step: 'stopped', result: { kind: 'unreachable' } });
    expect(view).toEqual({ step: 'stopped', message: "Crew isn't available right now. Try linking again later." });
  });

  test('a rate limit says when to try again', async () => {
    const { linkViewFrom } = await import('../ipc');
    const view = linkViewFrom({ step: 'stopped', result: { kind: 'rate-limited', retryAfterSeconds: 30 } });
    expect(view).toEqual({ step: 'stopped', message: 'Too many tries. Try again in 30 seconds.' });
  });
});
