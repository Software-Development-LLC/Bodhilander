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
 * ## Configuration
 *
 * The console read every setting from a `BODHI_*` variable. The binaries and
 * approvers now resolve through `machine-config` (preference -> env ->
 * default), so Settings is the friendly source and the env still works. What
 * stays here is app plumbing: where channels and prompt files are written
 * (under `userData`, never the repo) and where the permission broker ships
 * (which differs dev vs packaged). Per run, the harness, python and worktree
 * come from the run's own rows.
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
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import * as runsRepo from '../repositories/runs';
import type { RunRow, RunOwnerRow } from '../repositories/runs';
import { advance, startOwnerGate } from './driver';
import { processDeps, runCommand } from './command-runner';
import { agentsForOwner, spawnGateFor, targetFor, type SpawnConfig } from './gate-spawner';
import { lookAtGate, type AttentionDeps } from './attention-pass';
import { discoverPrArgv, readDiscoveredPr } from './pr-discovery';
import { reconcileOnce } from './reconcile';
import { createRunLoop, type LoopDeps, type RunLoop } from './run-loop';
import { pendingRequests, writeDecision, type ChannelIo } from './permission-inbox';
import { GATE_BUSY_CEILING_MS } from './reconcile-loop';
import { armInitiative } from './arm-run';
import { armRun, type IgnitionResult } from './ignition';
import { prepareInitiative, reposFromRegistry } from './prepare-initiative';
import { driveBootstrap, type BootstrapStore } from './bootstrap-driver';
import { runArchGate, type ArchDeps } from './bootstrap-arch';
import { launchGate } from './gate-launcher';
import { SCOPE_REPO } from './bootstrap';
import { planCrossRepoRun } from './cross-repo-prepare';
import type { ScopeIo } from './scope-initiative';
import type { RunPrepareResult, RunCrossRepoPrepareResult, RunPermissionRequest } from '../../shared/types';
import * as machine from './machine-config';

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
    claudePath: machine.claudePath(),
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

/** The channel's disk access, one place so the loop and the answer IPC agree. */
export const channelIo: ChannelIo = {
  list: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  },
  read: readIfPresent,
  write: (p, text) => fs.writeFileSync(p, text),
  join: (...parts) => path.join(...parts),
};

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
 * The bootstrap sub-driver's side effects, wired to the real app (CO-722).
 *
 * The scripts run on the provisioning ceiling (file_scope writes a file; spawn
 * fetches repos), and the writes go through the run repository. Kept as module
 * constants so the loop and the manifest-approval IPC share one wiring.
 */
const bootstrapIo: ScopeIo = {
  run: (exe, argv, opts) => runCommand(exe, argv, { timeoutMs: 15 * 60_000, env: opts.env }),
  readFile: readIfPresent,
  writeFile: (p, text) => fs.writeFileSync(p, text),
};

const bootstrapStore: BootstrapStore = {
  setBootstrapState: (runId, state) => runsRepo.setBootstrapState(runId, state),
  setRunState: (runId, state, reason) => runsRepo.setRunState(runId, state, reason),
  recordInconclusive: (runId, reason, gate) =>
    runsRepo.recordTransition(runId, 'inconclusive', 'bootstrapInconclusive', { gate, blockedReason: reason }),
  appendEvent: (runId, kind, gate) =>
    runsRepo.appendEvent(runId, kind, gate === undefined ? undefined : { gate }),
};

/**
 * The arch gate's dependencies, wired to the real app (CO-722).
 *
 * The same launcher, broker and verdict schema an owner gate uses, plus the run
 * repository for the gate row and `verify_seams.py` on the provisioning ceiling.
 * The app-level spawn settings come from `config`; per-run values come off the
 * run inside `runArchGate`.
 */
function archDeps(config: SpawnConfig): ArchDeps {
  return {
    startGate: (input) => runsRepo.startGate(input),
    activeGate: (runId, repo) => runsRepo.activeGate(runId, repo),
    finishGate: (id, status, verdict) => runsRepo.finishGate(id, status, verdict),
    launch: (launch) => launchGate(launch),
    run: (exe, argv, opts) => runCommand(exe, argv, { timeoutMs: 15 * 60_000, env: opts.env }),
    readFile: readIfPresent,
    config: {
      claudePath: config.claudePath,
      promptFileDir: config.promptFileDir,
      permissionsRoot: config.permissionsRoot,
      brokerPath: config.brokerPath,
      gateTimeoutMs: config.gateTimeoutMs,
    },
    newId: randomUUID,
    log: (line) => log.info(`[RunLoop] ${line}`),
  };
}

/**
 * Build the loop's dependencies from the real app.
 *
 * Exported so a test can assert the wiring -- which repo call each dependency
 * makes, which cwd `gh` runs in -- against fakes, without a timer or a real
 * `gh` in the room.
 */
/**
 * The executor for one run: its target and its real spawner, built the same
 * way the console builds them, so a gate the loop launches is identical to
 * one a person launched by hand. Shared by the loop's `advance` and the
 * permission-answer path, so both move a run through the same deps.
 */
async function executorFor(config: SpawnConfig, ghPath: string, run: RunRow, owner: RunOwnerRow) {
  const roles = await agentsForOwner(run, owner);
  const target = targetFor(run, owner, roles.agents, machine.approvers());
  const commands = processDeps({ ghPath, pythonPath: run.pythonPath ?? 'python' });
  const spawnGate = spawnGateFor(run, owner, config, runsRepo.activeGate, (line) => log.info(`[RunLoop] ${line}`));
  return { target, deps: { ...commands, spawnGate } };
}

export function loopDeps(config: SpawnConfig, ghPath: string): LoopDeps {
  return {
    now: () => Date.now(),
    listActiveRuns: () => runsRepo.listActiveRuns(),
    listOwners: (id) => runsRepo.listOwners(id),
    activeGate: (id, repo) => runsRepo.activeGate(id, repo),
    look: (run, gate) => lookAtGate(run, gate, attentionDeps(config)),
    pending: (run, gate) => pendingRequests(config.permissionsRoot, run.id, gate, channelIo).length,
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
    advance: async (run, owner, event) => {
      // The loop names the owner; its executor and spawner are that repo's.
      const { target, deps } = await executorFor(config, ghPath, run, owner);
      return advance(run.id, owner.repo, event, target, deps);
    },
    startOwner: async (run, owner) => {
      const { target, deps } = await executorFor(config, ghPath, run, owner);
      return startOwnerGate(run.id, owner.repo, target, deps);
    },
    driveBootstrap: async (run, report) => {
      const result = await driveBootstrap(run, {
        io: bootstrapIo,
        store: bootstrapStore,
        arch: (r) => runArchGate(r, archDeps(config)),
        log: (line) => log.info(`[RunLoop] ${line}`),
      });
      for (const problem of result.problems) report.problems.push({ runId: run.id, problem });
      // Recorded as a reconcile line so a driven bootstrap pass is visible in
      // the tick report; the sub-state names which step ran.
      if (result.drove) report.reconciled.push({ runId: run.id, events: [`bootstrap:${run.bootstrapState}`] });
      return result.problems.length === 0;
    },
    approvers: machine.approvers,
    log: (line) => log.info(`[RunLoop] ${line}`),
  };
}

/**
 * Arm the run in a prepared initiative directory, from the app.
 *
 * Reads the harness the initiative pins itself to, then hands the rest to
 * `armRun`, which checks python and gh by running them and writes the run's
 * rows or refuses with a list. The loop picks the armed run up on its next
 * tick -- nothing is spawned here.
 */
export function armInitiativeDir(initiativeDir: string): Promise<IgnitionResult> {
  return armInitiative(
    initiativeDir,
    { readFile: readIfPresent },
    (request) => armRun(request, { run: (exe, argv) => runCommand(exe, argv, { timeoutMs: 60_000 }) }),
    // The same gh the loop is threaded with in startRunLoopService, so arming
    // checks the gh the loop will later drive with, not a different one.
    { pythonPath: machine.pythonPath(), ghPath: machine.ghPath() },
  );
}

/** The repos the configured harness offers, for the prepare picker. Empty when unconfigured. */
export function listHarnessRepos(): string[] {
  const harness = machine.harnessPath();
  if (!harness) return [];
  const text = readIfPresent(path.join(harness, 'registry.yaml'));
  return text ? reposFromRegistry(text) : [];
}

/**
 * Prepare a single-repo initiative from the app: run the harness's bootstrap.
 *
 * Resolves the machine config the same way the loop does, runs `init_task.py`
 * then `spawn.py`, and returns the armable directory or a fixable refusal. The
 * timeout is the provisioning ceiling: cutting a worktree fetches a repo, which
 * on a cold clone is minutes, not seconds.
 */
export function prepareInitiativeFromApp(
  issueId: string,
  repo: string,
  budgetUsd?: number,
): Promise<RunPrepareResult> {
  return prepareInitiative(
    { issueId, repo, budgetUsd },
    { run: (exe, argv, opts) => runCommand(exe, argv, { timeoutMs: 15 * 60_000, env: opts.env }) },
    {
      pythonPath: machine.pythonPath(),
      harnessPath: machine.harnessPath(),
      bodhiRoot: machine.bodhiRoot(),
      initiativesRoot: machine.initiativesRoot(),
    },
  );
}

/**
 * Prepare a CROSS-REPO initiative from the app (CO-722).
 *
 * Unlike single-repo prepare, this runs nothing eagerly and does not arm: it
 * validates the machine config and the tester's repo picks, then writes ONE run
 * row in `bootstrap_state: 'scoping'` and returns its id. The run shows in the
 * Runs view at once and the always-on loop scopes it, drives `arch`, parks for
 * manifest approval and spawns -- durably, so a closed app resumes mid-flight.
 */
export function prepareCrossRepoRun(
  issueId: string,
  repos: string[],
  budgetUsd?: number,
): RunCrossRepoPrepareResult {
  const plan = planCrossRepoRun(
    { issueId, repos, budgetUsd },
    {
      pythonPath: machine.pythonPath(),
      harnessPath: machine.harnessPath(),
      bodhiRoot: machine.bodhiRoot(),
      initiativesRoot: machine.initiativesRoot(),
    },
    randomUUID,
  );
  if (plan.status === 'refused') return plan;
  runsRepo.createRun(plan.input);
  log.info(`[RunLoop] cross-repo ${plan.input.initiativeKey} (${plan.input.id}) created; the loop will bootstrap it`);
  return { status: 'prepared', runId: plan.input.id };
}

/**
 * The pending permission requests across every owner of a run, each tagged with
 * its repo (CO-722 multi-owner).
 *
 * A run can have several gates in flight -- one per owner -- and two owners at
 * gate 4 both run the verifier, so a request has to say WHICH repo it belongs
 * to or a person answering could unblock the wrong one. Each owner's channel is
 * read by its own active gate.
 */
export function listRunPermissions(userData: string, runId: string): RunPermissionRequest[] {
  const root = permissionsRoot(userData);
  const out: RunPermissionRequest[] = [];
  // A cross-repo run driving the arch gate has no owners yet: its gate-1 channel
  // is keyed on the scope sentinel, so its permission prompts are read here or
  // not at all (CO-722). The print gate blocks its own lane, so this pull-based
  // read is the only path a person has to it.
  const run = runsRepo.getRun(runId);
  if (run?.bootstrapState === 'architecting') {
    const gate = runsRepo.activeGate(runId, SCOPE_REPO);
    for (const req of pendingRequests(root, runId, gate, channelIo)) {
      out.push({ ...req, repo: SCOPE_REPO });
    }
  }
  for (const owner of runsRepo.listOwners(runId)) {
    const gate = runsRepo.activeGate(runId, owner.repo);
    for (const req of pendingRequests(root, runId, gate, channelIo)) {
      out.push({ ...req, repo: owner.repo });
    }
  }
  return out;
}

/**
 * Carry a person's decision to one owner's request, and drive that owner again.
 *
 * Writes the reply the hook is polling for into THAT repo's channel, then -- if
 * that owner had stopped on waitingPermission -- applies `permissionAnswered`
 * to its track so the loop drives it again. Returns whether the request was
 * still there to answer. Named by repo, so answering one owner never touches
 * another's gate.
 */
export async function answerRunPermission(
  userData: string,
  runId: string,
  repo: string,
  toolUseId: string,
  verdict: 'allow' | 'deny',
  message: string,
): Promise<boolean> {
  const gate = runsRepo.activeGate(runId, repo);
  const wrote = writeDecision(permissionsRoot(userData), runId, gate, toolUseId, verdict, message, channelIo);
  if (!wrote) return false;
  const run = runsRepo.getRun(runId);
  const owner = runsRepo.listOwners(runId).find((o) => o.repo === repo);
  // The OWNER's state, not the run's rollup: this repo is the one that stopped.
  if (run && owner && runsRepo.ownerState(runId, repo) === 'waitingPermission') {
    const { target, deps } = await executorFor(spawnConfig(userData), machine.ghPath(), run, owner);
    await advance(runId, repo, { kind: 'permissionAnswered' }, target, deps);
  }
  return true;
}

let started: RunLoop | null = null;

/** Start the always-on loop. Idempotent; safe to call once at whenReady. */
export function startRunLoopService(): RunLoop {
  if (started) return started;
  const userData = app.getPath('userData');
  const config = spawnConfig(userData);
  fs.mkdirSync(config.promptFileDir, { recursive: true });
  fs.mkdirSync(config.permissionsRoot, { recursive: true });
  const loop = createRunLoop(loopDeps(config, machine.ghPath()));
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
