/**
 * Crew on Windows as the main process runs it: wsl.exe behind WslExec, the
 * setup gate, the WSL2 run preparation and the start sweep, built once.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import { downloadArtifact, parseVersions, requestArtifactUrl, type ArtifactHub, type CrewVersions, type DownloadFs, type HttpAnswer } from './artifacts';
import { HOLD_SETUP, type PrepareDeps } from './run/prepare';
import { removeTmpOrphans, sweepTmpParentScript, type DistroSh, type TmpRecords } from './run/sockets';
import { asCrew, asRoot, checkWsl, decodeWslOutput, repairLock, repairWsl1, type WslExec } from './wsl';
import { agentServeArgs, WSL_EXE, windowsEnv, type AgentChild } from './wsl-agent';
import { WslRuns, WSL_GH_SHIM_DIR, WSL_MCP_RELAY, type WslRunDeps } from './wsl-run';
import { stopLeftoverWslRuns, type LeftoverRun } from './wsl-reap';
import { BUILD_NOT_READY, buildCanSetUp, installShipped, LINK_WAITING, repairUser, runSetup, WindowsGate, type ShippedFiles } from './wsl-setup';
import { WindowsSetupService } from './wsl-setup-service';
import { WslSignIn, type SignInChild, type WslSignInDeps } from './wsl-sign-in';

const CREW_UID = 1000;

export function realWslExec(exe = WSL_EXE): WslExec {
  return (args, opts) =>
    new Promise((resolve) => {
      const child = spawn(exe, args, { env: windowsEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timedOut = false;
      const onTimeout = () => {
        timedOut = true;
        child.kill();
      };
      const timer = opts?.timeoutMs ? setTimeout(onTimeout, opts.timeoutMs) : null;
      child.stdout.on('data', (b: Buffer) => out.push(b));
      child.stderr.on('data', (b: Buffer) => err.push(b));
      child.stdin.on('error', () => undefined);
      child.on('error', (e) => resolve({ code: null, stdout: '', stderr: e.message }));
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code, stdout: decodeWslOutput(Buffer.concat(out)), stderr: decodeWslOutput(Buffer.concat(err)), timedOut });
      });
      child.stdin.end(opts?.input ?? '');
    });
}

export function distroSh(exec: WslExec): DistroSh {
  return (script, root = false) => exec(root ? asRoot('sh', '-c', script) : asCrew('sh', '-c', script));
}

export function spawnAgentChild(exe = WSL_EXE): AgentChild {
  const child = spawn(exe, agentServeArgs(), { env: windowsEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => undefined);
  const lines = createInterface({ input: child.stdout });
  return {
    write: (line) => {
      child.stdin.write(line);
    },
    onLine: (cb) => {
      lines.on('line', cb);
    },
    onClose: (cb) => {
      child.on('close', () => cb());
    },
    kill: () => {
      child.stdin.end();
      child.kill();
    },
  };
}

export function spawnSignInChild(args: string[], exe = WSL_EXE): SignInChild {
  const child = spawn(exe, args, { env: windowsEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => undefined);
  return {
    write: (text) => {
      child.stdin.write(text);
    },
    onOutput: (cb) => {
      child.stdout.on('data', (b: Buffer) => cb(decodeWslOutput(b)));
      child.stderr.on('data', (b: Buffer) => cb(decodeWslOutput(b)));
    },
    onClose: (cb) => {
      child.on('close', (code) => cb(code));
    },
    kill: () => {
      child.kill();
    },
  };
}

/** The TMPDIR names a run or login holds, kept on the Windows side so a crash leaves them findable. */
export class FileTmpRecords implements TmpRecords {
  constructor(private readonly file: string) {}

  list(): string[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  add(name: string): void {
    this.save([...new Set([...this.list(), name])]);
  }

  remove(name: string): void {
    this.save(this.list().filter((n) => n !== name));
  }

  private save(names: string[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(names));
    fs.renameSync(tmp, this.file);
  }
}

export interface CrewAgentResources {
  /** resources/crew-agent: crew-agent.mjs, versions.json and, when this build carries them, the Node and claude bundles. */
  dir: string;
  relayScript: string;
  shimDir: string;
}

export function shippedFiles(res: CrewAgentResources, versions: CrewVersions): ShippedFiles {
  const optional = (name: string) => (fs.existsSync(path.join(res.dir, name)) ? path.join(res.dir, name) : null);
  return {
    nodeTarball: optional(versions.node.file),
    claudePackage: optional('claude.tgz'),
    crewAgent: path.join(res.dir, 'crew-agent.mjs'),
    helpers: [
      { from: res.relayScript, to: WSL_MCP_RELAY, mode: '0444' },
      { from: path.join(res.shimDir, 'gh-shim.js'), to: `${WSL_GH_SHIM_DIR}/gh-shim.js`, mode: '0444' },
      { from: path.join(res.shimDir, 'gh'), to: `${WSL_GH_SHIM_DIR}/gh`, mode: '0555' },
    ],
  };
}

const nodeDownloadFs: DownloadFs = {
  size: (file) => (fs.existsSync(file) ? fs.statSync(file).size : null),
  read: (file) => fs.createReadStream(file),
  append: (file, chunk) => fs.appendFileSync(file, chunk),
  truncate: (file) => fs.writeFileSync(file, ''),
  remove: (file) => fs.rmSync(file, { force: true }),
};

async function httpGet(url: string, from: number): Promise<HttpAnswer> {
  const res = await fetch(url, { headers: from > 0 ? { Range: `bytes=${from}-` } : {} });
  return { status: res.status, body: res.body ? Readable.fromWeb(res.body as never) : Readable.from([]) };
}

const LINK_POLL_MS = 2000;
const LINK_WAIT_MS = 15 * 60_000;

/** The link card is raised from Crew's own Link this PC; setup waits for it to be approved. */
async function waitForLink(linked: () => boolean, onStatus: (m: string) => void): Promise<boolean> {
  onStatus(LINK_WAITING);
  for (const end = Date.now() + LINK_WAIT_MS; Date.now() < end; await new Promise((r) => setTimeout(r, LINK_POLL_MS))) if (linked()) return true;
  return linked();
}

export type WindowsCrewDeps = Omit<WslRunDeps, 'exec' | 'sh' | 'records' | 'agentVersion' | 'spawnAgent' | 'reinstallAgent'> & {
  resources: CrewAgentResources;
  recordsFile: string;
  /** %LOCALAPPDATA%\Bodhilander\crew: the distro, its downloads and Repair's saved copies. */
  crewDir: string;
  linked(): boolean;
  artifactHub(): ArtifactHub | null;
  /** After setup or Repair, once the start check has run again. */
  onRepaired(): Promise<void>;
  audit(event: string, detail: Record<string, unknown>): void;
  openExternal: WslSignInDeps['openExternal'];
  belongsTo: WslSignInDeps['belongsTo'];
  /** The last session's unended runs, handed over once; their groups are stopped when the start check passes. */
  leftoverRuns?(): LeftoverRun[];
  exec?: WslExec;
  spawnAgent?: () => AgentChild;
};

export interface WindowsCrew {
  windows: NonNullable<PrepareDeps['windows']>;
  /** The sweep, then the full check with interop, once, on the first run this launch. Runs are held until it passes. */
  start(): Promise<void>;
  afterRepair(): Promise<void>;
  setup: WindowsSetupService;
  signIn: WslSignIn;
  end(jobId: string): void;
  endAll(): void;
}

export function createWindowsCrew(deps: WindowsCrewDeps): WindowsCrew {
  const exec = deps.exec ?? realWslExec();
  const sh = distroSh(exec);
  const versions = parseVersions(fs.readFileSync(path.join(deps.resources.dir, 'versions.json'), 'utf8'));
  const records = new FileTmpRecords(deps.recordsFile);
  const shipped = shippedFiles(deps.resources, versions);
  const source = { read: (f: string) => fs.readFileSync(f) };
  const unbuilt = !buildCanSetUp(versions, shipped);
  let unbuiltAudited = false;
  const reinstallAgent = async () => (await installShipped(exec, shipped, source)).ok;
  const runs = new WslRuns({
    ...deps,
    exec,
    sh,
    records,
    agentVersion: versions.crewAgent.version,
    spawnAgent: deps.spawnAgent ?? (() => spawnAgentChild()),
    reinstallAgent,
  });
  const signIn = new WslSignIn({ signIn: deps.signIn, sh, records, spawn: (args) => spawnSignInChild(args), openExternal: deps.openExternal, belongsTo: deps.belongsTo });
  const gate = new WindowsGate({
    exec,
    versions,
    audit: deps.audit,
    sweep: async () => {
      const live = new Set([...runs.liveTmpNames(), ...signIn.liveTmpNames()]);
      await removeTmpOrphans(sh, CREW_UID, records, live);
      if (live.size === 0) await sh(sweepTmpParentScript(CREW_UID), true);
    },
    ready: async () => {
      try {
        await stopLeftoverWslRuns(deps.db, sh, deps.leftoverRuns?.() ?? []);
      } catch (err) {
        deps.audit('leftover-runs-failed', { error: err instanceof Error ? err.message : String(err) });
      }
    },
  });
  const installDir = path.join(deps.crewDir, 'wsl');
  const fetchRootfs = async (): Promise<string> => {
    const dir = path.join(deps.crewDir, 'download');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(versions.rootfs.name));
    return downloadArtifact({ request: async (name) => {
          const hub = deps.artifactHub();
          return hub ? requestArtifactUrl(hub, name) : null;
        }, get: httpGet, fs: nodeDownloadFs, now: Date.now }, { name: versions.rootfs.name, sha256: versions.rootfs.sha256, file });
  };
  let started: Promise<unknown> | null = null;
  const start = async () => {
    started ??= gate.atStart();
    try {
      await started;
    } catch (err) {
      started = null;
      throw err;
    }
  };
  const afterRepair = async () => {
    started = gate.afterRepair();
    await started;
  };
  const setup = new WindowsSetupService({
    check: () => checkWsl(exec),
    start,
    gateState: () => gate.state(),
    activeRuns: () => runs.activeCount() + (signIn.active ? 1 : 0),
    unbuilt: () => unbuilt,
    setup: (onStep) =>
      runSetup({ exec, versions, linked: deps.linked, link: (onStatus) => waitForLink(deps.linked, onStatus), download: fetchRootfs, removeFile: (f) => fs.rmSync(f, { force: true }), installDir, shipped, source, onStep }),
    repairWsl1: (confirm) =>
      repairWsl1({
        exec,
        lock: repairLock,
        fetchRootfs,
        removeFile: (f) => fs.rmSync(f, { force: true }),
        exists: (f) => fs.existsSync(f),
        confirm,
        loginFallback: deps.signIn.mode() === 'login',
        freeBytes: async () => {
          const st = fs.statfsSync(deps.crewDir);
          return st.bavail * st.bsize;
        },
        distroUsedBytes: async () => {
          const vhdx = path.join(installDir, 'ext4.vhdx');
          return fs.existsSync(vhdx) ? fs.statSync(vhdx).size : 0;
        },
        installDir,
        backupDir: path.join(deps.crewDir, 'backup'),
        now: () => new Date(),
      }),
    repairUser: () => repairUser(exec),
    repaired: async () => {
      await afterRepair();
      await deps.onRepaired();
    },
  });
  return {
    windows: {
      gate: async () => {
        if (unbuilt && !unbuiltAudited) {
          unbuiltAudited = true;
          deps.audit('held:setup', { message: BUILD_NOT_READY, step: 'build' });
        }
        if (unbuilt || setup.busy) return HOLD_SETUP;
        try {
          await start();
          return await gate.gate();
        } catch (err) {
          deps.audit('windows-check-failed', { error: err instanceof Error ? err.message : String(err) });
          return HOLD_SETUP;
        }
      },
      prepare: (job, threadKey, runId) => (setup.busy ? Promise.resolve({ hold: HOLD_SETUP }) : runs.prepare(job, threadKey, runId)),
    },
    start,
    afterRepair,
    setup,
    signIn,
    end: (jobId) => runs.end(jobId),
    endAll: () => runs.endAll(),
  };
}
