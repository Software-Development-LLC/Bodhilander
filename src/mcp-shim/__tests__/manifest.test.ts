/**
 * The manifest is checked with the schema the pinned @anthropic-ai/mcpb ships,
 * the same one `mcpb pack` refuses to pack against.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { v0_3 } from '@anthropic-ai/mcpb/schemas';
import { buildManifest, MANIFEST_VERSION, SERVER_ENTRY } from '../manifest';
import { TOOLS } from '../tools';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
const manifest = buildManifest(pkg);

describe('manifest.json', () => {
  test('validates against the shipped schema for its manifest version', () => {
    expect(manifest.manifest_version).toBe(MANIFEST_VERSION);
    expect(v0_3.MANIFEST_VERSION).toBe(MANIFEST_VERSION);
    const parsed = v0_3.McpbManifestSchema.safeParse(manifest);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  test('the schema really rejects a broken manifest', () => {
    const broken = { ...manifest, server: { ...manifest.server, type: 'deno' } };
    expect(v0_3.McpbManifestSchema.safeParse(broken).success).toBe(false);
  });

  test('carries the app version', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  test('lists exactly the tools the server answers tools/list with', () => {
    expect(manifest.tools).toEqual(TOOLS.map(({ name, description }) => ({ name, description })));
  });

  test('runs the bundled entry under Claude Desktop\'s node', () => {
    expect(manifest.server).toEqual({
      type: 'node',
      entry_point: SERVER_ENTRY,
      mcp_config: { command: 'node', args: [`\${__dirname}/${SERVER_ENTRY}`] },
    });
  });
});
