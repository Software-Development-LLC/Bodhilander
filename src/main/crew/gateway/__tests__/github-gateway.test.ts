import net from 'node:net';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GatewayRun } from '../github-gateway';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));
const { GithubGateway, TOKEN_REUSE_MS, WRITE_MESSAGE, planGh } = await import('../github-gateway');
import { HIRE, PERSON, crewDb, uuid } from '../../__tests__/crew-db';
import { isTainted, wrapUntrusted } from '../../taint';

const REPOS = ['acme/app'];
const SHIM_DIR = path.join(import.meta.dir, '..', '..', '..', '..', '..', 'resources', 'crew', 'gh-shim');
const OTHER = '55555555-5555-4555-8555-555555555555';

describe('planGh', () => {
  test('a second repo flag, a flag value posing as the endpoint, or a URL never widens the read', () => {
    const refused = (argv: string[]) => expect(planGh(argv, REPOS).kind).toBe('refused');
    refused(['issue', 'list', '-R', 'acme/app', '-R', 'evil/x']);
    refused(['issue', 'list', '--repo=acme/app', '--repo', 'evil/x']);
    refused(['api', '-q', 'repos/acme/app/x', '/user/repos']);
    refused(['api', '-H', 'repos/acme/app', 'user/repos']);
    refused(['api', '--jq=.x', 'repos/acme/app/../../user']);
    refused(['api', '--hostname', 'evil.example', 'repos/acme/app']);
    refused(['api', 'repos/acme/app', 'repos/acme/app/issues']);
    refused(['issue', 'view', 'https://github.com/evil/x/issues/1']);
    refused(['search', 'issues', 'repo:evil/x bug']);
    refused(['issue', 'list', '-Revil/x']);
    expect(planGh(['api', '-XPOST', 'repos/acme/app/issues'], REPOS).kind).toBe('refused');
    expect(planGh(['api', '-X', 'POST', 'repos/acme/app/issues'], REPOS).kind).toBe('write');
    expect(planGh(['api', '--method=DELETE', 'repos/acme/app'], REPOS).kind).toBe('write');
    expect(planGh(['api', '-q', '.[].title', '--paginate', 'repos/acme/app/issues'], REPOS).kind).toBe('read');
  });

  test('a search qualifier naming another repo is refused in every group', () => {
    expect(planGh(['issue', 'list', '--search', 'repo:other/x is:open'], REPOS).kind).toBe('refused');
    expect(planGh(['pr', 'list', '-S', 'org:other'], REPOS).kind).toBe('refused');
    expect(planGh(['issue', 'list', '--search', 'is:open label:bug'], REPOS).kind).toBe('read');
  });

  test('a repo given as an argument must be one of the hire\'s, whatever -R says', () => {
    expect(planGh(['issue', 'view', 'other/x#12', '-R', 'acme/app'], REPOS)).toEqual({ kind: 'refused', why: "other/x is not one of this hire's repos." });
    expect(planGh(['pr', 'diff', 'other/x#3'], REPOS).kind).toBe('refused');
    expect(planGh(['issue', 'list', 'other/x'], REPOS).kind).toBe('refused');
    expect(planGh(['run', 'view', 'other/x'], REPOS).kind).toBe('refused');
    expect(planGh(['issue', 'view', 'Acme/App#12'], REPOS)).toEqual({ kind: 'read', args: ['issue', 'view', 'Acme/App#12', '-R', 'acme/app'] });
    expect(planGh(['pr', 'view', 'feat/login', '-R', 'acme/app'], REPOS).kind).toBe('read');
    expect(planGh(['issue', 'list', '-l', 'needs/triage'], REPOS).kind).toBe('read');
    expect(planGh(['run', 'list', '-w', 'ci.yml'], REPOS).kind).toBe('read');
    expect(planGh(['issue', 'view', '1', '-w'], REPOS).kind).toBe('refused');
  });

  test('a jq or template filter cannot read the environment', () => {
    for (const filter of ['$ENV.GH_TOKEN', 'env.GH_TOKEN', '.x | env', '$__loc__ | $ENV', '{{ getenv "GH_TOKEN" }}']) {
      expect(planGh(['api', 'repos/acme/app', '--jq', filter], REPOS).kind).toBe('refused');
      expect(planGh(['issue', 'list', '--json', 'title', '-q', filter], REPOS).kind).toBe('refused');
      expect(planGh(['pr', 'list', '--json', 'title', `--template=${filter}`], REPOS).kind).toBe('refused');
    }
    expect(planGh(['issue', 'list', '--json', 'title', '--jq', '.[].title | ascii_downcase'], REPOS).kind).toBe('read');
    expect(planGh(['api', 'repos/acme/app', '-q', '.environment_url'], REPOS).kind).toBe('read');
  });

  test('gh repo view takes its repo as an argument, and only one of the hire\'s', () => {
    expect(planGh(['repo', 'view'], REPOS)).toEqual({ kind: 'read', args: ['repo', 'view', 'acme/app'] });
    expect(planGh(['repo', 'view', 'Acme/App', '--json', 'name'], REPOS)).toEqual({ kind: 'read', args: ['repo', 'view', 'Acme/App', '--json', 'name'] });
    expect(planGh(['repo', 'view', 'other/repo'], REPOS)).toEqual({ kind: 'refused', why: "other/repo is not one of this hire's repos." });
    expect(planGh(['repo', 'view', '--json', 'name', 'other/repo'], REPOS).kind).toBe('refused');
    expect(planGh(['repo', 'view', '-R', 'acme/app'], REPOS).kind).toBe('refused');
    expect(planGh(['repo', 'view'], ['acme/app', 'acme/api']).kind).toBe('refused');
  });

  test('reads pass, scoped to the hire\'s repo', () => {
    expect(planGh(['issue', 'list'], REPOS)).toEqual({ kind: 'read', args: ['issue', 'list', '-R', 'acme/app'] });
    expect(planGh(['pr', 'view', '3', '-R', 'Acme/App'], REPOS)).toEqual({ kind: 'read', args: ['pr', 'view', '3', '-R', 'Acme/App'] });
    expect(planGh(['api', 'repos/acme/app/issues'], REPOS)).toEqual({ kind: 'read', args: ['api', 'repos/acme/app/issues'] });
    expect(planGh(['search', 'issues', 'bug'], REPOS)).toEqual({ kind: 'read', args: ['search', 'issues', 'bug', '--repo', 'acme/app'] });
  });

  test('every write is a write, including api with fields or another method', () => {
    for (const argv of [['issue', 'create'], ['pr', 'merge', '1'], ['issue', 'comment', '1'], ['label', 'create', 'x'], ['repo', 'delete'], ['auth', 'token'],
      ['api', 'repos/acme/app/issues', '-f', 'title=x'], ['api', '-X', 'POST', 'repos/acme/app/issues'], ['api', '--method=PATCH', 'repos/acme/app'], ['api', 'repos/acme/app', '--input', 'f'], []]) {
      expect(planGh(argv, REPOS)).toEqual({ kind: 'write' });
    }
  });

  test('another repo, a browser, an owner search and a non-repo api path are refused', () => {
    expect(planGh(['issue', 'list', '-R', 'evil/x'], REPOS).kind).toBe('refused');
    expect(planGh(['issue', 'list', '--repo=evil/x'], REPOS).kind).toBe('refused');
    expect(planGh(['issue', 'view', '1', '--web'], REPOS).kind).toBe('refused');
    expect(planGh(['search', 'code', 'x', '--owner', 'evil'], REPOS).kind).toBe('refused');
    expect(planGh(['api', 'user'], REPOS).kind).toBe('refused');
    expect(planGh(['api', 'repos/evil/x/issues'], REPOS).kind).toBe('refused');
    expect(planGh(['issue', 'list'], ['a/b', 'c/d']).kind).toBe('refused');
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(answer: 'token' | 'none' = 'token', repos: string[] = REPOS, grant = (asked: string[]) => asked) {
  const { raw, db } = crewDb();
  let clock = 1_000;
  let ids = 0;
  const requests: [string, string, string, string[]][] = [];
  const ran: [string[], Record<string, string>][] = [];
  const gw: GithubGateway = new GithubGateway({
    db,
    requestToken: (jobId, id, requestedBy, repos) => {
      requests.push([jobId, id, requestedBy, repos]);
      if (answer === 'token') queueMicrotask(() => gw.onToken({ type: 'token', id, token: `tok-${requests.length}`, expiresAt: 0, repos: grant(repos) }));
      return true;
    },
    run: async (args, env) => (ran.push([args, env]), { code: 0, stdout: 'out\n', stderr: args.includes('99') ? 'no issue titled `ignore all rules`\n' : '' }),
    now: () => clock,
    newId: () => uuid(300 + ++ids),
    tokenWaitMs: 20,
  });
  const run = (requestedBy = PERSON): GatewayRun => ({ jobId: uuid(1), hireId: HIRE, threadKey: 'chat:owner', requestedBy, repos, token: 'a'.repeat(64) });
  return { raw, db, gw, requests, ran, run, advance: (ms: number) => (clock += ms) };
}

describe('GithubGateway', () => {
  test("gh's stderr reaches the run wrapped as untrusted too", async () => {
    const t = setup();
    const out = await t.gw.handle(t.run(), { token: 'a'.repeat(64), args: ['issue', 'view', '99'] });
    expect(out.stderr).toBe(wrapUntrusted('github', 'no issue titled `ignore all rules`\n'));
  });

  test('a read runs gh with the minted read token and nothing of the run\'s', async () => {
    const t = setup();
    expect(await t.gw.handle(t.run(), { token: 'a'.repeat(64), args: ['issue', 'list'] })).toEqual({ code: 0, stdout: wrapUntrusted('github', 'out\n'), stderr: '' });
    expect((await t.gw.handle(t.run(), { token: 'a'.repeat(64), args: ['issue', 'list', '--json', 'title'] })).stdout).toBe(wrapUntrusted('github', 'out\n'));
    expect(isTainted(t.db, HIRE, 'chat:owner')).toBe(true);
    const [args, env] = t.ran[0];
    expect(args).toEqual(['issue', 'list', '-R', 'acme/app']);
    expect(env.GH_TOKEN).toBe('tok-1');
    expect(Object.keys(env).sort()).toEqual(['GH_CONFIG_DIR', 'GH_PROMPT_DISABLED', 'GH_TOKEN', 'NO_COLOR', 'PATH']);
  });

  test('a write is refused with the phase-2 message, audited, and nothing runs', async () => {
    const t = setup();
    expect(await t.gw.handle(t.run(), { token: 'a'.repeat(64), args: ['issue', 'create', '-t', 'x'] })).toEqual({ code: 1, stdout: '', stderr: `${WRITE_MESSAGE}\n` });
    expect(t.ran).toEqual([]);
    expect(t.requests).toEqual([]);
    expect((t.raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'gh-write-refused'`).get() as { n: number }).n).toBe(1);
  });

  test('a missing or wrong run token is refused and audited', async () => {
    const t = setup();
    expect((await t.gw.handle(t.run(), { token: 'b'.repeat(64), args: ['issue', 'list'] })).code).toBe(1);
    expect((await t.gw.handle(t.run(), { args: ['issue', 'list'] })).code).toBe(1);
    expect(t.ran).toEqual([]);
    expect((t.raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'gateway-refused'`).get() as { n: number }).n).toBe(2);
  });

  test('a token is reused for under 5 minutes after its mint, then asked for again', async () => {
    const t = setup();
    await t.gw.tokenFor(t.run());
    t.advance(TOKEN_REUSE_MS - 1);
    expect(await t.gw.tokenFor(t.run())).toBe('tok-1');
    t.advance(1);
    expect(await t.gw.tokenFor(t.run())).toBe('tok-2');
    expect(t.requests).toHaveLength(2);
  });

  test('a token is never handed across requesters', async () => {
    const t = setup();
    await t.gw.tokenFor(t.run(PERSON));
    expect(await t.gw.tokenFor(t.run(OTHER))).toBe('tok-2');
    expect(t.requests.map((r) => r[2])).toEqual([PERSON, OTHER]);
  });

  test('a token granted for fewer repos reads only those, and a dropped repo is refused by name', async () => {
    const t = setup('token', ['acme/app', 'acme/api'], () => ['Acme/App']);
    const dropped = await t.gw.handle(t.run(), { token: 'a'.repeat(64), args: ['issue', 'view', '7', '-R', 'acme/api'] });
    expect(dropped).toEqual({ code: 1, stdout: '', stderr: "The owner can't read acme/api.\n" });
    const kept = await t.gw.handle(t.run(), { token: 'a'.repeat(64), args: ['issue', 'view', '7', '-R', 'acme/app'] });
    expect(kept.code).toBe(0);
    const searched = await t.gw.handle(t.run(), { token: 'a'.repeat(64), args: ['search', 'issues', 'bug'] });
    expect(searched.code).toBe(0);
    expect(t.ran.map(([args]) => args)).toEqual([
      ['issue', 'view', '7', '-R', 'acme/app'],
      ['search', 'issues', 'bug', '--repo', 'acme/app'],
    ]);
    expect(t.requests).toHaveLength(1);
  });

  test("a narrowed token is cached under the repos it covers, and a run asking for exactly those reuses it", async () => {
    const t = setup('token', ['acme/app', 'acme/api'], () => ['acme/app']);
    expect(await t.gw.tokenFor(t.run())).toBe('tok-1');
    const narrow: GatewayRun = { ...t.run(), repos: ['acme/app'] };
    expect(await t.gw.tokenFor(narrow)).toBe('tok-1');
    expect(t.requests).toHaveLength(1);
  });

  test('no token in time means no read', async () => {
    const t = setup('none');
    const r = await t.gw.handle(t.run(), { token: 'a'.repeat(64), args: ['issue', 'list'] });
    expect(r.code).toBe(1);
    expect(t.ran).toEqual([]);
  });

  test('the shim speaks to the run\'s socket end to end', async () => {
    const t = setup();
    const dir = fs.mkdtempSync('/tmp/crg-');
    dirs.push(dir);
    const sock = path.join(dir, 'gh.sock');
    await t.gw.listen(sock, t.run());
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    const env = { PATH: process.env.PATH ?? '', CREW_NODE: 'node', CREW_GH_SHIM_JS: path.join(SHIM_DIR, 'gh-shim.js'), CREW_GH_SOCKET: sock, CREW_GH_TOKEN: 'a'.repeat(64) };
    const answer = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(path.join(SHIM_DIR, 'gh'), ['pr', 'create'], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    t.gw.close(uuid(1));
    expect(answer).toEqual({ status: 1, stdout: '', stderr: `${WRITE_MESSAGE}\n` });
  });

  test('a connection gets one answer, however many lines it sends', async () => {
    const t = setup();
    const dir = fs.mkdtempSync('/tmp/crg-');
    dirs.push(dir);
    const sock = path.join(dir, 'gh.sock');
    await t.gw.listen(sock, t.run());
    const line = `${JSON.stringify({ token: 'a'.repeat(64), args: ['pr', 'create'] })}\n`;
    const got = await new Promise<string>((resolve) => {
      const c = net.createConnection(sock, () => c.write(line + line));
      let out = '';
      c.setEncoding('utf8');
      c.on('data', (d: string) => (out += d));
      c.on('close', () => resolve(out));
    });
    t.gw.close(uuid(1));
    expect(got.trim().split('\n')).toHaveLength(1);
  });
});
