import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { APPROVE_SERVER, TOOLS_SERVER, crewMcpServers } from '../mcp-config';

// Runs inside WSL2 on Windows, never natively, so native Windows CI skips it.
const posixOnly = test.skipIf(process.platform === 'win32');

const TOKEN = 'a'.repeat(64);
const GATEWAY = 'b'.repeat(64);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

type Server = { command: string; args: string[]; env: Record<string, string> };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crmc-'));
  dirs.push(dir);
  const tokenFile = path.join(dir, 'mcp-owner.token');
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const probe = path.join(dir, 'probe.js');
  fs.writeFileSync(probe, "process.stdout.write(JSON.stringify({ env: process.env, argv: process.argv.slice(2), fd3: require('fs').readFileSync(3, 'utf8') }))");
  const servers = crewMcpServers({ execPath: process.execPath, script: probe, socket: '/tmp/m.sock', tokenFile });
  return { servers, tokenFile };
}

describe('the MCP relay registration', () => {
  test('the config names no token: neither the command, its args nor its env carry it', () => {
    const { servers } = fixture();
    for (const name of [APPROVE_SERVER, TOOLS_SERVER]) {
      const s = servers[name] as Server;
      expect(JSON.stringify(s)).not.toContain(TOKEN);
      expect(s.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', CREW_MCP_SOCKET: '/tmp/m.sock' });
    }
  });

  posixOnly('the relay gets the MCP token on descriptor 3, and its env holds neither token though the run env had both', () => {
    const { servers } = fixture();
    const s = servers[TOOLS_SERVER] as Server;
    const r = spawnSync(s.command, s.args, { env: { ...process.env, CREW_GH_TOKEN: GATEWAY, CREW_MCP_TOKEN: TOKEN, ...s.env }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const seen = JSON.parse(r.stdout) as { env: Record<string, string>; argv: string[]; fd3: string };
    expect(seen.fd3).toBe(TOKEN);
    expect(seen.argv).toEqual(['tools']);
    const env = JSON.stringify(seen.env);
    expect(env).not.toContain(TOKEN);
    expect(env).not.toContain(GATEWAY);
    expect(seen.env.CREW_MCP_SOCKET).toBe('/tmp/m.sock');
  });
});
