import { describe, expect, mock, test } from 'bun:test';
import type { Duplex } from 'stream';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { WslRuns, wslAccountDir, WSL_MCP_RELAY } = await import('../wsl-run');
const { CrewSignIn } = await import('../crew-token');
const { HOLD_SETUP, HOLD_SIGNED_OUT } = await import('../run/prepare');
const { SteeringUnavailable } = await import('../handbook');
import type { SkillFile } from '../protocol';
import type { ClaudeAccount } from '../../../shared/types';
import type { CrewJob, PreparedRun } from '../run/loop';
import type { AgentChild } from '../wsl-agent';
import type { WslExec } from '../wsl';
import { HIRE, PERSON, crewDb, uuid } from './crew-db';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const TOKEN = `sk-ant-oat01-${'a'.repeat(80)}`;
const job = (over: Partial<CrewJob> = {}): CrewJob => ({
  id: uuid(1), hireId: HIRE, kind: 'message', epoch: 1, scope: 'owner', requestedBy: PERSON, sender: 'B', text: 'do the thing', attempts: 1, ...over,
});

class FakeAgent implements AgentChild {
  sent: Array<Record<string, unknown>> = [];
  killed = false;
  private lines: Array<(l: string) => void> = [];
  private closers: Array<() => void> = [];
  constructor(private readonly version: string, private readonly answer: 'ready' | 'socket-root' = 'ready') {
    queueMicrotask(() => this.emit({ t: 'hello', version: this.version }));
  }
  write(line: string) {
    const f = JSON.parse(line);
    this.sent.push(f);
    if (f.t !== 'serve') return;
    if (this.answer === 'socket-root') return this.emit({ t: 'error', code: 'socket-root', observed: { type: 'symlink', uid: 0, mode: '777' } });
    const dir = `/tmp/cr-1000/${f.name}`;
    this.emit({ t: 'ready', dir, sockets: { gh: `${dir}/gh.sock`, mcp: `/tmp/cr-1000/p-${f.name}/mcp.sock` } });
  }
  onLine(cb: (l: string) => void) { this.lines.push(cb); }
  onClose(cb: () => void) { this.closers.push(cb); }
  kill() { this.killed = true; }
  emit(f: Record<string, unknown>) { for (const cb of this.lines) cb(JSON.stringify(f)); }
}

function setup(opts: { mode?: 'login' | 'token'; parent?: string; agentVersion?: string; broker?: boolean; agentAnswer?: 'ready' | 'socket-root'; signedIn?: boolean; timeZone?: string; skills?: () => SkillFile[]; handbook?: (hireId: string) => string } = {}) {
  const { raw, db } = crewDb();
  raw.query(`INSERT INTO claude_accounts (id, label, config_dir, email) VALUES ('a1', 'Work Max', 'C:\\\\acct\\\\a1', 'b@x.com')`).run();
  raw.query(`INSERT INTO crew_hire_cache (hire_id, rev, data) VALUES (?, 1, ?)`).run(HIRE, JSON.stringify({ accountRef: { accountUuid: 'u-a1', email: 'b@x.com', label: 'Work Max' } }));
  const cipher = { isEncryptionAvailable: () => true, encryptString: (p: string) => Buffer.from(p), decryptString: (b: Buffer) => b.toString() };
  const signIn = new CrewSignIn(db, cipher, opts.mode === 'token');
  if (opts.mode === 'token') signIn.storeToken('a1', TOKEN, () => true, NOW);
  else if (opts.signedIn !== false) signIn.recordSignIn('a1', NOW);
  const accounts = [{ id: 'a1', label: 'Work Max', configDir: 'C:\\acct\\a1', email: 'b@x.com' } as ClaudeAccount];
  const scripts: string[] = [];
  const writes = new Map<string, string>();
  const exec: WslExec = async (args, o) => {
    const script = String(args[args.length - 1]);
    const dest = /mv -f \S+ (\S+)$/.exec(script)?.[1];
    if (dest) writes.set(dest, String(o?.input ?? ''));
    return { code: 0, stdout: '', stderr: '' };
  };
  const sh = async (script: string) => {
    scripts.push(script);
    if (script.startsWith('p=/tmp/crt-1000')) return { code: 0, stdout: `PARENT ${opts.parent ?? 'directory|1000|300'}\nMADE\n`, stderr: '' };
    if (script.startsWith('test -s')) return { code: opts.signedIn === false ? 1 : 0, stdout: '', stderr: '' };
    if (script.includes('printf')) return { code: 0, stdout: '/home/crew\n/home/other\n/home/crew/.bodhilander\n/home/crew/.bodhilander/crew\n/home/crew/.bodhilander/crew/hires\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const recorded = new Set<string>();
  const records = { add: (n: string) => void recorded.add(n), remove: (n: string) => void recorded.delete(n), list: () => [...recorded] };
  const agents: FakeAgent[] = [];
  const gatewayConns: Array<{ token: string; conn: Duplex }> = [];
  const hostConns: Duplex[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const lost: string[] = [];
  const reinstalls: number[] = [];
  const runs = new WslRuns({
    db, signIn, accounts: () => accounts, exec, sh, records,
    host: { register: (r) => (registered.push(r.jobId), 'mcp-token-1'), unregister: (id) => void unregistered.push(id), accept: (c) => void hostConns.push(c) },
    gateway: { accept: (r, c) => void gatewayConns.push({ token: r.token, conn: c }) },
    broker: () => (opts.broker === false ? null : ({ handler: () => ({}) } as never)),
    tools: () => ({}) as never,
    repos: () => ['org/repo'],
    agentVersion: '1.0.0',
    spawnAgent: () => {
      const a = new FakeAgent(opts.agentVersion ?? '1.0.0', opts.agentAnswer);
      agents.push(a);
      return a;
    },
    reinstallAgent: async () => (reinstalls.push(1), true),
    onLost: (h) => void lost.push(h),
    handbook: opts.handbook ?? (() => '# Role\n'),
    skills: opts.skills ?? (() => []),
    timeZone: () => opts.timeZone ?? 'UTC',
    now: () => NOW,
  });
  return { raw, runs, scripts, writes, recorded, agents, gatewayConns, hostConns, registered, unregistered, lost, reinstalls };
}

describe('a run prepared inside BodhiCrew', () => {
  test('launches through wsl.exe exec-run with posix paths, its own TMPDIR, and the token only on the first stdin line', async () => {
    const t = setup({ mode: 'token' });
    const p = (await t.runs.prepare(job(), 'chat:owner', 'run-1')) as PreparedRun;
    expect(p.command).toBe('wsl.exe');
    expect(p.args).toEqual(['-d', 'BodhiCrew', '-u', 'crew', '--', '/home/crew/.bodhilander/crew/bin/crew-agent', 'exec-run']);
    expect(p.token).toBeNull();
    const [tokenLine, header, ...prompt] = p.input.split('\n');
    expect(tokenLine).toBe(TOKEN);
    expect(prompt.join('\n')).toBe('do the thing');
    const run = JSON.parse(header) as { cwd: string; env: Record<string, string>; argv: string[] };
    expect(run.cwd).toBe(`/home/crew/.bodhilander/crew/hires/${HIRE}/owner`);
    expect(run.argv[0]).toBe('/home/crew/.bodhilander/crew/bin/claude');
    expect(run.env.CLAUDE_CONFIG_DIR).toBe(wslAccountDir('a1'));
    expect(run.env.TMPDIR).toMatch(/^\/tmp\/crt-1000\/[0-9a-f]{32}$/);
    expect(run.env.CLAUDE_CODE_TMPDIR).toBe(run.env.TMPDIR);
    expect(run.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBe('3');
    expect(t.recorded.has(run.env.TMPDIR.split('/').pop() as string)).toBe(true);
    expect(JSON.stringify({ args: p.args, env: p.env, header })).not.toContain(TOKEN);
    expect(Object.keys(p.env)).not.toContain('WSLENV');
  });

  test('writes the WSL2 settings and an MCP config whose relay reaches the private mcp socket', async () => {
    const t = setup();
    const p = (await t.runs.prepare(job(), 'chat:owner', 'run-1')) as PreparedRun;
    const header = JSON.parse(p.input.split('\n')[1]) as { argv: string[] };
    const settingsPath = header.argv[header.argv.indexOf('--settings') + 1];
    const settings = JSON.parse(t.writes.get(settingsPath) as string);
    expect(settings.sandbox.filesystem.denyRead).toContain('/home');
    expect(settings.sandbox.filesystem.allowRead.some((x: string) => x.startsWith('/tmp/cr-1000/'))).toBe(true);
    expect(settings.sandbox.filesystem.allowRead.some((x: string) => x.includes('/p-'))).toBe(false);
    expect(JSON.stringify(settings.permissions.deny)).toContain('/home/other');
    const mcp = JSON.parse(t.writes.get(header.argv[header.argv.indexOf('--mcp-config') + 1]) as string);
    expect(mcp.mcpServers.crew_approve.args[0]).toBe(WSL_MCP_RELAY);
    expect(mcp.mcpServers.crew_approve.env.CREW_MCP_SOCKET).toMatch(/^\/tmp\/cr-1000\/p-[a-z2-7]+\/mcp\.sock$/);
    expect(t.writes.get(`/home/crew/.bodhilander/crew/hires/${HIRE}/owner/CLAUDE.md`)).toBe('# Role\n');
  });

  test('relayed connections reach the gateway with this run’s token and the MCP host', async () => {
    const t = setup();
    const p = (await t.runs.prepare(job(), 'chat:owner', 'run-1')) as PreparedRun;
    const env = (JSON.parse(p.input.split('\n')[1]) as { env: Record<string, string> }).env;
    const a = t.agents[0];
    a.emit({ t: 'open', conn: 1, sock: 'gh' });
    a.emit({ t: 'open', conn: 2, sock: 'mcp' });
    a.emit({ t: 'open', conn: 3, sock: 'broker' });
    expect(t.gatewayConns.map((c) => c.token)).toEqual([env.CREW_GH_TOKEN]);
    expect(t.hostConns).toHaveLength(1);
    expect(a.sent.at(-1)).toEqual({ t: 'end', conn: 3 });
  });

  test('a bad TMPDIR parent holds setup before any agent starts, and records nothing', async () => {
    const t = setup({ parent: 'symbolic link|0|777' });
    expect(await t.runs.prepare(job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    expect(t.agents).toHaveLength(0);
    expect(t.recorded.size).toBe(0);
    expect(t.unregistered).toContain(uuid(1));
  });

  test('an agent version mismatch reinstalls once, then holds setup and cleans up', async () => {
    const t = setup({ agentVersion: '0.9.0' });
    expect(await t.runs.prepare(job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    expect(t.reinstalls).toEqual([1]);
    expect(t.agents).toHaveLength(2);
    expect(t.agents.every((a) => a.killed)).toBe(true);
    await Promise.resolve();
    expect(t.scripts.some((s) => s.startsWith('rm -rf /tmp/crt-1000/'))).toBe(true);
  });

  test('a socket root the agent refuses holds setup', async () => {
    const t = setup({ agentAnswer: 'socket-root' });
    expect(await t.runs.prepare(job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
  });

  test('ending a run stops its agent, retires the MCP token and removes the TMPDIR', async () => {
    const t = setup();
    const p = (await t.runs.prepare(job(), 'chat:owner', 'run-1')) as PreparedRun;
    const name = ((JSON.parse(p.input.split('\n')[1]) as { env: Record<string, string> }).env.TMPDIR).split('/').pop() as string;
    expect(t.runs.liveTmpNames()).toEqual(new Set([name]));
    t.runs.end(uuid(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(t.agents[0].killed).toBe(true);
    expect(t.unregistered).toContain(uuid(1));
    expect(t.recorded.has(name)).toBe(false);
    expect(t.runs.liveTmpNames().size).toBe(0);
  });

  test('a signed-out account or a missing broker holds before anything is made in the distro', async () => {
    const t = setup({ signedIn: false });
    expect(await t.runs.prepare(job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SIGNED_OUT });
    expect(t.scripts).toEqual([`test -s '${wslAccountDir('a1')}/.credentials.json'`]);
    const u = setup({ broker: false });
    expect(await u.runs.prepare(job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    expect(u.scripts.every((s) => s.startsWith('test -s'))).toBe(true);
  });

  test("the hire's handbook is the cwd's CLAUDE.md and its pinned skills replace the hire's skills dir", async () => {
    const t = setup({ handbook: (id) => `# Handbook for ${id}\n`, skills: () => [{ path: 'triage.md', content: '# Triage\n' }, { path: 'board/read.md', content: '# Board\n' }] });
    await t.runs.prepare(job(), 'chat:owner', 'run-1');
    const H = `/home/crew/.bodhilander/crew/hires/${HIRE}`;
    expect(t.writes.get(`${H}/owner/CLAUDE.md`)).toBe(`# Handbook for ${HIRE}\n`);
    expect(t.writes.get(`${H}/skills/triage.md`)).toBe('# Triage\n');
    expect(t.writes.get(`${H}/skills/board/read.md`)).toBe('# Board\n');
    expect(t.scripts.some((s) => /rm -rf .*'[^']*\/skills' && mkdir -p '[^']*\/skills'/.test(s) && s.includes(`'${H}/skills'`))).toBe(true);
    expect(t.writes.get(`${H}/git/gitconfig`)).toContain('excludesFile = /dev/null');
  });

  test('a skill path that leaves the skills dir is refused', async () => {
    const t = setup({ skills: () => [{ path: '../owner/CLAUDE.md', content: 'x' }] });
    expect(await t.runs.prepare(job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
  });

  test('steering the Hub has not synced holds setup before any agent starts', async () => {
    const t = setup({ handbook: () => { throw new SteeringUnavailable('the role has not synced'); } });
    expect(await t.runs.prepare(job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    expect(t.agents).toHaveLength(0);
    const u = setup({ skills: () => { throw new SteeringUnavailable('no bundle'); } });
    expect(await u.runs.prepare(job(), 'chat:owner', 'run-1')).toEqual({ hold: HOLD_SETUP });
    expect(u.agents).toHaveLength(0);
  });

  test("the machine's time zone decides whether the thread's session is resumed", async () => {
    const resumed = async (timeZone: string) => {
      const t = setup({ timeZone });
      t.raw.query(`INSERT INTO crew_thread (hire_id, thread_key, session_id, updated_at) VALUES (?, 'chat:owner', 's-1', '2026-11-27 01:00:00')`).run(HIRE);
      const p = (await t.runs.prepare(job(), 'chat:owner', 'run-1')) as PreparedRun;
      return p.sessionId;
    };
    expect(await resumed('UTC')).toBe('s-1');
    expect(await resumed('America/Los_Angeles')).toBeNull();
  });

  test('the run reads its own git config, never the global one', async () => {
    const t = setup();
    const p = (await t.runs.prepare(job(), 'chat:owner', 'run-1')) as PreparedRun;
    const run = JSON.parse(p.input.split('\n')[1]) as { env: Record<string, string> };
    expect(run.env.GIT_CONFIG_GLOBAL).toBe(`/home/crew/.bodhilander/crew/hires/${HIRE}/git/gitconfig`);
  });

  test('an account id that is not a plain id is never turned into a distro path', () => {
    expect(() => wslAccountDir('../root')).toThrow();
  });
});
