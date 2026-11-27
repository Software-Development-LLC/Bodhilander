import { afterEach, describe, expect, mock, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

mock.module('electron-log', () => ({ default: { warn: () => {}, info: () => {}, error: () => {} } }));

const { McpHost, hostSocketPath, textResult } = await import('../host');
const { ServicesNotReady } = await import('../../run/services');
import type { McpServerHandler } from '../host';
import { HIRE, crewDb, uuid } from '../../__tests__/crew-db';

const RELAY = path.join(import.meta.dir, '..', '..', '..', '..', '..', 'scripts', 'crew-mcp.js');
const dirs: string[] = [];
const hosts: InstanceType<typeof McpHost>[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const echo = (label: string): McpServerHandler => ({
  tools: () => [{ name: 'echo', description: label, inputSchema: { type: 'object' } }],
  call: async (_n, args) => textResult(`${label}:${JSON.stringify(args)}`),
});

async function setup() {
  const { raw, db } = crewDb();
  const dir = fs.mkdtempSync(path.join('/tmp', 'crh-'));
  dirs.push(dir);
  const host = new McpHost(db, path.join(dir, 'm.sock'));
  hosts.push(host);
  await host.listen();
  return { raw, host };
}

function relay(socket: string, token: string, server: string, messages: unknown[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const child = spawn('node', [RELAY, server], { env: { ...process.env, CREW_MCP_SOCKET: socket }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    (child.stdio[3] as NodeJS.WritableStream).end(`${token}\n`);
    const out: Record<string, unknown>[] = [];
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c.toString();
      let cut;
      while ((cut = buf.indexOf('\n')) >= 0) {
        out.push(JSON.parse(buf.slice(0, cut)));
        buf = buf.slice(cut + 1);
        if (out.length === messages.length) {
          child.stdin.end();
          resolve(out);
        }
      }
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
}

describe('MCP host', () => {
  test('the socket lives under userData, within the sun_path limit', () => {
    expect(hostSocketPath('/Users/a/Library/Application Support/Bodhilander')).toBe('/Users/a/Library/Application Support/Bodhilander/crew/mcp.sock');
    expect(() => hostSocketPath(`/${'x'.repeat(100)}`)).toThrow('sun_path');
    expect(() => hostSocketPath(`/${'x'.repeat(100)}`)).toThrow(ServicesNotReady);
  });

  test('the relay lists and calls the registered run\'s server, end to end', async () => {
    const { host } = await setup();
    const token = host.register({ jobId: uuid(1), hireId: HIRE, servers: { approve: echo('approve'), tools: echo('tools') } });
    const out = await relay(host.socketPath, token, 'tools', [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } },
    ]);
    expect((out[1].result as { tools: { description: string }[] }).tools[0].description).toBe('tools');
    expect(out[2].result).toEqual({ content: [{ type: 'text', text: 'tools:{"a":1}' }] });
  });

  test('the relay takes its token from descriptor 3 only, never the env', () => {
    const r = spawnSync('node', [RELAY, 'tools'], { env: { ...process.env, CREW_MCP_SOCKET: '/tmp/m.sock', CREW_MCP_TOKEN: 'f'.repeat(64) }, input: '', encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('descriptor 3');
  });

  test('a wrong or retired token is refused and audited', async () => {
    const { raw, host } = await setup();
    const token = host.register({ jobId: uuid(1), hireId: HIRE, servers: { approve: echo('a'), tools: echo('t') } });
    expect(await host.answer({ token: 'f'.repeat(64), server: 'tools', op: 'list' })).toEqual({ ok: false, error: 'refused' });
    host.unregister(uuid(1));
    expect(await host.answer({ token, server: 'tools', op: 'list' })).toEqual({ ok: false, error: 'refused' });
    const n = raw.query(`SELECT COUNT(*) AS n FROM crew_audit WHERE event = 'mcp-refused'`).get() as { n: number };
    expect(n.n).toBe(2);
    const out = await relay(host.socketPath, token, 'tools', [{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo' } }]);
    expect(out[0].result).toEqual({ content: [{ type: 'text', text: 'refused' }], isError: true });
  });

  test('an unlisted tool name is an error result, never a dispatch', async () => {
    const { host } = await setup();
    const token = host.register({ jobId: uuid(1), hireId: HIRE, servers: { approve: echo('a'), tools: echo('t') } });
    const answer = await host.answer({ token, server: 'tools', op: 'call', name: 'rm' });
    expect(answer).toEqual({ ok: true, result: { content: [{ type: 'text', text: 'No tool named rm.' }], isError: true } });
    expect(await host.answer({ token, server: 'other', op: 'list' })).toEqual({ ok: false, error: 'unknown server' });
  });

  test('the socket is 0600', async () => {
    const { host } = await setup();
    expect(fs.statSync(host.socketPath).mode & 0o777).toBe(0o600);
  });

  test('a failed listen is not kept: the next ready() listens again', async () => {
    const { db } = crewDb();
    const dir = fs.mkdtempSync(path.join('/tmp', 'crh-'));
    dirs.push(dir);
    const blocker = path.join(dir, 'sub');
    fs.writeFileSync(blocker, 'not a directory');
    const host = new McpHost(db, path.join(blocker, 'm.sock'));
    hosts.push(host);
    expect(await host.ready()).toBe(false);
    fs.rmSync(blocker);
    expect(await host.ready()).toBe(true);
    expect(fs.statSync(host.socketPath).isSocket()).toBe(true);
    expect(await host.ready()).toBe(true);
  });
});
