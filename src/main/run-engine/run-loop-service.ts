/**
 * The run loop, wired to the real app (CO-722).
 *
 * `run-loop.ts` is the scheduler and knows nothing of Electron, the database,
 * or `gh`. This is the glue that hands it the real ones: the run repository
 * for its lists, `gh` and the plugin through `command-runner`, a gate spawner
 * per run, and the attention pass that reads receipts and asks the daemon.
 *
 * It is the last piece of "you are still the dispatcher." Until now every run
 * advanced because someone typed `step`/`watch`/`answer` into the console;
 * this starts a timer at app launch that does the same on its own, for every
 * active run, on the cadences the engine already declares.
 *
 * ## Configuration is the thing this slice actually adds
 *
 * The console read every setting from a `BODHI_*` variable. Those become
 * fields here, resolved once from the app: where `claude` and `gh` live, where
 * channels and prompt files are written (under `userData`, never the repo),
 * and where the permission broker ships (which differs dev vs packaged). Per
 * run, the harness, python and worktree come from the run's own rows.
 *
 * ## It never spawns or decides
 *
 * Every launch goes through the driver's `advance`, which opens the row before
 * it spawns; every decision is the engine's. This module builds dependencies
 * and holds a timer. A run waiting on a person is not driven here at all --
 * `intervalFor` returns null for it -- so the loop cannot answer its own
 * permission prompts, which is the whole point of the inbox.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import * as runsRepo from '../repositories/runs';
import type { RunRow } from '../repositories/runs';
import { advance } from './driver';
import { processDeps, runCommand } from './command-runner';
import { agentsForRun, spawnGateFor, targetFor, type SpawnConfig } from './gate-spawner';
import { lookAtGate, type AttentionDeps } from './attention-pass';
import { discoverPrArgv, readDiscoveredPr } from './pr-discovery';
import { reconcileOnce } from './reconcile';
import { createRunLoop, type LoopDeps, type RunLoop } from './run-loop';
import { GATE_BUSY_CEILING_MS } from './reconcile-loop';

/** How often the timer fires. Each tick still only acts on runs that are DUE. */
const TICK_MS = 15_000;
/** A print gate's ceiling. Background gates get the receipt path instead. */
const GATE_TIMEOUT_MS = 30 * 60 * 1000;
/** How long `claude agents` and `gh pr list` may take before the pass gives up on them. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Where the permission broker lives, dev and packaged.
 *
 * It is a real file spawned by `claude` (as an MCP server or a hook command),
 * so it cannot live inside the asar archive. In dev it is the source under
 * `scripts/`; packaged, it is built to `dist/scripts/` and unpacked. Mirrors
 * `getHookScriptPath` in `mcp-config.ts`, for the same reason.
 */
export function brokerPath(): string {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), 'scripts', 'permission-broker.js');
  }
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'scripts', 'permission-broker.js');
  if (fs.existsSync(unpacked)) return unpacked;
  return path.join(process.resourcesPath, 'app', 'dist', 'scripts', 'permission-broker.js');
}

/** The app-level spawn settings; per-run values come from the run's rows. */
export function spawnConfig(userData: string): SpawnConfig {
  return {
    claudePath: process.env.BODHI_CLAUDE || 'claude',
    promptFileDir: path.join(userData, 'run-engine', 'prompts'),
    permissionsRoot: permissionsRoot(userData),
    brokerPath: brokerPath(),
    gateTimeoutMs: GATE_TIMEOUT_MS,
  };
}

/**
 * The channel root a person's answer is written into, exported so the
 * permission-answer IPC and the loop agree on one location.
 */
export function permissionsRoot(userData: string): string {
  return path.join(userData, 'run-engine', 'permissions');
}

/** Approvers a review request goes to. Empty until configured; the engine refuses clearly then. */
function approvers(): readonly string[] {
  return (process.env.BODHI_APPROVERS || '').split(',').filter(Boolean);
}

/** The real attention dependencies: read the receipt file, ask `claude agents`. */
function attentionDeps(config: SpawnConfig): AttentionDeps {
  return {
    readFile: readIfPresent,
    run: (executable, argv) => runCommand(executable, argv, { timeoutMs: PROBE_TIMEOUT_MS }),
    claudePath: config.claudePath,
    now: () => Date.now(),
    busyCeilingMs: GATE_BUSY_CEILING_MS,
  };
}

/** A file's text, or null when it does not exist. Anything else is thrown. */
function readIfPresent(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Build the loop's dependencies from the real app.
 *
 * Exported so a test can assert the wiring -- which repo call each dependency
 * makes, which cwd `gh` runs in -- against fakes, without a timer or a real
 * `gh` in the room.
 */
export function loopDeps(config: SpawnConfig, ghPath: string): LoopDeps {
  // The executor for one run: its target and its real spawner, built the same
  // way the console builds them, so a gate the loop launches is identical to
  // one a person launched by hand.
  async function executorFor(run: RunRow) {
    const owners = runsRepo.listOwners(run.id);
    const roles = await agentsForRun(run, owners);
    const target = targetFor(run, owners, roles.agents, approvers());
    const commands = processDeps({ ghPath, pythonPath: run.pythonPath ?? 'python' });
    const spawnGate = spawnGateFor(run, owners, config, runsRepo.activeGate, (line) => log.info(`[RunLoop] ${line}`));
    return { target, deps: { ...commands, spawnGate } };
  }

  return {
    now: () => Date.now(),
    listActiveRuns: () => runsRepo.listActiveRuns(),
    listOwners: (id) => runsRepo.listOwners(id),
    activeGate: (id) => runsRepo.activeGate(id),
    look: (run, gate) => lookAtGate(run, gate, attentionDeps(config)),
    discoverPr: async (_run, owner) => {
      // `gh` in the owner's worktree, so it reads that repo's remote and auth
      // without anyone naming the repository.
      const gh = processDeps({ ghPath, pythonPath: 'python', cwd: owner.worktree }).gh;
      const out = await gh(discoverPrArgv(owner.branch));
      return out.code === 0 ? readDiscoveredPr(out.stdout) : null;
    },
    recordPr: (run, owner, pr) =>
      runsRepo.recordOwnerPullRequest(run.id, owner.repo, { prNumber: pr.number, prUrl: pr.url }),
    reconcile: async (run, t) => reconcileOnce(t, processDeps({ ghPath, pythonPath: run.pythonPath ?? 'python' })),
    advance: async (run, event) => {
      const { target, deps } = await executorFor(run);
      return advance(run.id, event, target, deps);
    },
    approvers,
    log: (line) => log.info(`[RunLoop] ${line}`),
  };
}

let started: RunLoop | null = null;

/** Start the always-on loop. Idempotent; safe to call once at whenReady. */
export function startRunLoopService(): RunLoop {
  if (started) return started;
  const userData = app.getPath('userData');
  const config = spawnConfig(userData);
  fs.mkdirSync(config.promptFileDir, { recursive: true });
  fs.mkdirSync(config.permissionsRoot, { recursive: true });
  const loop = createRunLoop(loopDeps(config, process.env.BODHI_GH || 'gh'));
  loop.start(TICK_MS);
  log.info(`[RunLoop] started; ticking every ${TICK_MS / 1000}s`);
  started = loop;
  return loop;
}

/** Stop the loop at shutdown. */
export function stopRunLoopService(): void {
  started?.stop();
  started = null;
}
