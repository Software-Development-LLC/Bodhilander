/**
 * Crew on Windows as the main process runs it: wsl.exe behind WslExec, the
 * setup gate, the WSL2 run preparation and the start sweep, built once.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { parseVersions, type CrewVersions } from './artifacts';
import type { PrepareDeps } from './run/prepare';
import { removeTmpOrphans, sweepTmpParentScript, type DistroSh, type TmpRecords } from './run/sockets';
import { asCrew, asRoot, decodeWslOutput, type WslExec } from './wsl';
import { agentServeArgs, WSL_EXE, windowsEnv, type AgentChild } from './wsl-agent';
import { WslRuns, WSL_GH_SHIM_DIR, WSL_MCP_RELAY, type WslRunDeps } from './wsl-run';
import { installShipped, WindowsGate, type ShippedFiles } from './wsl-setup';

const CREW_UID = 1000;

export function realWslExec(exe = WSL_EXE): WslExec {
  return (args, opts) =>
    new Promise((resolve) => {
      const child = spawn(exe, args, { env: windowsEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timedOut = false;
      const timer = opts?.timeoutMs ? setTimeout(() => ((timedOut = true), child.kill()), opts.timeoutMs) : null;
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
    write: (line) => void child.stdin.write(line),
    onLine: (cb) => void lines.on('line', cb),
    onClose: (cb) => void child.on('close', () => cb()),
    kill: () => {
      child.stdin.end();
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

export type WindowsCrewDeps = Omit<WslRunDeps, 'exec' | 'sh' | 'records' | 'agentVersion' | 'spawnAgent' | 'reinstallAgent'> & {
  resources: CrewAgentResources;
  recordsFile: string;
  audit(event: string, detail: Record<string, unknown>): void;
  exec?: WslExec;
  spawnAgent?: () => AgentChild;
};

export interface WindowsCrew {
  windows: NonNullable<PrepareDeps['windows']>;
  /** At Bodhilander start: the sweep, then the full check with interop. Runs are held until it passes. */
  start(): Promise<void>;
  afterRepair(): Promise<void>;
  end(jobId: string): void;
  endAll(): void;
}

export function createWindowsCrew(deps: WindowsCrewDeps): WindowsCrew {
  const exec = deps.exec ?? realWslExec();
  const sh = distroSh(exec);
  const versions = parseVersions(fs.readFileSync(path.join(deps.resources.dir, 'versions.json'), 'utf8'));
  const records = new FileTmpRecords(deps.recordsFile);
  const reinstallAgent = async () => (await installShipped(exec, shippedFiles(deps.resources, versions), { read: (f) => fs.readFileSync(f) })).ok;
  const runs = new WslRuns({
    ...deps,
    exec,
    sh,
    records,
    agentVersion: versions.crewAgent.version,
    spawnAgent: deps.spawnAgent ?? (() => spawnAgentChild()),
    reinstallAgent,
  });
  const gate = new WindowsGate({
    exec,
    versions,
    audit: deps.audit,
    sweep: async () => {
      await removeTmpOrphans(sh, CREW_UID, records, runs.liveTmpNames());
      if (runs.liveTmpNames().size === 0) await sh(sweepTmpParentScript(CREW_UID), true);
    },
  });
  return {
    windows: { gate: () => gate.gate(), prepare: (job, threadKey, runId) => runs.prepare(job, threadKey, runId) },
    start: async () => void (await gate.atStart()),
    afterRepair: async () => void (await gate.afterRepair()),
    end: (jobId) => runs.end(jobId),
    endAll: () => runs.endAll(),
  };
}
