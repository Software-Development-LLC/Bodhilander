/**
 * Per-run gateway socket directories: `<root>/<rd>/`, where root is a 0700
 * directory owned by this user and rd is short enough for the 104-byte
 * `sun_path` limit. Every connection presents the run's 32-byte token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const SUN_PATH_MAX = 104;
export const RUN_DIR_TRIES = 4;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export class SocketRootError extends Error {
  constructor(readonly observed: { type: string; uid: number | null; mode: string | null }) {
    super('Crew setup on this machine needs repair');
  }
}

export class RunDirCollision extends Error {
  constructor() {
    super('run-dir-collision');
  }
}

export interface SocketFs {
  lstatSync(p: string): fs.Stats;
  mkdirSync(p: string, opts: { mode: number }): unknown;
  chmodSync(p: string, mode: number): void;
  rmSync(p: string, opts: { recursive: boolean; force: boolean }): void;
}

export function socketRoot(uid: number): string {
  return `/tmp/cr-${uid}`;
}

function base32(bytes: Buffer, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  return out;
}

export function runDirName(runId: string): string {
  return base32(createHash('sha256').update(runId).digest(), 8);
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';
const isTaken = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'EEXIST';

/** Re-checked before every run, and made when missing. Anything else there stops the run. */
export function ensureSocketRoot(root: string, uid: number, fsx: SocketFs = fs): void {
  let st: fs.Stats;
  try {
    st = fsx.lstatSync(root);
  } catch (err) {
    if (!isMissing(err)) throw err;
    fsx.mkdirSync(root, { mode: 0o700 });
    fsx.chmodSync(root, 0o700);
    st = fsx.lstatSync(root);
  }
  const mode = st.mode & 0o777;
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || mode !== 0o700) {
    let type = st.isDirectory() ? 'directory' : 'other';
    if (st.isSymbolicLink()) type = 'symlink';
    throw new SocketRootError({ type, uid: st.uid, mode: mode.toString(8) });
  }
}

/** An exclusive mkdir; a taken name gets one more random character, up to RUN_DIR_TRIES in all. */
export function makeRunDir(root: string, runId: string, fsx: SocketFs = fs, random: () => number = Math.random): string {
  let name = runDirName(runId);
  for (let i = 0; i < RUN_DIR_TRIES; i += 1) {
    const dir = path.join(root, name);
    try {
      fsx.mkdirSync(dir, { mode: 0o700 });
      fsx.chmodSync(dir, 0o700);
      return dir;
    } catch (err) {
      if (!isTaken(err)) throw err;
      name += BASE32[Math.floor(random() * 32) % 32];
    }
  }
  throw new RunDirCollision();
}

export function socketPath(dir: string, name: string): string {
  const p = path.join(dir, `${name}.sock`);
  if (Buffer.byteLength(p) >= SUN_PATH_MAX) throw new Error(`socket path is over the sun_path limit: ${p}`);
  return p;
}

export function newRunToken(): string {
  return randomBytes(32).toString('hex');
}

export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** At start no run is live, so every run dir left in the root is stale. A root that fails the ownership check is left alone. */
export function sweepRunDirs(root: string, uid: number, fsx: SocketFs & { readdirSync(p: string): string[] } = fs): number {
  try {
    const st = fsx.lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) return 0;
  } catch {
    return 0;
  }
  const entries = fsx.readdirSync(root);
  for (const entry of entries) fsx.rmSync(path.join(root, entry), { recursive: true, force: true });
  return entries.length;
}

export function removeRunDir(dir: string, fsx: SocketFs = fs): void {
  fsx.rmSync(dir, { recursive: true, force: true });
}
