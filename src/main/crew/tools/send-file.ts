/**
 * send_file's own checks (design §5.7): the path is resolved inside the run's
 * readable roots, no component may be a link, and the bytes sent are the ones
 * read through a descriptor checked against what was resolved.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FILE_MAX_BYTES } from '../protocol';

export interface FileAccess {
  /** The run's cwd; a relative path resolves from here. */
  cwd: string;
  /** The readable roots of the job's run scope. */
  roots: readonly string[];
  /** True when a resolved path falls under one of the named denies. */
  denied(resolved: string): boolean;
}

export interface ReadFile {
  name: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}

export type FileCheck = { ok: true; file: ReadFile } | { ok: false; reason: string };

export interface FileCheckHooks {
  /** Runs after every check on the path and before the open: where a test swaps the file. */
  beforeOpen?(resolved: string): void;
}

const under = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const refuse = (reason: string): FileCheck => ({ ok: false, reason });

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Every component from the root down to the file, the file included, is lstat'ed: a link anywhere is refused. */
function linkBelow(root: string, target: string): boolean {
  let at = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    if (fs.lstatSync(at).isSymbolicLink()) return true;
  }
  return false;
}

function readChecked(resolved: string, before: fs.Stats, hooks: FileCheckHooks): FileCheck {
  hooks.beforeOpen?.(resolved);
  let fd: number;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return refuse('The file changed while it was being checked.');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.nlink !== 1) return refuse('The file changed while it was being checked.');
    if (st.size > FILE_MAX_BYTES) return refuse('A file sent with send_file is at most 25 MB.');
    const bytes = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = fs.readSync(fd, bytes, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read !== st.size || fs.fstatSync(fd).size !== st.size) return refuse('The file changed while it was being read.');
    return { ok: true, file: { name: path.basename(resolved), size: st.size, sha256: createHash('sha256').update(bytes).digest('hex'), bytes } };
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolve, check and read one file for send_file. Nothing the model supplied is trusted. */
export function checkAndRead(input: unknown, access: FileAccess, hooks: FileCheckHooks = {}): FileCheck {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1024 || input.includes('\0')) return refuse('path must be a file path.');
  const lexical = path.resolve(access.cwd, input);
  const root = access.roots.find((r) => under(lexical, path.resolve(r)));
  if (!root || access.denied(lexical)) return refuse("That path is outside what this run may send.");
  const realRoot = realOrNull(root);
  if (!realRoot) return refuse('No such file.');
  const resolved = path.join(realRoot, path.relative(path.resolve(root), lexical));
  let st: fs.Stats;
  try {
    if (linkBelow(realRoot, resolved)) return refuse('send_file does not send links.');
    st = fs.lstatSync(resolved);
  } catch {
    return refuse('No such file.');
  }
  if (realOrNull(resolved) !== resolved || access.denied(resolved)) return refuse("That path is outside what this run may send.");
  if (!st.isFile()) return refuse('send_file sends one regular file.');
  if (st.nlink !== 1) return refuse('send_file does not send a file with more than one link.');
  if (st.size > FILE_MAX_BYTES) return refuse('A file sent with send_file is at most 25 MB.');
  if (path.basename(resolved).length > 255) return refuse('The file name is over 255 characters.');
  return readChecked(resolved, st, hooks);
}
