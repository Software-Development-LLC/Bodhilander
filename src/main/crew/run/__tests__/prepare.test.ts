import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));
const identities: Record<string, { accountUuid: string | null; email: string | null }> = {};
mock.module('../../../account-identity', () => ({
  resolveAccountIdentity: (dir: string) => ({ loggedIn: true, ...(identities[dir] ?? { accountUuid: null, email: null }) }),
}));

const { prepareRun, HOLD_MISSING, HOLD_SIGNED_OUT, HOLD_SETUP } = await import('../prepare');
const { CrewSignIn } = await import('../../crew-token');
const { SocketRootError } = await import('../sockets');
const { ServicesNotReady } = await import('../services');
const { markTainted, isTainted } = await import('../../taint');
const { Holds } = await import('../../holds');
const { HireDayUsage } = await import('../hire-usage');
const { SteeringUnavailable } = await import('../../handbook');
import type { AccountUsage, ClaudeAccount } from '../../../../shared/types';
import type { CrewJob, PreparedRun } from '../loop';
import { HIRE, PERSON, crewDb, uuid } from '../../__tests__/crew-db';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const job = (over: Partial<CrewJob> = {}): CrewJob => ({
  id: uuid(1), hireId: HIRE, kind: 'message', epoch: 1, scope: 'owner', requestedBy: PERSON, sender: 'B', text: 'do the thing', attempts: 1, ...over,
});

function setup(opts: { ships?: boolean; loggedIn?: boolean; ref?: unknown; services?: 'root' | 'not-ready'; dailyTokenCap?: number; hub?: (hireId: string, epoch: number, since: number) => Promise<number | null> } = {}) {
  const { raw, db } = crewDb();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-prep-'));
  dirs.push(userData);
  raw.query(`INSERT INTO claude_accounts (id, label, config_dir, email) VALUES ('a1', 'Work Max', '/acct/a1', 'b@x.com')`).run();
  identities['/acct/a1'] = { accountUuid: 'u-a1', email: 'b@x.com' };
  const ref = opts.ref === undefined ? { accountUuid: 'u-a1', email: 'b@x.com', label: 'Work Max' } : opts.ref;
  raw.query(`INSERT INTO crew_hire_cache (hire_id, rev, data) VALUES (?, 1, ?)`).run(HIRE, JSON.stringify({ accountRef: ref, dailyTokenCap: opts.dailyTokenCap ?? null }));
  const cipher = { isEncryptionAvailable: () => true, encryptString: (p: string) => Buffer.from(p), decryptString: (b: Buffer) => b.toString() };
  const signIn = new CrewSignIn(db, cipher, opts.ships ?? false);
  const accounts = [{ id: 'a1', label: 'Work Max', configDir: '/acct/a1', email: 'b@x.com' } as ClaudeAccount];
  const deps = {
    db, signIn, accounts: () => accounts, loggedIn: () => opts.loggedIn ?? true, userData, home: '/Users/me', claudePath: '/usr/local/bin/claude',
    env: { PATH: '/usr/bin', GH_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'k' }, timeZone: () => 'UTC', handbook: () => '# Role\n',
    services: async () => {
      if (opts.services === 'root') throw new SocketRootError({ type: 'symlink', uid: 0, mode: '777' });
      if (opts.services === 'not-ready') throw new ServicesNotReady('the Crew MCP host is not listening');
      return { mcpServers: { crew_approve: { command: 'x' } }, sockets: ['/tmp/cr-501/abcdefgh/gh.sock'], pathFirst: '/shim', env: { CREW_GH_SOCKET: '/tmp/cr-501/abcdefgh/gh.sock' } };
    },
    sandbox: () => ({ accountDirs: ['/acct/a1'], userDataEntries: [], crewEntries: [], sockets: [], socketRoot: '/tmp/cr-501', allowedDomains: [] }),
    now: () => Date.parse('2026-11-27T12:00:00Z'), underTemp: () => false,
    holds: new Holds(), usage: (_id: string): AccountUsage | null => null, accountCap: () => ({ fiveHourPct: 90, sevenDayPct: 90 }),
    hireUsage: new HireDayUsage(db, opts.hub ?? null),
  };
  return { raw, db, deps, userData, root: path.join(userData, 'crew', HIRE) };
}

describe('preparing a run', () => {
  test('on Windows a run is held for setup and writes nothing, since it may only run inside WSL2', async () => {
    const t = setup();
    t.deps.platform = 'win32';
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    expect(fs.existsSync(t.root)).toBe(false);
  });

  test('on Windows the setup gate decides, and a passing gate still never prepares a native run', async () => {
    const t = setup();
    t.deps.platform = 'win32';
    t.deps.windows = { gate: async () => 'held:setup' };
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    t.deps.windows = { gate: async () => null };
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    const calls: string[] = [];
    t.deps.windows = { gate: async () => null, prepare: async (_j, _k, runId) => (calls.push(runId), { hold: 'from-wsl' }) };
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: 'from-wsl' });
    expect(calls).toEqual(['run-1']);
    expect(fs.existsSync(t.root)).toBe(false);
  });

  test('resolves the account, writes settings, CLAUDE.md and mcp config, and keeps tokens out of the env', async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.root, 'owner', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(t.root, 'owner', '.claude', 'settings.json'), '{"hooks":{}}');
    const p = (await prepareRun(t.deps, job(), 'chat:owner', 'run-1')) as PreparedRun;
    expect(p.accountId).toBe('a1');
    expect(p.cwd).toBe(path.join(t.root, 'owner'));
    expect(p.input).toBe('do the thing');
    expect(p.token).toBeNull();
    expect(fs.existsSync(path.join(t.root, 'owner', '.claude'))).toBe(false);
    expect(fs.readFileSync(path.join(t.root, 'owner', 'CLAUDE.md'), 'utf8')).toBe('# Role\n');
    const settings = p.args[p.args.indexOf('--settings') + 1];
    expect(settings).toBe(path.join(t.root, 'run', 'settings-owner.json'));
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).autoMemoryEnabled).toBe(false);
    expect(JSON.parse(fs.readFileSync(p.args[p.args.indexOf('--mcp-config') + 1], 'utf8'))).toEqual({ mcpServers: { crew_approve: { command: 'x' } } });
    expect(p.env.CLAUDE_CONFIG_DIR).toBe('/acct/a1');
    expect(Object.keys(p.env)).not.toContain('GH_TOKEN');
    expect(Object.keys(p.env)).not.toContain('ANTHROPIC_API_KEY');
    expect(p.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBeUndefined();
  });

  test("git reads the hire's own global config, which ignores no file and sets no attributes", async () => {
    const t = setup();
    const p = (await prepareRun(t.deps, job(), 'chat:owner', 'run-1')) as PreparedRun;
    expect(p.env.GIT_CONFIG_GLOBAL).toBe(path.join(t.root, 'git', 'gitconfig'));
    expect(fs.readFileSync(p.env.GIT_CONFIG_GLOBAL, 'utf8')).toBe('[core]\n\texcludesFile = /dev/null\n\tattributesFile = /dev/null\n');
    const s = JSON.parse(fs.readFileSync(p.args[p.args.indexOf('--settings') + 1], 'utf8'));
    expect(s.sandbox.filesystem.denyWrite).toContain(path.join(t.root, 'git'));
  });

  test('a circle run works in circle/', async () => {
    const t = setup();
    const p = (await prepareRun(t.deps, job({ scope: 'circle' }), 'chat:circle', 'run-1')) as PreparedRun;
    expect(p.cwd).toBe(path.join(t.root, 'circle'));
  });

  test('no local account for the reference holds the hire missing', async () => {
    expect(await prepareRun(setup({ ref: { accountUuid: 'u-gone', email: 'z@x.com', label: 'Gone' } }).deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_MISSING });
    expect(await prepareRun(setup({ ref: null }).deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_MISSING });
  });

  test('a signed-out account holds the hire signed out', async () => {
    expect(await prepareRun(setup({ loggedIn: false }).deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SIGNED_OUT });
    expect(await prepareRun(setup({ ships: true }).deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SIGNED_OUT });
  });

  test('a hire folder under a temp dir starts nothing', async () => {
    const t = setup();
    expect(await prepareRun({ ...t.deps, underTemp: () => true }, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    expect(fs.existsSync(t.root)).toBe(false);
  });

  test('a tainted thread starts a fresh session carrying its last turns, and the mark is spent', async () => {
    const t = setup();
    t.raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id, updated_at) VALUES (?, 'chat:owner', 'old', 'a1', '2026-11-27 11:00:00')`).run(HIRE);
    t.raw.query(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, text, state) VALUES (?, ?, 1, 'owner', ?, 'earlier ask', 'done')`).run(uuid(9), HIRE, PERSON);
    t.raw.query(`INSERT INTO crew_run (id, job_id, hire_id, thread_key, outcome, reply_text) VALUES (?, ?, ?, 'chat:owner', 'done', 'earlier answer')`).run(uuid(10), uuid(9), HIRE);
    markTainted(t.db, HIRE, 'chat:owner', 'issue-body');
    const p = (await prepareRun(t.deps, job(), 'chat:owner', 'run-1')) as PreparedRun;
    expect(p.sessionId).toBeNull();
    expect(p.args).not.toContain('--resume');
    expect(p.input).toContain('untrusted content');
    expect(p.input).toContain('earlier answer');
    expect(p.input.endsWith('do the thing')).toBe(true);
    expect(isTainted(t.db, HIRE, 'chat:owner')).toBe(false);
    expect(t.raw.query(`SELECT session_id FROM crew_thread`).get()).toEqual({ session_id: null });
  });

  test('a token-mode hold leaves a tainted thread marked', async () => {
    const t = setup({ ships: true });
    t.raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id, updated_at) VALUES (?, 'chat:owner', 'old', 'a1', '2026-11-27 11:00:00')`).run(HIRE);
    markTainted(t.db, HIRE, 'chat:owner', 'issue-body');
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SIGNED_OUT });
    expect(isTainted(t.db, HIRE, 'chat:owner')).toBe(true);
  });

  test("a session made under another account starts fresh, and the refusal is audited", async () => {
    const t = setup();
    t.raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id, updated_at) VALUES (?, 'chat:owner', 'old', 'a2', '2026-11-27 11:00:00')`).run(HIRE);
    const p = (await prepareRun(t.deps, job(), 'chat:owner', 'run-1')) as PreparedRun;
    expect(p.sessionId).toBeNull();
    expect(p.args).not.toContain('--resume');
    expect(p.input).toContain("account changed");
    const rows = t.raw.query(`SELECT hire_id, event, detail FROM crew_audit WHERE event = 'session-other-account'`).all() as { hire_id: string; detail: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].hire_id).toBe(HIRE);
    expect(JSON.parse(rows[0].detail)).toEqual({ threadKey: 'chat:owner', sessionAccountId: 'a2', runAccountId: 'a1' });
  });

  test('steering a past run left below the run root is gone before the next run, and the handbook is rewritten', async () => {
    const t = setup();
    const owner = path.join(t.root, 'owner');
    fs.mkdirSync(path.join(owner, 'notes', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(owner, 'CLAUDE.local.md'), 'planted');
    fs.writeFileSync(path.join(owner, 'notes', 'CLAUDE.md'), 'planted');
    fs.writeFileSync(path.join(owner, 'notes', 'keep.md'), 'mine');
    await prepareRun(t.deps, job(), 'chat:owner', 'run-1');
    expect(fs.existsSync(path.join(owner, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(owner, 'notes', 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(owner, 'notes', '.claude'))).toBe(false);
    expect(fs.readFileSync(path.join(owner, 'notes', 'keep.md'), 'utf8')).toBe('mine');
    expect(fs.readFileSync(path.join(owner, 'CLAUDE.md'), 'utf8')).toBe('# Role\n');
  });

  test('an untainted thread on the same day resumes its session', async () => {
    const t = setup();
    t.raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id, updated_at) VALUES (?, 'chat:owner', 'old', 'a1', '2026-11-27 11:00:00')`).run(HIRE);
    const p = (await prepareRun(t.deps, job(), 'chat:owner', 'run-1')) as PreparedRun;
    expect(p.sessionId).toBe('old');
    expect(p.args.slice(0, 3)).toEqual(['-p', '--resume', 'old']);
  });
});

const NOW = Date.parse('2026-11-27T12:00:00Z');
const usageAt = (fivePct: number | null, sevenPct: number | null): AccountUsage => ({
  accountId: 'a1', source: 'run', observedAt: NOW, unavailable: null,
  fiveHour: fivePct === null ? null : { pct: fivePct, resetsAt: NOW + 3_600_000, observedAt: NOW },
  sevenDay: sevenPct === null ? null : { pct: sevenPct, resetsAt: NOW + 86_400_000, observedAt: NOW },
});
const doneRun = (raw: ReturnType<typeof crewDb>['raw'], id: string, endedAt: string, tokens: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }) =>
  raw.query(`INSERT INTO crew_run (id, job_id, hire_id, ended_at, outcome, usage) VALUES (?, 'j', ?, ?, 'done', ?)`).run(id, HIRE, endedAt, JSON.stringify({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...tokens }));

describe('usage holds before a run', () => {
  test('on Windows the usage holds apply too, before anything is prepared inside WSL2', async () => {
    const t = setup();
    t.deps.platform = 'win32';
    const calls: string[] = [];
    t.deps.windows = { gate: async () => null, prepare: async (_j, _k, runId) => (calls.push(runId), { hold: 'from-wsl' }) };
    t.deps.holds.recordRateLimit('a1', NOW + 60_000);
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: 'held:rate-limited' });
    expect(calls).toEqual([]);
    t.deps.now = () => NOW + 60_000;
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-2')).toEqual({ hold: 'from-wsl' });
    expect(calls).toEqual(['run-2']);
  });

  test('a recorded rate limit holds the hire rate-limited until its reset, and writes nothing', async () => {
    const t = setup();
    t.deps.holds.recordRateLimit('a1', NOW + 60_000);
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: 'held:rate-limited' });
    expect(fs.existsSync(t.root)).toBe(false);
    t.deps.now = () => NOW + 60_000;
    expect('hold' in (await prepareRun(t.deps, job(), 'chat:owner', 'run-1'))).toBe(false);
  });

  test("an account at its crew.accountCap holds the hire crew-cap, read against the account's own cap", async () => {
    const t = setup();
    t.deps.usage = () => usageAt(null, 80);
    t.deps.accountCap = () => ({ fiveHourPct: 90, sevenDayPct: 80 });
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: 'held:crew-cap' });
    t.deps.accountCap = () => ({ fiveHourPct: 90, sevenDayPct: 81 });
    expect('hold' in (await prepareRun(t.deps, job(), 'chat:owner', 'run-1'))).toBe(false);
  });

  test('with no window reported, runs start', async () => {
    const t = setup();
    t.deps.usage = () => usageAt(null, null);
    expect('hold' in (await prepareRun(t.deps, job(), 'chat:owner', 'run-1'))).toBe(false);
  });

  test("a hire over its dailyTokenCap today is held hire-cap; cache reads and yesterday's runs don't count", async () => {
    const t = setup({ dailyTokenCap: 1000 });
    doneRun(t.raw, 'r-old', '2026-11-26 23:59:59', { input_tokens: 5000, output_tokens: 0 });
    doneRun(t.raw, 'r-1', '2026-11-27 09:00:00', { input_tokens: 400, output_tokens: 100, cache_read_input_tokens: 10_000 });
    expect('hold' in (await prepareRun(t.deps, job(), 'chat:owner', 'run-1'))).toBe(false);
    doneRun(t.raw, 'r-2', '2026-11-27 10:00:00', { input_tokens: 300, output_tokens: 200 });
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: 'held:hire-cap' });
  });

  test("the hire cap counts the Hub's total for the owner's day, read once, plus local runs since", async () => {
    const calls: { since: number; epoch: number }[] = [];
    const t = setup({ dailyTokenCap: 1000, hub: async (_h, epoch, since) => (calls.push({ since, epoch }), 900) });
    t.deps.timeZone = () => 'America/New_York';
    expect('hold' in (await prepareRun(t.deps, job(), 'chat:owner', 'run-1'))).toBe(false);
    expect(calls).toEqual([{ since: Date.parse('2026-11-27T05:00:00Z'), epoch: 1 }]);
    doneRun(t.raw, 'r-1', '2026-11-27 12:00:00', { input_tokens: 100, output_tokens: 0 });
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: 'held:hire-cap' });
    expect(calls.length).toBe(1);
    await prepareRun(t.deps, job({ epoch: 2 }), 'chat:owner', 'run-1');
    expect(calls.length).toBe(2);
  });

  test("the cap's day follows the hire's zone, and a zone change re-reads at the next check", async () => {
    const calls: number[] = [];
    const asked: string[] = [];
    let zone = 'America/New_York';
    const t = setup({ dailyTokenCap: 1000, hub: async (_h, _e, since) => (calls.push(since), 0) });
    t.deps.timeZone = (hireId: string) => (asked.push(hireId), zone);
    await prepareRun(t.deps, job(), 'chat:owner', 'run-1');
    zone = 'Asia/Tokyo';
    await prepareRun(t.deps, job(), 'chat:owner', 'run-1');
    expect(calls).toEqual([Date.parse('2026-11-27T05:00:00Z'), Date.parse('2026-11-26T15:00:00Z')]);
    expect(new Set(asked)).toEqual(new Set([HIRE]));
  });

  test('with the cap off the Hub is never asked', async () => {
    let asked = false;
    const t = setup({ hub: async () => ((asked = true), 10 ** 9) });
    expect('hold' in (await prepareRun(t.deps, job(), 'chat:owner', 'run-1'))).toBe(false);
    expect(asked).toBe(false);
  });
});

describe('run services in preparation', () => {
  test('the gateway socket joins the sandbox, the shim leads PATH, and its env reaches the run', async () => {
    const t = setup();
    const p = (await prepareRun(t.deps, job(), 'chat:owner', 'run-1')) as PreparedRun;
    const settings = JSON.parse(fs.readFileSync(p.args[p.args.indexOf('--settings') + 1], 'utf8'));
    expect(JSON.stringify(settings)).toContain('/tmp/cr-501/abcdefgh/gh.sock');
    expect(p.env.PATH).toBe('/shim:/usr/bin');
    expect(p.env.CREW_GH_SOCKET).toBe('/tmp/cr-501/abcdefgh/gh.sock');
  });

  test('a socket root that fails its check holds the machine for setup', async () => {
    const t = setup({ services: 'root' });
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
  });

  test('services that are not ready yet hold the run for setup rather than failing it', async () => {
    const t = setup({ services: 'not-ready' });
    expect(await prepareRun(t.deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
  });

  test('a role or bundle that has not synced holds the run for setup and rewrites nothing', async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.root, 'owner'), { recursive: true });
    fs.writeFileSync(path.join(t.root, 'owner', 'CLAUDE.md'), 'stale');
    const deps = { ...t.deps, handbook: () => { throw new SteeringUnavailable('the role has not synced'); } };
    expect(await prepareRun(deps, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    expect(fs.readFileSync(path.join(t.root, 'owner', 'CLAUDE.md'), 'utf8')).toBe('stale');
    const restored: string[] = [];
    const skills = { ...t.deps, restoreSkills: (_p: unknown, hireId: string) => { restored.push(hireId); throw new SteeringUnavailable('the skill bundle has not been fetched'); } };
    expect(await prepareRun(skills, job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    expect(restored).toEqual([HIRE]);
  });

  test('any other failure regenerating the steering paths still stops the run', async () => {
    const t = setup();
    const deps = { ...t.deps, restoreSkills: () => { throw new Error('disk full'); } };
    await expect(prepareRun(deps, job(), 'chat:owner', 'run-1')).rejects.toThrow('disk full');
  });
});
