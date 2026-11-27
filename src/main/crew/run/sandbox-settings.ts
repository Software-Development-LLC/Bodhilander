/**
 * The per-run `--settings` file: the sandbox that binds Bash, and the
 * permission rules that hold the file tools, which run outside it.
 */
import * as path from 'path';
import type { RunScope } from '../protocol';
import { trimTrailingSlashes } from '../protocol-parse';
import type { HirePaths } from './scope';

export interface SandboxInput {
  paths: HirePaths;
  scope: RunScope;
  /** The hire's account config dir; never readable or writable by a run. */
  configDir: string;
  /** Every Claude account config dir on this machine. */
  accountDirs: readonly string[];
  /** Bodhilander's userData; everything in it but the hire's folder is denied. */
  userData: string;
  /** The other entries of userData and of `<userData>/crew`, listed by the caller. */
  userDataEntries: readonly string[];
  crewEntries: readonly string[];
  home: string;
  /** The run's gateway sockets, and the socket root denied to writes. */
  sockets: readonly string[];
  socketRoot: string;
  allowedDomains: readonly string[];
}

export interface RunSettings {
  autoMemoryEnabled: false;
  permissions: { deny: string[] };
  sandbox: {
    enabled: true;
    allowUnsandboxedCommands: false;
    autoAllowBashIfSandboxed: true;
    enableWeakerNetworkIsolation: true;
    filesystem: { allowWrite: string[]; denyRead: string[]; denyWrite: string[] };
    network: { allowedDomains: string[]; allowUnixSockets: string[] };
  };
}

// Credential stores under home that no run may read, whoever asked for it.
const HOME_SECRETS = [
  '.ssh', '.aws', '.azure', '.config/gcloud', '.config/gh', '.gnupg', '.netrc', '.docker', '.kube', '.npmrc', '.git-credentials',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox', 'Library/Safari', 'Library/Cookies',
];

const FILE_WRITERS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const FILE_READERS = ['Read', 'Glob', 'Grep'];

const rulePath = (p: string): string => `/${trimTrailingSlashes(p)}`;
const readRules = (p: string): string[] => FILE_READERS.flatMap((t) => [`${t}(${rulePath(p)})`, `${t}(${rulePath(p)}/**)`]);
const writeRules = (p: string): string[] => FILE_WRITERS.flatMap((t) => [`${t}(${rulePath(p)})`, `${t}(${rulePath(p)}/**)`]);

/** Claude Code's `projects/` entry name for a cwd. */
export function projectsEntry(configDir: string, cwd: string): string {
  return path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/** The paths no run may write, because they configure the next run. */
export function steeringPaths(paths: HirePaths): string[] {
  return [paths.root, paths.owner, paths.circle].flatMap((dir) => [path.join(dir, '.claude'), path.join(dir, 'CLAUDE.md')]).concat(paths.skills, paths.run, paths.shell, paths.ghConfig);
}

function assertAbsolute(label: string, p: string): void {
  if (!path.isAbsolute(p)) throw new Error(`${label} must be absolute: ${p}`);
}

export function buildRunSettings(input: SandboxInput): RunSettings {
  for (const [label, p] of [['the config dir', input.configDir], ['userData', input.userData], ['home', input.home], ['the hire folder', input.paths.root]] as const) {
    assertAbsolute(label, p);
  }
  const { paths, scope } = input;
  const crewDir = path.join(input.userData, 'crew');
  const keychains = path.join(input.home, 'Library', 'Keychains');
  const otherHires = input.crewEntries.map((n) => path.join(crewDir, n)).filter((p) => p !== paths.root);
  const otherUserData = input.userDataEntries.filter((n) => n !== 'crew').map((n) => path.join(input.userData, n));
  const accounts = [...new Set([input.configDir, ...input.accountDirs])];
  const scoped = scope === 'circle' ? [paths.owner, projectsEntry(input.configDir, paths.owner)] : [];
  const secrets = HOME_SECRETS.map((p) => path.join(input.home, p));
  const denyRead = [...new Set([...accounts, keychains, ...secrets, ...otherHires, ...otherUserData, ...scoped])];
  const steering = steeringPaths(paths);
  const denyWrite = [...new Set([...accounts, ...otherHires, input.socketRoot, ...steering, ...scoped])];
  return {
    autoMemoryEnabled: false,
    permissions: {
      deny: [
        ...denyRead.flatMap(readRules),
        ...FILE_READERS.flatMap((t) => [`${t}(//proc/**)`, `${t}(//dev/fd/**)`]),
        ...denyWrite.flatMap(writeRules),
      ],
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      enableWeakerNetworkIsolation: true,
      filesystem: { allowWrite: [scope === 'circle' ? paths.circle : paths.root], denyRead, denyWrite },
      network: { allowedDomains: [...input.allowedDomains], allowUnixSockets: [...input.sockets] },
    },
  };
}

export function runSettingsJson(input: SandboxInput): string {
  return JSON.stringify(buildRunSettings(input), null, 2);
}
