/**
 * The hire folder and the run scope every owner-only boundary reads. Scope
 * comes from the delivery frame as is; nothing here derives or widens it.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { RunScope } from '../protocol';

export interface HirePaths {
  root: string;
  owner: string;
  circle: string;
  skills: string;
  run: string;
  ghConfig: string;
  shell: string;
  git: string;
}

export function hirePaths(userData: string, hireId: string): HirePaths {
  const root = path.join(userData, 'crew', hireId);
  return {
    root,
    owner: path.join(root, 'owner'),
    circle: path.join(root, 'circle'),
    skills: path.join(root, 'skills'),
    run: path.join(root, 'run'),
    ghConfig: path.join(root, 'gh-config'),
    shell: path.join(root, 'empty-shell'),
    git: path.join(root, 'git'),
  };
}

export function cwdFor(paths: HirePaths, scope: RunScope): string {
  return scope === 'owner' ? paths.owner : paths.circle;
}

export function settingsPathFor(paths: HirePaths, scope: RunScope): string {
  return path.join(paths.run, `settings-${scope}.json`);
}

const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders'];

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const under = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** A hire folder under a temp dir loses the cross-hire write boundary, since Bash may write its temp dir. */
export function underTempDir(dir: string, tmpdir: string | undefined): boolean {
  const roots = [...TEMP_ROOTS, ...(tmpdir ? [tmpdir] : [])].flatMap((r) => [r, real(r)]);
  const p = real(dir);
  return roots.some((r) => under(p, r));
}
