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
const { markTainted, isTainted } = await import('../../taint');
import type { ClaudeAccount } from '../../../../shared/types';
import type { CrewJob, PreparedRun } from '../loop';
import { HIRE, PERSON, crewDb, uuid } from '../../__tests__/crew-db';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const job = (over: Partial<CrewJob> = {}): CrewJob => ({
  id: uuid(1), hireId: HIRE, kind: 'message', epoch: 1, scope: 'owner', requestedBy: PERSON, sender: 'B', text: 'do the thing', attempts: 1, ...over,
});

function setup(opts: { ships?: boolean; loggedIn?: boolean; ref?: unknown } = {}) {
  const { raw, db } = crewDb();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-prep-'));
  dirs.push(userData);
  raw.query(`INSERT INTO claude_accounts (id, label, config_dir, email) VALUES ('a1', 'Work Max', '/acct/a1', 'b@x.com')`).run();
  identities['/acct/a1'] = { accountUuid: 'u-a1', email: 'b@x.com' };
  const ref = opts.ref === undefined ? { accountUuid: 'u-a1', email: 'b@x.com', label: 'Work Max' } : opts.ref;
  raw.query(`INSERT INTO crew_hire_cache (hire_id, rev, data) VALUES (?, 1, ?)`).run(HIRE, JSON.stringify({ accountRef: ref }));
  const cipher = { isEncryptionAvailable: () => true, encryptString: (p: string) => Buffer.from(p), decryptString: (b: Buffer) => b.toString() };
  const signIn = new CrewSignIn(db, cipher, opts.ships ?? false);
  const accounts = [{ id: 'a1', label: 'Work Max', configDir: '/acct/a1', email: 'b@x.com' } as ClaudeAccount];
  const deps = {
    db, signIn, accounts: () => accounts, loggedIn: () => opts.loggedIn ?? true, userData, home: '/Users/me', claudePath: '/usr/local/bin/claude',
    env: { PATH: '/usr/bin', GH_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'k' }, timeZone: () => 'UTC', handbook: () => '# Role\n',
    mcpServers: () => ({ crew_approve: { command: 'x' } }),
    sandbox: () => ({ accountDirs: ['/acct/a1'], userDataEntries: [], crewEntries: [], sockets: [], socketRoot: '/tmp/cr-501', allowedDomains: [] }),
    now: () => Date.parse('2026-11-27T12:00:00Z'), underTemp: () => false,
  };
  return { raw, db, deps, userData, root: path.join(userData, 'crew', HIRE) };
}

describe('preparing a run', () => {
  test('resolves the account, writes settings, CLAUDE.md and mcp config, and keeps tokens out of the env', async () => {
    const t = setup();
    fs.mkdirSync(path.join(t.root, 'owner', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(t.root, 'owner', '.claude', 'settings.json'), '{"hooks":{}}');
    const p = (await prepareRun(t.deps, job(), 'chat:owner')) as PreparedRun;
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

  test('a circle run works in circle/', async () => {
    const t = setup();
    const p = (await prepareRun(t.deps, job({ scope: 'circle' }), 'chat:circle')) as PreparedRun;
    expect(p.cwd).toBe(path.join(t.root, 'circle'));
  });

  test('no local account for the reference holds the hire missing', async () => {
    expect(await prepareRun(setup({ ref: { accountUuid: 'u-gone', email: 'z@x.com', label: 'Gone' } }).deps, job(), 'chat:owner')).toEqual({ hold: HOLD_MISSING });
    expect(await prepareRun(setup({ ref: null }).deps, job(), 'chat:owner')).toEqual({ hold: HOLD_MISSING });
  });

  test('a signed-out account holds the hire signed out', async () => {
    expect(await prepareRun(setup({ loggedIn: false }).deps, job(), 'chat:owner')).toEqual({ hold: HOLD_SIGNED_OUT });
    expect(await prepareRun(setup({ ships: true }).deps, job(), 'chat:owner')).toEqual({ hold: HOLD_SIGNED_OUT });
  });

  test('a hire folder under a temp dir starts nothing', async () => {
    const t = setup();
    expect(await prepareRun({ ...t.deps, underTemp: () => true }, job(), 'chat:owner')).toEqual({ hold: HOLD_SETUP });
    expect(fs.existsSync(t.root)).toBe(false);
  });

  test('a tainted thread starts a fresh session carrying its last turns, and the mark is spent', async () => {
    const t = setup();
    t.raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id, updated_at) VALUES (?, 'chat:owner', 'old', 'a1', '2026-11-27 11:00:00')`).run(HIRE);
    t.raw.query(`INSERT INTO crew_job (id, hire_id, epoch, scope, requested_by, text, state) VALUES (?, ?, 1, 'owner', ?, 'earlier ask', 'done')`).run(uuid(9), HIRE, PERSON);
    t.raw.query(`INSERT INTO crew_run (id, job_id, hire_id, thread_key, outcome, reply_text) VALUES (?, ?, ?, 'chat:owner', 'done', 'earlier answer')`).run(uuid(10), uuid(9), HIRE);
    markTainted(t.db, HIRE, 'chat:owner', 'issue-body');
    const p = (await prepareRun(t.deps, job(), 'chat:owner')) as PreparedRun;
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
    expect(await prepareRun(t.deps, job(), 'chat:owner')).toEqual({ hold: HOLD_SIGNED_OUT });
    expect(isTainted(t.db, HIRE, 'chat:owner')).toBe(true);
  });

  test('an untainted thread on the same day resumes its session', async () => {
    const t = setup();
    t.raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, account_id, updated_at) VALUES (?, 'chat:owner', 'old', 'a1', '2026-11-27 11:00:00')`).run(HIRE);
    const p = (await prepareRun(t.deps, job(), 'chat:owner')) as PreparedRun;
    expect(p.sessionId).toBe('old');
    expect(p.args.slice(0, 3)).toEqual(['-p', '--resume', 'old']);
  });
});
