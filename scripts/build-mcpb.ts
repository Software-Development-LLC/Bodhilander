/**
 * Builds dist/mcpb/bodhilander.mcpb, the Claude Desktop extension: a manifest,
 * the icon and one self-contained server bundle, packed by the pinned
 * @anthropic-ai/mcpb CLI, which validates the manifest before writing.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { build } from 'esbuild';
import { buildManifest, SERVER_ENTRY } from '../src/mcp-shim/manifest';
import { MCPB_FILE_NAME } from '../src/shared/claude-desktop';

export async function buildMcpb(root: string, outDir: string): Promise<string> {
  const stage = path.join(outDir, 'stage');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  await build({
    entryPoints: [path.join(root, 'src', 'mcp-shim', 'index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: path.join(stage, SERVER_ENTRY),
    define: { __BODHILANDER_VERSION__: JSON.stringify(pkg.version) },
    logLevel: 'warning',
  });

  fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(buildManifest(pkg), null, 2)}\n`);
  fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(stage, 'icon.png'));

  const cli = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
  const out = path.join(outDir, MCPB_FILE_NAME);
  const packed = spawnSync(process.execPath, [cli, 'pack', stage, out], { stdio: 'inherit' });
  if (packed.status !== 0 || !fs.existsSync(out)) {
    throw new Error(`mcpb pack failed (exit ${packed.status})`);
  }
  return out;
}

if (import.meta.main) {
  const root = path.resolve(__dirname, '..');
  buildMcpb(root, path.join(root, 'dist', 'mcpb'))
    .then((out) => console.log(`Built ${path.relative(root, out)}`))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
