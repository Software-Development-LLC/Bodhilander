/**
 * Packs the real extension into a temp directory, unpacks it with the mcpb
 * package's own reader, and speaks MCP to the unpacked server under node.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unpackExtension } from '@anthropic-ai/mcpb';
import { buildMcpb } from '../build-mcpb';

const root = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let work: string;
let unpacked: string;

function listFiles(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
}

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-mcpb-'));
  const out = await buildMcpb(root, path.join(work, 'out'));
  unpacked = path.join(work, 'unpacked');
  expect(await unpackExtension({ mcpbPath: out, outputDir: unpacked, silent: true })).toBe(true);
}, 120_000);

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe('bodhilander.mcpb', () => {
  test('holds the manifest, the icon and one bundled server, and no node_modules', () => {
    expect(listFiles(unpacked).sort()).toEqual(['icon.png', 'manifest.json', 'server/index.js']);
  });

  test('its manifest carries the app version', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(pkg.version);
  });

  test('the unpacked server answers MCP under node, with only node built-ins', () => {
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ];
    const run = spawnSync('node', [path.join(unpacked, 'server', 'index.js')], {
      input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(run.status).toBe(0);
    const [init, list] = run.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(init.result.serverInfo).toEqual({ name: 'bodhilander', version: pkg.version });
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'list_sessions', 'read_session', 'start_session', 'run_status',
    ]);
  }, 60_000);
});
