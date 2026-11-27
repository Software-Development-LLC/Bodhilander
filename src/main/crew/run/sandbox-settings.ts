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
  const denyRead = [...new Set([...MAC_DEFAULT_DENY, ...named, paths.run])];
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

// ---- WSL2 (bubblewrap inside BodhiCrew) --------------------------------------------------------

const posix = path.posix;

export const WSL_HOME_ROOT = '/home';
export const WSL_CREW_DIR = '/home/crew/.bodhilander/crew';
export const WSL_HIRES_DIR = `${WSL_CREW_DIR}/hires`;
export const WSL_NODE_DIR = `${WSL_CREW_DIR}/node`;
export const WSL_BIN_DIR = `${WSL_CREW_DIR}/bin`;
/** WSL's interop sockets and init, and WSLg's X11, Wayland and PulseAudio sockets. */
export const WSL_HIDDEN = ['/run/WSL', '/init', '/mnt/wslg', '/tmp/.X11-unix'];

export function wslHirePaths(hireId: string): HirePaths {
  const root = posix.join(WSL_HIRES_DIR, hireId);
  return {
    root,
    owner: posix.join(root, 'owner'),
    circle: posix.join(root, 'circle'),
    skills: posix.join(root, 'skills'),
    run: posix.join(root, 'run'),
    ghConfig: posix.join(root, 'gh-config'),
    shell: posix.join(root, 'empty-shell'),
    git: posix.join(root, 'git'),
  };
}

export interface WslSandboxInput {
  hireId: string;
  scope: RunScope;
  uid: number;
  /** The hire's account config dir inside the distro, and every other one there. */
  configDir: string;
  accountDirs: readonly string[];
  /** The hire's repo clones; readable and writable on an owner run only. */
  clones: readonly string[];
  /** The run's `/tmp/cr-<uid>/<rd>/` and its private `/tmp/crt-<uid>/<random>/`. */
  runDir: string;
  tmpDir: string;
  /** Entries of each directory from /home down to the hires dir, listed when the settings are written. */
  levels: Readonly<Record<string, readonly string[]>>;
  allowedDomains: readonly string[];
}

export interface WslRunSettings {
  autoMemoryEnabled: false;
  permissions: { deny: string[] };
  sandbox: {
    enabled: true;
    allowUnsandboxedCommands: false;
    autoAllowBashIfSandboxed: true;
    enableWeakerNetworkIsolation: true;
    filesystem: { allowRead: string[]; allowWrite: string[]; denyRead: string[]; denyWrite: string[] };
    network: { allowedDomains: string[]; allowAllUnixSockets: true };
  };
}

/** At each level from /home to the hires dir, every entry but the next segment of the hire's path. */
function wslLevelDenies(hireRoot: string, levels: WslSandboxInput['levels']): string[] {
  const out: string[] = [];
  for (const [dir, entries] of Object.entries(levels)) {
    if (!isUnder(hireRoot, dir) || hireRoot === dir) continue;
    const next = hireRoot.slice(dir.length + 1).split('/')[0];
    out.push(...entries.filter((e) => e !== next).map((e) => posix.join(dir, e)));
  }
  return out;
}

/**
 * Reads are denied by default: /home and /mnt whole, with only the run's own
 * paths opened again. allowAllUnixSockets is needed because seccomp can't see
 * socket paths, so isolation comes from what the run can see.
 */
export function buildWslRunSettings(input: WslSandboxInput): WslRunSettings {
  for (const p of [input.configDir, input.runDir, input.tmpDir, ...input.clones]) if (!posix.isAbsolute(p)) throw new Error(`must be absolute: ${p}`);
  const paths = wslHirePaths(input.hireId);
  const sockRoot = socketRootDir(input.uid);
  if (!isUnder(input.runDir, sockRoot)) throw new Error(`the run dir must be under ${sockRoot}: ${input.runDir}`);
  const scoped = input.scope === 'circle' ? [paths.circle] : [paths.owner, paths.circle, ...input.clones];
  const accounts = [...new Set([input.configDir, ...input.accountDirs])];
  const denyRead = [
    WSL_HOME_ROOT, '/mnt', ...WSL_HIDDEN, sockRoot,
    '/tmp/cc-socks', `/tmp/cc-socks-${input.uid}`, posix.join(input.tmpDir, 'cc-socks'),
    ...accounts, ...(input.scope === 'circle' ? [paths.owner, ...input.clones] : []),
  ];
  for (const d of denyRead) if (isUnder(input.tmpDir, d)) throw new Error(`the run's TMPDIR sits under a denyRead: ${d}`);
  const allowRead = [...scoped, paths.skills, paths.shell, paths.ghConfig, paths.git, WSL_NODE_DIR, WSL_BIN_DIR, input.runDir];
  const steering = [paths.root, paths.owner, paths.circle].flatMap((d) => [posix.join(d, '.claude'), posix.join(d, 'CLAUDE.md')]).concat(paths.skills, paths.run, paths.shell, paths.ghConfig, paths.git);
  const denyWrite = [...new Set(['/mnt', '/run/WSL', '/init', WSL_NODE_DIR, WSL_BIN_DIR, sockRoot, ...accounts, ...steering])];
  const fileDenies = [...new Set([...wslLevelDenies(paths.root, input.levels), '/mnt', ...WSL_HIDDEN, sockRoot, ...accounts, ...(input.scope === 'circle' ? [paths.owner] : []), paths.run])];
  return {
    autoMemoryEnabled: false,
    permissions: {
      deny: [
        ...fileDenies.flatMap(readRules),
        ...FILE_READERS.flatMap((t) => [`${t}(//proc/**)`, `${t}(//dev/fd/**)`]),
        ...denyWrite.flatMap(writeRules),
      ],
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      enableWeakerNetworkIsolation: true,
      filesystem: { allowRead, allowWrite: [...scoped, input.tmpDir], denyRead, denyWrite },
      network: { allowedDomains: [...input.allowedDomains], allowAllUnixSockets: true },
    },
  };
}

export function socketRootDir(uid: number): string {
  return `/tmp/cr-${uid}`;
}
