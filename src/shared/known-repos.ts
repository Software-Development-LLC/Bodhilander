/**
 * The repos Claude Desktop may start sessions in: every group's folder, plus
 * the folder of any agent session. A plain shell's cwd is not a repo, so a
 * shell once opened in a home directory does not make it a target.
 */
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

export function knownRepos(groups: RepoGroup[], sessions: RepoSession[], platform: NodeJS.Platform): KnownRepo[] {
  const seen = new Map<string, KnownRepo>();
  for (const g of groups) {
    if (!g.workingDir) continue;
    const key = normalizeRepoPath(g.workingDir, platform);
    if (!seen.has(key)) seen.set(key, { dir: g.workingDir, groupId: g.id, groupName: g.name });
  }
  for (const s of sessions) {
    if (!s.workingDir || s.shellType !== 'claude') continue;
    const key = normalizeRepoPath(s.workingDir, platform);
    if (!seen.has(key)) seen.set(key, { dir: s.workingDir, groupId: s.groupId, groupName: null });
  }
  return [...seen.values()];
}

/** The known repo at exactly this folder, or null. */
export function findKnownRepo(
  dir: string,
  groups: RepoGroup[],
  sessions: RepoSession[],
  platform: NodeJS.Platform,
): KnownRepo | null {
  const wanted = normalizeRepoPath(dir, platform);
  return knownRepos(groups, sessions, platform).find((k) => normalizeRepoPath(k.dir, platform) === wanted) ?? null;
}
