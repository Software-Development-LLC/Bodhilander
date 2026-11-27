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
  /** The hire's repo clones, readable and (on an owner run) writable. */
  clones?: readonly string[];
  /** The app bundle, the shim and `claude`'s own directory; re-opened when a default deny covers them. */
  reopen?: readonly string[];
  /** The entries of a directory, for the file tools' per-level denies. */
  listDir?(dir: string): readonly string[];
}

export interface RunSettings {
  autoMemoryEnabled: false;
  permissions: { deny: string[] };
  sandbox: {
    enabled: true;
    allowUnsandboxedCommands: false;
    autoAllowBashIfSandboxed: true;
    enableWeakerNetworkIsolation: true;
    filesystem: { allowWrite: string[]; allowRead: string[]; denyRead: string[]; denyWrite: string[] };
    network: { allowedDomains: string[]; allowUnixSockets: string[] };
  };
}

// Credential stores under home that no run may read, whoever asked for it.
const HOME_SECRETS = [
  '.ssh', '.aws', '.azure', '.config/gcloud', '.config/gh', '.gnupg', '.netrc', '.docker', '.kube', '.npmrc', '.git-credentials',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox', 'Library/Safari', 'Library/Cookies',
];

export const MAC_USERS = '/Users';
export const MAC_DEFAULT_DENY = [MAC_USERS, '/Volumes', '/System/Volumes/Data/Users'];

const FILE_WRITERS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const FILE_READERS = ['Read', 'Glob', 'Grep'];

const rulePath = (p: string): string => `/${trimTrailingSlashes(p)}`;
const readRules = (p: string): string[] => FILE_READERS.flatMap((t) => [`${t}(${rulePath(p)})`, `${t}(${rulePath(p)}/**)`]);
const writeRules = (p: string): string[] => FILE_WRITERS.flatMap((t) => [`${t}(${rulePath(p)})`, `${t}(${rulePath(p)}/**)`]);

export const isUnder = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/** Claude Code's `projects/` entry name for a cwd. */
export function projectsEntry(configDir: string, cwd: string): string {
  return path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

/** The paths no run may write, because they configure the next run. */
export function steeringPaths(paths: HirePaths): string[] {
  return [paths.root, paths.owner, paths.circle].flatMap((dir) => [path.join(dir, '.claude'), path.join(dir, 'CLAUDE.md')]).concat(paths.skills, paths.run, paths.shell, paths.ghConfig, paths.git);
}

function assertAbsolute(label: string, p: string): void {
  if (!path.isAbsolute(p)) throw new Error(`${label} must be absolute: ${p}`);
}

/** The denies kept by name whatever the default: accounts, the keychain, credential stores, other hires, the rest of userData. */
export function namedDenyRead(input: SandboxInput): string[] {
  const { paths } = input;
  const crewDir = path.join(input.userData, 'crew');
  const keychains = path.join(input.home, 'Library', 'Keychains');
  const otherHires = input.crewEntries.map((n) => path.join(crewDir, n)).filter((p) => p !== paths.root);
  const otherUserData = input.userDataEntries.filter((n) => n !== 'crew').map((n) => path.join(input.userData, n));
  const accounts = [...new Set([input.configDir, ...input.accountDirs])];
  const scoped = input.scope === 'circle' ? [paths.owner, projectsEntry(input.configDir, paths.owner)] : [];
  const secrets = HOME_SECRETS.map((p) => path.join(input.home, p));
  return [...new Set([...accounts, keychains, ...secrets, ...otherHires, ...otherUserData, ...scoped])];
}

/** Whether send_file may hand this resolved path on: refused under any named deny. */
export function namedDenyCovers(input: SandboxInput, resolved: string): boolean {
  return namedDenyRead(input).some((d) => isUnder(resolved, d));
}

function scopeRoots(input: SandboxInput): string[] {
  const clones = [...(input.clones ?? [])];
  return input.scope === 'circle' ? [input.paths.circle, ...clones] : [input.paths.owner, input.paths.circle, ...clones];
}

/** What Bash may read under the default deny: the scope's roots, the hire's own run inputs, and the app and `claude` where a deny covers them. */
export function macAllowRead(input: SandboxInput): string[] {
  const { paths } = input;
  const reopen = (input.reopen ?? []).filter((p) => MAC_DEFAULT_DENY.some((d) => isUnder(p, d)));
  return [...new Set([...scopeRoots(input), paths.skills, paths.shell, paths.ghConfig, paths.git, ...reopen])];
}

/** From /Users down to `<userData>/crew`, every entry but the next step toward the hire is denied to the file tools. */
export function levelDenies(input: SandboxInput): string[] {
  const crewDir = path.join(input.userData, 'crew');
  if (!isUnder(crewDir, MAC_USERS)) return [MAC_USERS];
  if (!input.listDir) throw new Error('the per-level denies need a directory listing');
  const steps = path.relative(MAC_USERS, input.paths.root).split(path.sep);
  const out: string[] = [];
  let level = MAC_USERS;
  for (const next of steps) {
    for (const entry of input.listDir(level)) if (entry !== next) out.push(path.join(level, entry));
    level = path.join(level, next);
    if (level === input.paths.root) break;
  }
  return out;
}

export function buildRunSettings(input: SandboxInput): RunSettings {
  for (const [label, p] of [['the config dir', input.configDir], ['userData', input.userData], ['home', input.home], ['the hire folder', input.paths.root]] as const) {
    assertAbsolute(label, p);
  }
  const { paths, scope } = input;
  const named = namedDenyRead(input);
  const allowRead = macAllowRead(input);
  const clash = named.find((d) => allowRead.some((a) => isUnder(d, a)));
  if (clash) throw new Error(`a named deny sits under a re-opened path: ${clash}`);
  const denyRead = [...new Set([...MAC_DEFAULT_DENY, ...named])];
  const crewDir = path.join(input.userData, 'crew');
  const otherHires = input.crewEntries.map((n) => path.join(crewDir, n)).filter((p) => p !== paths.root);
  const accounts = [...new Set([input.configDir, ...input.accountDirs])];
  const scoped = scope === 'circle' ? [paths.owner, projectsEntry(input.configDir, paths.owner)] : [];
  const denyWrite = [...new Set([...accounts, ...otherHires, input.socketRoot, ...steeringPaths(paths), ...scoped])];
  const fileReadDenies = [...new Set([...named, ...levelDenies(input), ...MAC_DEFAULT_DENY.filter((d) => d !== MAC_USERS), paths.run])];
  return {
    autoMemoryEnabled: false,
    permissions: {
      deny: [
        ...fileReadDenies.flatMap(readRules),
        ...FILE_READERS.flatMap((t) => [`${t}(//proc/**)`, `${t}(//dev/fd/**)`]),
        ...denyWrite.flatMap(writeRules),
      ],
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      enableWeakerNetworkIsolation: true,
      filesystem: { allowWrite: scope === 'circle' ? [paths.circle] : scopeRoots(input), allowRead, denyRead, denyWrite },
      network: { allowedDomains: [...input.allowedDomains], allowUnixSockets: [...input.sockets] },
    },
  };
}

export function runSettingsJson(input: SandboxInput): string {
  return JSON.stringify(buildRunSettings(input), null, 2);
}
