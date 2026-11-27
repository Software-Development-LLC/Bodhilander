/**
 * Set up Crew on Windows: link, download, import, the steps inside the
 * distro, then the checks that gate the PC as a hire's home. Each step has a
 * probe, so an interrupted setup restarts at the first unfinished one.
 */
import { isPinnedSha, type CrewVersions } from './artifacts';
import { CREW_DIR, CREW_HOME, DISTRO, asCrew, asRoot, checkWsl, crewDataEmpty, type WslCheck, type WslExec, type WslResult } from './wsl';

export const HOLD_SETUP = 'held:setup';
export const NEEDS_REPAIR = 'Crew setup on this PC needs repair';
export const BUILD_NOT_READY = "This build of Bodhilander can't set up Crew on Windows yet.";
export const LINK_FIRST = 'Crew downloads its Linux image from Crew, so this PC links first';
export const LINK_WAITING = 'Approve the link in Teams. Setup carries on by itself once you do';
export const LINK_REFUSED = "The link wasn't approved, so setup can't download Crew's Linux image";
export const USER_CONFLICT = "Crew's Linux user on this PC isn't set up the way Crew expects. Repair fixes it";
export const INTEROP_TIMEOUT_MS = 15_000;
export const CREW_UID = 1000;

export const WSL_CONF = ['[interop]', 'enabled=false', 'appendWindowsPath=false', '', '[user]', 'default=crew', '', '[boot]', 'systemd=false', ''].join('\n');

export const NODE_DIR = `${CREW_DIR}/node`;
export const BIN_DIR = `${CREW_DIR}/bin`;
export const CREW_AGENT = `${BIN_DIR}/crew-agent`;
export const CLAUDE_BIN = `${BIN_DIR}/claude`;

const firstLine = (s: string): string => s.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';

// ---- the crew user ----------------------------------------------------------------------------

export interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
}

export function parsePasswd(text: string): PasswdEntry[] {
  return text
    .split('\n')
    .map((l) => l.split(':'))
    .filter((f) => f.length >= 4 && /^\d+$/.test(f[2]))
    .map((f) => ({ name: f[0], uid: Number(f[2]), gid: Number(f[3]) }));
}

export type UserState = { state: 'ok' } | { state: 'absent' } | { state: 'conflict'; crewUid: number | null; uid1000: string | null };

export function classifyUser(entries: PasswdEntry[]): UserState {
  const crew = entries.find((e) => e.name === 'crew');
  const holder = entries.find((e) => e.uid === CREW_UID);
  if (crew?.uid === CREW_UID) return { state: 'ok' };
  if (!crew && !holder) return { state: 'absent' };
  return { state: 'conflict', crewUid: crew?.uid ?? null, uid1000: holder?.name ?? null };
}

async function readUsers(exec: WslExec): Promise<PasswdEntry[]> {
  const r = await exec(asRoot('getent', 'passwd'));
  if (r.code !== 0) throw new Error(`getent passwd failed: ${firstLine(r.stderr)}`);
  return parsePasswd(r.stdout);
}

export type StepResult = { ok: true } | { ok: false; hold: string; message: string; audit: Record<string, unknown> };

const hold = (message: string, audit: Record<string, unknown> = {}): StepResult => ({ ok: false, hold: HOLD_SETUP, message, audit });

/** Canonical's rootfs ships `ubuntu` at uid 1000; it goes first, so `crew` can take that uid. */
export async function setupUser(exec: WslExec): Promise<StepResult> {
  let users = await readUsers(exec);
  if (users.some((u) => u.name === 'ubuntu')) {
    await exec(asRoot('userdel', '-r', 'ubuntu'));
    await exec(asRoot('sh', '-c', 'getent group ubuntu >/dev/null && groupdel ubuntu || true'));
    users = await readUsers(exec);
  }
  const state = classifyUser(users);
  if (state.state === 'ok') return { ok: true };
  if (state.state === 'conflict') return hold(USER_CONFLICT, { step: 'user', crewUid: state.crewUid, uid1000: state.uid1000 });
  const add = await exec(asRoot('useradd', '-m', '-u', String(CREW_UID), '-s', '/bin/bash', 'crew'));
  if (add.code !== 0) return hold(USER_CONFLICT, { step: 'user', error: firstLine(add.stderr) });
  return classifyUser(await readUsers(exec)).state === 'ok' ? { ok: true } : hold(USER_CONFLICT, { step: 'user' });
}

async function fixUidInPlace(exec: WslExec, users: PasswdEntry[]): Promise<WslResult> {
  const crew = users.find((u) => u.name === 'crew');
  const other = users.find((u) => u.uid === CREW_UID && u.name !== 'crew');
  if (other) await exec(asRoot('userdel', '-r', other.name));
  if (!crew) return exec(asRoot('useradd', '-m', '-u', String(CREW_UID), '-s', '/bin/bash', 'crew'));
  const mod = await exec(asRoot('usermod', '-u', String(CREW_UID), 'crew'));
  if (mod.code !== 0) return mod;
  const oldGid = crew.gid;
  const script = [
    `if [ ${oldGid} != ${CREW_UID} ] && ! getent group ${CREW_UID} >/dev/null; then groupmod -g ${CREW_UID} crew; fi`,
    `find ${CREW_HOME} -xdev -gid ${oldGid} -exec chgrp -h crew {} +`,
  ].join(' && ');
  return exec(asRoot('sh', '-c', script));
}

/**
 * Repair for a wrong-uid hold. With no hires or accounts the user is made
 * again; with content the uid is fixed in place, never by export and import,
 * which would bring the same /etc/passwd back. One terminate-and-retry, then the hold stays.
 */
export async function repairUser(exec: WslExec): Promise<StepResult> {
  if (await crewDataEmpty(exec)) {
    const users = await readUsers(exec);
    for (const u of users.filter((x) => x.name === 'crew' || (x.uid === CREW_UID && x.name !== 'root'))) await exec(asRoot('userdel', '-r', u.name));
    return setupUser(exec);
  }
  let last: WslResult | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 1) await exec(['--terminate', DISTRO]);
    last = await fixUidInPlace(exec, await readUsers(exec));
    if (last.code === 0 && classifyUser(await readUsers(exec)).state === 'ok') return { ok: true };
  }
  return hold(USER_CONFLICT, { step: 'user-repair', error: firstLine(last?.stderr ?? '') });
}

// ---- /etc/wsl.conf and interop --------------------------------------------------------------

const normalise = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\s+$/, '');

export async function wslConfMatches(exec: WslExec): Promise<boolean> {
  const r = await exec(asRoot('cat', '/etc/wsl.conf'));
  return r.code === 0 && normalise(r.stdout) === normalise(WSL_CONF);
}

/** Written whole, then the distro is terminated so it takes effect; a file already right is left alone. */
export async function writeWslConf(exec: WslExec): Promise<StepResult> {
  if (await wslConfMatches(exec)) return { ok: true };
  const w = await exec(asRoot('sh', '-c', 'cat > /etc/wsl.conf.crew && mv -f /etc/wsl.conf.crew /etc/wsl.conf'), { input: WSL_CONF });
  if (w.code !== 0) return hold(NEEDS_REPAIR, { step: 'wsl-conf', error: firstLine(w.stderr) });
  await exec(['--terminate', DISTRO]);
  return (await wslConfMatches(exec)) ? { ok: true } : hold(NEEDS_REPAIR, { step: 'wsl-conf', readBack: 'different' });
}

const INTEROP_REFUSED = /UtilAcceptVsock|accept4 failed 110/;

/** Passes only on the interop-refused failure; binfmt_misc is never consulted, since it reads `enabled` with interop off. */
export function interopRefused(r: WslResult): boolean {
  return !r.timedOut && r.code === 1 && INTEROP_REFUSED.test(r.stderr);
}

export async function checkInterop(exec: WslExec): Promise<StepResult> {
  const r = await exec(asCrew('/mnt/c/Windows/System32/whoami.exe'), { timeoutMs: INTEROP_TIMEOUT_MS });
  if (interopRefused(r)) return { ok: true };
  const version = await exec(['--version']);
  return hold(NEEDS_REPAIR, {
    step: 'interop',
    exitCode: r.timedOut ? 'timeout' : r.code,
    stderr: firstLine(r.stderr),
    wslVersion: firstLine(version.stdout),
  });
}

// ---- what Bodhilander ships, and what apt owns ---------------------------------------------

export interface ShippedFiles {
  /** Windows paths in Bodhilander's resources; null when this build lacks one. */
  nodeTarball: string | null;
  claudePackage: string | null;
  crewAgent: string;
  /** The MCP relay and the gh shim, copied into crew/bin as they are. */
  helpers?: ReadonlyArray<{ from: string; to: string; mode: string }>;
}

export interface FileSource {
  read(file: string): string | Buffer;
}

async function versionOf(exec: WslExec, ...cmd: string[]): Promise<string> {
  const r = await exec(asCrew(...cmd));
  return r.code === 0 ? r.stdout.trim().replace(/^v/, '').split(/\s/)[0] : '';
}

export async function shippedMismatches(exec: WslExec, versions: CrewVersions): Promise<string[]> {
  const out: string[] = [];
  if ((await versionOf(exec, `${NODE_DIR}/bin/node`, '--version')) !== versions.node.version) out.push('node');
  if ((await versionOf(exec, CLAUDE_BIN, '--version')) !== versions.claude.version) out.push('claude');
  if ((await versionOf(exec, CREW_AGENT, '--version')) !== versions.crewAgent.version) out.push('crew-agent');
  return out;
}

export async function aptBelowMinimum(exec: WslExec, versions: CrewVersions): Promise<string[]> {
  const out: string[] = [];
  for (const [pkg, min] of Object.entries(versions.apt)) {
    const script = `v=$(dpkg-query -W -f='\${Version}' ${pkg} 2>/dev/null) && dpkg --compare-versions "$v" ge ${min}`;
    if ((await exec(asRoot('sh', '-c', script))).code !== 0) out.push(pkg);
  }
  return out;
}

/** A temp file in the same directory, then rename: a crew-agent already running keeps its open file. */
export async function writeIntoDistro(exec: WslExec, dest: string, body: string | Buffer, mode: string): Promise<WslResult> {
  const dir = dest.slice(0, dest.lastIndexOf('/'));
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  const script = `mkdir -p ${dir} && cat > ${tmp} && chmod ${mode} ${tmp} && mv -f ${tmp} ${dest}`;
  return exec(asCrew('sh', '-c', script), { input: body });
}

/** A build with a placeholder hash, or without the Node or claude bundle, can never finish setup. */
export function buildCanSetUp(versions: CrewVersions, files: ShippedFiles): boolean {
  return isPinnedSha(versions.rootfs.sha256) && isPinnedSha(versions.node.sha256) && !!files.nodeTarball && !!files.claudePackage;
}

export async function installShipped(exec: WslExec, files: ShippedFiles, source: FileSource): Promise<StepResult> {
  if (!files.nodeTarball || !files.claudePackage) return hold(NEEDS_REPAIR, { step: 'shipped', error: 'this build carries no Node or claude bundle' });
  const steps: Array<() => Promise<WslResult>> = [
    () => writeIntoDistro(exec, `${CREW_DIR}/download/node.tar.xz`, source.read(files.nodeTarball as string), '0444'),
    () => exec(asCrew('sh', '-c', `rm -rf ${NODE_DIR} && mkdir -p ${NODE_DIR} && tar -xJf ${CREW_DIR}/download/node.tar.xz -C ${NODE_DIR} --strip-components=1 && rm -f ${CREW_DIR}/download/node.tar.xz`)),
    () => writeIntoDistro(exec, `${CREW_DIR}/download/claude.tgz`, source.read(files.claudePackage as string), '0444'),
    () => exec(asCrew('sh', '-c', `${NODE_DIR}/bin/npm install -g --prefix ${CREW_DIR}/claude ${CREW_DIR}/download/claude.tgz && mkdir -p ${BIN_DIR} && ln -sf ${CREW_DIR}/claude/bin/claude ${CLAUDE_BIN} && rm -f ${CREW_DIR}/download/claude.tgz`)),
    () => writeIntoDistro(exec, `${CREW_AGENT}.mjs`, source.read(files.crewAgent), '0555'),
    () => writeIntoDistro(exec, CREW_AGENT, `#!/bin/sh\nexec ${NODE_DIR}/bin/node ${CREW_AGENT}.mjs "$@"\n`, '0555'),
    ...(files.helpers ?? []).map((h) => () => writeIntoDistro(exec, h.to, source.read(h.from), h.mode)),
  ];
  for (const step of steps) {
    const r = await step();
    if (r.code !== 0) return hold(NEEDS_REPAIR, { step: 'shipped', error: firstLine(r.stderr) });
  }
  return { ok: true };
}

export async function installApt(exec: WslExec): Promise<StepResult> {
  const r = await exec(asRoot('sh', '-c', 'DEBIAN_FRONTEND=noninteractive apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q bubblewrap socat'));
  return r.code === 0 ? { ok: true } : hold(NEEDS_REPAIR, { step: 'apt', error: firstLine(r.stderr) });
}

/**
 * The per-machine crew-agent install lock, separate from the Repair lock.
 * Callers arriving while a reinstall runs share its result, so two runs
 * that both see a mismatch reinstall once.
 */
export class InstallLock {
  private running: Promise<boolean> | null = null;

  run(install: () => Promise<boolean>): Promise<boolean> {
    this.running ??= install().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}

export const installLock = new InstallLock();

// ---- the setup order -----------------------------------------------------------------------

export type SetupStep = 'wsl' | 'link' | 'download' | 'import' | 'user' | 'wsl-conf' | 'shipped' | 'apt' | 'interop';

export interface SetupDeps {
  exec: WslExec;
  versions: CrewVersions;
  linked(): boolean;
  /** Shows the link page; resolves true on `welcome`, false on a denied or expired card. */
  link(onStatus: (message: string) => void): Promise<boolean>;
  /** Downloads and checks the rootfs into %LOCALAPPDATA%\Bodhilander\crew\download\; throws an ArtifactError. */
  download(): Promise<string>;
  removeFile(file: string): void;
  installDir: string;
  shipped: ShippedFiles;
  source: FileSource;
  onStep?(step: SetupStep, message?: string): void;
}

export type SetupOutcome = { ok: true } | { ok: false; step: SetupStep; message: string; hold?: string; audit?: Record<string, unknown>; repair?: boolean };

/** Every probe is re-run, so a step finished by an earlier attempt is skipped and the first unfinished one runs. */
export async function runSetup(deps: SetupDeps): Promise<SetupOutcome> {
  const { exec } = deps;
  deps.onStep?.('wsl');
  const wsl: WslCheck = await checkWsl(exec);
  if (wsl.state === 'no-wsl') return { ok: false, step: 'wsl', message: wsl.message };
  if (wsl.state === 'wsl1') return { ok: false, step: 'wsl', message: wsl.message, repair: true };
  if (wsl.state === 'missing') {
    if (!deps.linked()) {
      deps.onStep?.('link', LINK_FIRST);
      if (!(await deps.link((m) => deps.onStep?.('link', m)))) return { ok: false, step: 'link', message: LINK_REFUSED };
    }
    deps.onStep?.('download');
    let rootfs: string;
    try {
      rootfs = await deps.download();
    } catch (err) {
      return { ok: false, step: 'download', message: (err as Error).message };
    }
    deps.onStep?.('import');
    const imp = await exec(['--import', DISTRO, deps.installDir, rootfs, '--version', '2']);
    deps.removeFile(rootfs);
    if (imp.code !== 0) return { ok: false, step: 'import', message: `Crew couldn't import its Linux image: ${firstLine(imp.stderr || imp.stdout)}` };
  }
  const steps: Array<[SetupStep, () => Promise<boolean>, () => Promise<StepResult>]> = [
    ['user', async () => classifyUser(await readUsers(exec)).state === 'ok', () => setupUser(exec)],
    ['wsl-conf', () => wslConfMatches(exec), () => writeWslConf(exec)],
    ['shipped', async () => (await shippedMismatches(exec, deps.versions)).length === 0, () => installShipped(exec, deps.shipped, deps.source)],
    ['apt', async () => (await aptBelowMinimum(exec, deps.versions)).length === 0, () => installApt(exec)],
    ['interop', async () => false, () => checkInterop(exec)],
  ];
  for (const [step, done, run] of steps) {
    if (await done()) continue;
    deps.onStep?.(step);
    const r = await run();
    if (!r.ok) return { ok: false, step, message: r.message, hold: r.hold, audit: r.audit, repair: true };
  }
  return (await machineCheck(exec, deps.versions)).ok ? { ok: true } : { ok: false, step: 'shipped', message: NEEDS_REPAIR, hold: HOLD_SETUP, repair: true };
}

/** At start and before each run: no interop launch here, only the file, the user and the versions. */
export async function machineCheck(exec: WslExec, versions: CrewVersions): Promise<StepResult> {
  const wsl = await checkWsl(exec);
  if (wsl.state !== 'ok') return hold(wsl.message, { step: 'wsl', state: wsl.state });
  const user = classifyUser(await readUsers(exec));
  if (user.state !== 'ok') return hold(USER_CONFLICT, { step: 'user', ...user });
  if (!(await wslConfMatches(exec))) return hold(NEEDS_REPAIR, { step: 'wsl-conf', readBack: 'different' });
  const shipped = await shippedMismatches(exec, versions);
  const apt = await aptBelowMinimum(exec, versions);
  if (shipped.length || apt.length) return hold(NEEDS_REPAIR, { step: 'versions', shipped, apt });
  return { ok: true };
}

// ---- the gate a Windows run waits on --------------------------------------------------------

export interface WindowsGateDeps {
  exec: WslExec;
  versions: CrewVersions;
  /** A setup hold's audit row; written once per distinct hold, not per run. */
  audit(event: string, detail: Record<string, unknown>): void;
  /** The root-side sweep of /tmp/crt-<uid>/ at start, before any run. */
  sweep?(): Promise<void>;
  /** Once the start check passes, before any run is let through. */
  ready?(): Promise<void>;
}

/**
 * The interop launch takes about ten seconds, so it runs at start and after
 * Repair; before each run only the file, the user and the versions are read.
 * Until the start check has passed, every run is held.
 */
export class WindowsGate {
  private interop: StepResult | null = null;
  private last: StepResult | null = null;
  private lastHold: string | null = null;

  constructor(private readonly deps: WindowsGateDeps) {}

  async atStart(): Promise<StepResult> {
    await this.deps.sweep?.();
    const machine = await machineCheck(this.deps.exec, this.deps.versions);
    const interop = machine.ok ? await checkInterop(this.deps.exec) : machine;
    if (interop.ok) await this.deps.ready?.();
    this.interop = interop;
    this.last = interop;
    if (!interop.ok) this.record(interop);
    return interop;
  }

  /** The last check, at start or before a run; null before the first. */
  state(): StepResult | null {
    return this.last;
  }

  afterRepair(): Promise<StepResult> {
    return this.atStart();
  }

  async gate(): Promise<string | null> {
    if (!this.interop) return HOLD_SETUP;
    if (!this.interop.ok) return this.interop.hold;
    const r = await machineCheck(this.deps.exec, this.deps.versions);
    this.last = r;
    if (r.ok) {
      this.lastHold = null;
      return null;
    }
    this.record(r);
    return r.hold;
  }

  private record(r: Extract<StepResult, { ok: false }>): void {
    const key = JSON.stringify(r.audit);
    if (key === this.lastHold) return;
    this.lastHold = key;
    this.deps.audit('held:setup', { message: r.message, ...r.audit });
  }
}
