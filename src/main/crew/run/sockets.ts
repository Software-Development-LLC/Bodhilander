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

// ---- the per-run TMPDIR inside BodhiCrew ------------------------------------------------------

export const TMP_PARENT_MODE = '300';

export function tmpParent(uid: number): string {
  return `/tmp/crt-${uid}`;
}

/** A 128-bit random name, never derived from the run id. */
export function newTmpName(): string {
  return randomBytes(16).toString('hex');
}

export class TmpParentError extends SocketRootError {}

/** The bad-parent hold's Repair: as root, the parent removed and made again for crew at 0300. */
export function repairTmpParentScript(uid: number): string {
  const p = tmpParent(uid);
  return `rm -rf ${p} && mkdir ${p} && chown ${uid}:${uid} ${p} && chmod 0300 ${p}`;
}

/** At every start before any run, as root, which can list the 0300 parent. */
export function sweepTmpParentScript(uid: number): string {
  const p = tmpParent(uid);
  return `[ -d ${p} ] && [ ! -L ${p} ] && find ${p} -mindepth 1 -maxdepth 1 -exec rm -rf {} + ; true`;
}

/**
 * Run as crew: the parent made 0300 only when missing, then checked, then an
 * exclusive mkdir of the run's directory. A parent that exists and fails is
 * never recreated here.
 */
export function makeTmpDirScript(uid: number, name: string): string {
  if (!/^[0-9a-f]{32}$/.test(name)) throw new Error('bad TMPDIR name');
  const p = tmpParent(uid);
  return [
    `p=${p}`,
    `if [ ! -e "$p" ] && [ ! -L "$p" ]; then mkdir "$p" && chmod 0300 "$p"; fi`,
    `echo "PARENT $(stat -c '%F|%u|%a' "$p")"`,
    `if [ -d "$p" ] && [ ! -L "$p" ] && [ "$(stat -c '%u|%a' "$p")" = "${uid}|${TMP_PARENT_MODE}" ]; then mkdir -m 0700 "$p/${name}" && echo MADE; fi`,
  ].join('\n');
}

export type TmpDirResult = { ok: true; dir: string } | { ok: false; observed: { type: string; uid: number | null; mode: string | null } };

export function parseTmpDirResult(stdout: string, uid: number, name: string): TmpDirResult {
  const m = /^PARENT ([^|\n]*)\|(\d+)\|([0-7]+)$/m.exec(stdout);
  const observed = m ? { type: m[1] === 'symbolic link' ? 'symlink' : m[1], uid: Number(m[2]), mode: m[3] } : { type: 'unknown', uid: null, mode: null };
  const parentOk = observed.type === 'directory' && observed.uid === uid && observed.mode === TMP_PARENT_MODE;
  if (parentOk && /^MADE$/m.test(stdout)) return { ok: true, dir: `${tmpParent(uid)}/${name}` };
  return { ok: false, observed };
}

/** Names are recorded before the mkdir and forgotten after removal, so an orphan can be found. */
export interface TmpRecords {
  add(name: string): void;
  remove(name: string): void;
  list(): string[];
}

export type DistroSh = (script: string, asRoot?: boolean) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export async function makeWslTmpDir(sh: DistroSh, uid: number, records: TmpRecords, name = newTmpName()): Promise<string> {
  records.add(name);
  const r = await sh(makeTmpDirScript(uid, name));
  const result = parseTmpDirResult(r.stdout, uid, name);
  if (result.ok) return result.dir;
  records.remove(name);
  if (result.observed.type === 'directory' && result.observed.uid === uid && result.observed.mode === TMP_PARENT_MODE) throw new RunDirCollision();
  throw new TmpParentError(result.observed);
}

export async function removeWslTmpDir(sh: DistroSh, uid: number, records: TmpRecords, name: string): Promise<void> {
  if (!/^[0-9a-f]{32}$/.test(name)) return;
  const r = await sh(`rm -rf ${tmpParent(uid)}/${name}`);
  if (r.code === 0) records.remove(name);
}

/** Recorded directories whose run or login is no longer live. */
export async function removeTmpOrphans(sh: DistroSh, uid: number, records: TmpRecords, live: ReadonlySet<string>): Promise<void> {
  for (const name of records.list()) if (!live.has(name)) await removeWslTmpDir(sh, uid, records, name);
}
