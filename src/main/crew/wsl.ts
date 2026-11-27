/**
 * Crew's own WSL2 distro, `BodhiCrew`: the check that gates a Windows PC as a
 * hire's home, and Repair for a distro left on WSL1. Every `wsl.exe` call goes
 * through an injected runner; no other distro is ever named.
 */
import * as path from 'path';
import { IMAGE_UNAVAILABLE } from './artifacts';

export const DISTRO = 'BodhiCrew';
export const CREW_HOME = '/home/crew';
export const CREW_DIR = `${CREW_HOME}/.bodhilander/crew`;

export const NO_WSL_MESSAGE =
  'Crew needs WSL2. Open PowerShell as administrator, run "wsl --install", restart the PC, then come back to Crew.';
export const SETUP_NEEDED_MESSAGE = 'Crew runs on Windows inside its own Linux setup. Set up Crew on Windows to start.';
export const WSL1_MESSAGE = "Crew's Windows setup is on WSL1. Repair converts it to WSL2";
export const REPAIR_PROMPT = 'Repair will move Crew\'s Windows setup to WSL2. Crew will save a copy first. If the move fails, hire folders will need restoring.';
export const REPAIR_PROMPT_LOGIN = 'Repair will move Crew\'s Windows setup to WSL2. Crew will save a copy first. If the move fails, hire folders will need restoring and Sign in for Crew redoing.';
export const REPAIR_BUSY = 'Repair is already running on this PC.';

export interface WslResult {
  /** Null when wsl.exe could not be started at all. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Runs `wsl.exe <args>`; stdin is written then closed. */
export type WslExec = (args: string[], opts?: { input?: string | Buffer; timeoutMs?: number }) => Promise<WslResult>;

/** `wsl.exe` writes UTF-16LE to a pipe; everything inside a distro writes UTF-8. */
export function decodeWslOutput(buf: Buffer): string {
  const nuls = buf.subarray(0, 200).filter((b) => b === 0).length;
  const text = nuls > 0 && nuls * 3 >= Math.min(buf.length, 200) ? buf.toString('utf16le') : buf.toString('utf8');
  return text.replace(/^﻿/, '').replace(/\0/g, '');
}

export interface WslDistro {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}

export function parseWslList(text: string): WslDistro[] {
  const out: WslDistro[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(\*)?\s*(\S+)\s+(\S+)\s+(\d)\s*$/.exec(raw);
    if (!m || m[2].toUpperCase() === 'NAME') continue;
    out.push({ name: m[2], state: m[3], version: Number(m[4]), isDefault: m[1] === '*' });
  }
  return out;
}

export type WslCheck =
  | { state: 'ok' }
  | { state: 'no-wsl'; message: string }
  | { state: 'missing'; message: string }
  | { state: 'wsl1'; message: string };

const NOT_INSTALLED = /not installed|is not enabled|optional component|wsl\.exe --install|virtual machine platform/i;
const NO_DISTROS = /no installed distributions/i;

/** Only `BodhiCrew` on version 2 passes; the first listed distro is never taken. */
export async function checkWsl(exec: WslExec): Promise<WslCheck> {
  const r = await exec(['-l', '-v']);
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.code === null) return { state: 'no-wsl', message: NO_WSL_MESSAGE };
  if (NO_DISTROS.test(text)) return { state: 'missing', message: SETUP_NEEDED_MESSAGE };
  if (r.code !== 0 || NOT_INSTALLED.test(text)) return { state: 'no-wsl', message: NO_WSL_MESSAGE };
  const crew = parseWslList(r.stdout).find((d) => d.name === DISTRO);
  if (!crew) return { state: 'missing', message: SETUP_NEEDED_MESSAGE };
  if (crew.version !== 2) return { state: 'wsl1', message: WSL1_MESSAGE };
  return { state: 'ok' };
}

/**
 * The per-machine Repair lock: in memory, in the single-instance main
 * process, so a crash can never leave it held. It never waits.
 */
export class RepairLock {
  private owner: symbol | null = null;

  get held(): boolean {
    return this.owner !== null;
  }

  tryAcquire(): (() => void) | null {
    if (this.owner) return null;
    const me = Symbol('repair');
    this.owner = me;
    return () => {
      if (this.owner === me) this.owner = null;
    };
  }
}

export const repairLock = new RepairLock();

export function asRoot(...cmd: string[]): string[] {
  return ['-d', DISTRO, '-u', 'root', '--', ...cmd];
}

export function asCrew(...cmd: string[]): string[] {
  return ['-d', DISTRO, '-u', 'crew', '--', ...cmd];
}

export async function crewDataEmpty(exec: WslExec): Promise<boolean> {
  const r = await exec(asRoot('find', `${CREW_DIR}/hires`, `${CREW_DIR}/accounts`, '-mindepth', '1', '-maxdepth', '1', '-print', '-quit'));
  // find exits 1 when a directory is missing, which counts as empty; anything printed is content.
  return r.stdout.trim() === '' && (r.code === 0 || /No such file/.test(r.stderr));
}

export function backupName(date: Date): string {
  return `BodhiCrew-${date.toISOString().slice(0, 10)}.tar`;
}

export interface RepairDeps {
  exec: WslExec;
  lock: RepairLock;
  /** Downloads and hash-checks the rootfs; throws when it can't. */
  fetchRootfs(): Promise<string>;
  removeFile(file: string): void;
  exists(file: string): boolean;
  /** Shows REPAIR_PROMPT (or the login-fallback wording); true on Continue. */
  confirm(prompt: string): Promise<boolean>;
  loginFallback: boolean;
  /** Free bytes on the drive holding %LOCALAPPDATA%, measured after the download. */
  freeBytes(): Promise<number>;
  distroUsedBytes(): Promise<number>;
  installDir: string;
  backupDir: string;
  now(): Date;
}

export type RepairOutcome =
  | { result: 'converted' | 'reimported' | 'restored' }
  | { result: 'fallback'; backup: string; message: string }
  | { result: 'cancelled' | 'busy' }
  | { result: 'no-image' | 'export-failed' | 'failed'; message: string }
  | { result: 'short-space'; needBytes: number; message: string };

const gib = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

function importArgs(installDir: string, tar: string): string[] {
  return ['--import', DISTRO, installDir, tar, '--version', '2'];
}

function nextBackupPath(deps: RepairDeps): string {
  const base = backupName(deps.now()).replace(/\.tar$/, '');
  let candidate = path.win32.join(deps.backupDir, `${base}.tar`);
  let i = 2;
  while (deps.exists(candidate)) {
    candidate = path.win32.join(deps.backupDir, `${base}-${i}.tar`);
    i += 1;
  }
  return candidate;
}

async function freshImport(deps: RepairDeps, rootfs: string): Promise<RepairOutcome> {
  const un = await deps.exec(['--unregister', DISTRO]);
  if (un.code !== 0) return { result: 'failed', message: `Repair couldn't remove the old setup: ${firstLine(un)}` };
  const imp = await deps.exec(importArgs(deps.installDir, rootfs));
  return imp.code === 0 ? { result: 'reimported' } : { result: 'failed', message: `Repair couldn't import Crew's Linux image: ${firstLine(imp)}` };
}

async function exportAndRestore(deps: RepairDeps, rootfs: string): Promise<RepairOutcome> {
  const used = await deps.distroUsedBytes();
  const free = await deps.freeBytes();
  if (free < used * 2) {
    const need = used * 2 - free;
    return { result: 'short-space', needBytes: need, message: `Repair needs ${gib(need)} more free space on this drive. Nothing was changed.` };
  }
  const backup = nextBackupPath(deps);
  const exp = await deps.exec(['--export', DISTRO, backup]);
  if (exp.code !== 0) {
    if (deps.exists(backup)) deps.removeFile(backup);
    return { result: 'export-failed', message: `Repair couldn't save a copy, so nothing was changed. It needs about ${gib(used * 2)} free.` };
  }
  const un = await deps.exec(['--unregister', DISTRO]);
  if (un.code !== 0) return { result: 'failed', message: `Repair couldn't remove the old setup: ${firstLine(un)}` };
  if ((await deps.exec(importArgs(deps.installDir, backup))).code === 0) return { result: 'restored' };
  const fresh = await deps.exec(importArgs(deps.installDir, rootfs));
  if (fresh.code !== 0) return { result: 'failed', message: `Repair couldn't import Crew's Linux image. The saved copy is at ${backup}.` };
  const redo = deps.loginFallback ? ' and Sign in for Crew redone' : '';
  return { result: 'fallback', backup, message: `Crew is on WSL2 again, but hire folders need restoring${redo}. The saved copy is at ${backup}.` };
}

function firstLine(r: WslResult): string {
  return (r.stderr || r.stdout).split(/\r?\n/).find((l) => l.trim() !== '') ?? `exit ${r.code}`;
}

/** Repair for a `BodhiCrew` on WSL1. The image comes first; the lock only once something is about to change. */
export async function repairWsl1(deps: RepairDeps): Promise<RepairOutcome> {
  let rootfs: string;
  try {
    rootfs = await deps.fetchRootfs();
  } catch {
    return { result: 'no-image', message: IMAGE_UNAVAILABLE };
  }
  let release: (() => void) | null = null;
  try {
    if ((await deps.exec(['--set-version', DISTRO, '2'])).code === 0) return { result: 'converted' };
    if (await crewDataEmpty(deps.exec)) {
      release = deps.lock.tryAcquire();
      if (!release) return { result: 'busy' };
      return await freshImport(deps, rootfs);
    }
    if (!(await deps.confirm(deps.loginFallback ? REPAIR_PROMPT_LOGIN : REPAIR_PROMPT))) return { result: 'cancelled' };
    release = deps.lock.tryAcquire();
    if (!release) return { result: 'busy' };
    return await exportAndRestore(deps, rootfs);
  } catch (err) {
    return { result: 'failed', message: (err as Error).message };
  } finally {
    release?.();
    deps.removeFile(rootfs);
  }
}
