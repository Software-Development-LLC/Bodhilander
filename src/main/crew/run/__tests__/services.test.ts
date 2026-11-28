import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { RunServiceManager } = await import('../services');
const { McpHost, textResult } = await import('../../mcp/host');
const { GithubGateway } = await import('../../gateway/github-gateway');
const { ApproveBroker } = await import('../../approve/broker');
import type { CrewJob } from '../loop';
import type { SocketFs } from '../sockets';
import { HIRE, PERSON, crewDb, uuid } from '../../__tests__/crew-db';

// Runs inside WSL2 on Windows, never natively, so native Windows CI skips it.
const posixOnly = test.skipIf(process.platform === 'win32');

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const job: CrewJob = { id: uuid(1), hireId: HIRE, kind: 'message', epoch: 1, scope: 'owner', requestedBy: PERSON, sender: 'B', text: 'x', attempts: 1 };

/** The real fs, with the socket root moved under a fresh /tmp directory. */
function rootedFs(base: string): SocketFs {
  const at = (p: string) => p.replace(/^\/tmp\/cr-\d+/, base);
  return {
    lstatSync: (p) => fs.lstatSync(at(p)),
    mkdirSync: (p, o) => fs.mkdirSync(at(p), o),
    chmodSync: (p, m) => fs.chmodSync(at(p), m),
    rmSync: (p, o) => fs.rmSync(at(p), o),
  };
}

function setup() {
  const { db } = crewDb();
  const base = fs.mkdtempSync('/tmp/crs-');
  made.push(base);
  fs.rmSync(base, { recursive: true });
  const host = new McpHost(db, path.join('/tmp', `crs-h-${process.pid}.sock`));
  const gateway = new GithubGateway({ db, requestToken: () => false, run: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const listened: string[] = [];
  gateway.listen = async (p) => void listened.push(p);
  const broker = new ApproveBroker({ db, raiseCard: () => true, park: () => {} });
  const manager = new RunServiceManager({
    host, broker: () => broker, tools: () => ({ tools: () => [], call: async () => textResult('') }), gateway, repos: () => ['acme/app'],
    uid: process.getuid!(), execPath: '/app/electron', relayScript: '/app/crew-mcp.js', shimDir: '/app/gh-shim', fsx: rootedFs(base),
  });
  return { host, manager, listened, base };
}

describe('run services', () => {
  posixOnly('a run gets a private 0700 directory, its gateway socket, the MCP relay and the shim env; all of it ends with the run', async () => {
    const t = setup();
    const s = await t.manager.start(job, 'chat:owner', 'run-1');
    const uid = process.getuid!();
    expect(s.sockets).toHaveLength(1);
    expect(s.sockets[0]).toMatch(new RegExp(`^/tmp/cr-${uid}/[a-z2-7]{8}/gh.sock$`));
    expect(t.listened).toEqual(s.sockets);
    const dir = path.join(t.base, path.basename(path.dirname(s.sockets[0])));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(t.base).mode & 0o777).toBe(0o700);
    const approve = s.mcpServers('/run/mcp-owner.token').crew_approve as { command: string; args: string[]; env: Record<string, string> };
    expect(approve.args.slice(2)).toEqual(['/app/electron', '/app/crew-mcp.js', 'approve', '/run/mcp-owner.token']);
    expect(approve.env.CREW_MCP_SOCKET).toBe(t.host.socketPath);
    expect(s.mcpToken).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(approve)).not.toContain(s.mcpToken);
    expect(s.env).toMatchObject({ CREW_GH_SOCKET: s.sockets[0], CREW_NODE: '/app/electron', CREW_GH_SHIM_JS: '/app/gh-shim/gh-shim.js' });
    expect(s.env.CREW_GH_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(s.env.CREW_GH_TOKEN).not.toBe(s.mcpToken);
    expect(t.host.registered(job.id)).toBe(true);
    t.manager.end(job.id);
    expect(t.host.registered(job.id)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(t.base)).toBe(true);
  });

  posixOnly('two runs of one job in a row get different directories', async () => {
    const t = setup();
    const a = await t.manager.start(job, 'chat:owner', 'run-1');
    const b = await t.manager.start({ ...job, id: uuid(2) }, 'chat:owner', 'run-2');
    expect(path.dirname(a.sockets[0])).not.toBe(path.dirname(b.sockets[0]));
    t.manager.endAll();
  });
});
