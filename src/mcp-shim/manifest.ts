/**
 * The Claude Desktop extension's manifest.json. Built from the same TOOLS the
 * server answers tools/list with, so the two lists cannot disagree.
 */
import { TOOLS } from './tools';

export const MANIFEST_VERSION = '0.3';
export const SERVER_ENTRY = 'server/index.js';

export interface PackageInfo {
  version: string;
  homepage: string;
  author: { name: string };
  license: string;
}

export function buildManifest(pkg: PackageInfo) {
  return {
    manifest_version: MANIFEST_VERSION,
    name: 'bodhilander',
    display_name: 'Bodhilander',
    version: pkg.version,
    description: 'See and drive your Bodhilander Claude Code sessions from Claude Desktop.',
    long_description:
      'Lists your Bodhilander sessions, reads their recent activity, starts new Claude Code sessions in ' +
      'repos Bodhilander already knows, and reports run-engine progress. It talks only to Bodhilander on ' +
      'this machine, and only after you turn on access in Bodhilander → Settings → Claude Desktop.',
    author: { name: pkg.author.name },
    repository: { type: 'git', url: pkg.homepage },
    homepage: pkg.homepage,
    icon: 'icon.png',
    server: {
      type: 'node' as const,
      entry_point: SERVER_ENTRY,
      mcp_config: {
        command: 'node',
        args: [`\${__dirname}/${SERVER_ENTRY}`],
      },
    },
    tools: TOOLS.map(({ name, description }) => ({ name, description })),
    keywords: ['claude-code', 'sessions', 'bodhilander'],
    license: pkg.license,
    compatibility: {
      platforms: ['darwin' as const, 'win32' as const, 'linux' as const],
      runtimes: { node: '>=18.0.0' },
    },
  };
}
