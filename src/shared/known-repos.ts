/**
 * The repos Claude Desktop may start sessions in: every group's folder, plus
 * the folder of any agent session. A plain shell's cwd is not a repo, and
 * neither is the home folder, anything above it, or a filesystem root.
 */
import * as os from 'os';
import * as path from 'path';

export interface RepoGroup {
  id: string;
  name: string;
  workingDir: string;
}

export interface RepoSession {
  groupId: string;
  workingDir: string;
  shellType: string;
}

export interface KnownRepo {
  dir: string;
  groupId: string;
  groupName: string | null;
}

export function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Comparable form of a folder: resolved, and case-folded where the filesystem usually is. */
export function normalizeRepoPath(dir: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(dir);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** A root, the home folder or one of its ancestors: never a repo, however it got recorded. */
export function isTooBroad(dir: string, platform: NodeJS.Platform, home: string): boolean {
  const p = pathApi(platform);
  const resolved = p.resolve(dir);
  if (p.parse(resolved).root === resolved) return true;
  const target = normalizeRepoPath(resolved, platform);
  const homeDir = normalizeRepoPath(home, platform);
  return homeDir === target || homeDir.startsWith(target.endsWith(p.sep) ? target : target + p.sep);
}

export function knownRepos(
  groups: RepoGroup[],
  sessions: RepoSession[],
  platform: NodeJS.Platform,
  home: string = os.homedir(),
): KnownRepo[] {
  const seen = new Map<string, KnownRepo>();
  const add = (dir: string, repo: KnownRepo) => {
    if (!dir || isTooBroad(dir, platform, home)) return;
    const key = normalizeRepoPath(dir, platform);
    if (!seen.has(key)) seen.set(key, repo);
  };
  for (const g of groups) add(g.workingDir, { dir: g.workingDir, groupId: g.id, groupName: g.name });
  for (const s of sessions) {
    if (s.shellType === 'claude') add(s.workingDir, { dir: s.workingDir, groupId: s.groupId, groupName: null });
  }
  return [...seen.values()];
}

/** The known repo at exactly this folder, or null. */
export function findKnownRepo(
  dir: string,
  groups: RepoGroup[],
  sessions: RepoSession[],
  platform: NodeJS.Platform,
  home: string = os.homedir(),
): KnownRepo | null {
  const wanted = normalizeRepoPath(dir, platform);
  return knownRepos(groups, sessions, platform, home).find((k) => normalizeRepoPath(k.dir, platform) === wanted) ?? null;
}
