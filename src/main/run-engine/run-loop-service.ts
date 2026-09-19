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
import { reconcileOnce, expectedChecksLookup, type ChecksLookup, type CommandResult } from './reconcile';
import { createRunLoop, type LoopDeps, type RunLoop } from './run-loop';
import { pendingRequests, writeDecision, type ChannelIo } from './permission-inbox';
import { GATE_BUSY_CEILING_MS } from './reconcile-loop';
import { armInitiative, mergeOrderFromSeams } from './arm-run';
import { armRun, materializeOwners, type IgnitionResult } from './ignition';
import { prepareInitiative, reposFromRegistry } from './prepare-initiative';
import { driveBootstrap, type BootstrapStore } from './bootstrap-driver';
import { manifestVerdict, type ManifestAnomaly } from './manifest-anomaly';
import { runArchGate, type ArchDeps } from './bootstrap-arch';
import { runSpawn, type SpawnDeps } from './bootstrap-spawn';
import { cutWorktrees } from './worktrees';
import { provisionRun, resolveProvisionCommands } from './provision';
import { loadOrchestrationConfig } from '../github/orchestration-config';
import { fetchProjectBoard } from '../github/board-service';
import { resolveAccountForGroup } from '../account-resolver';
import { launchGate } from './gate-launcher';
import { SCOPE_REPO } from './bootstrap';
import { planCrossRepoRun } from './cross-repo-prepare';
import type { ScopeIo } from './scope-initiative';
import type { RunPrepareResult, RunCrossRepoPrepareResult, RunPermissionRequest, SeamManifest, ConfigResult, BoardResult } from '../../shared/types';
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

/**
 * The env the `claude agents` status probe runs under: the run's managed
 * account config dir (#327), or ambient when there is none. Exported and pure so
 * the "probe the right account, not the default" decision is a value a test can
 * assert — the whole point of the fix, since probing the wrong account reads a
 * live gate as `gone`.
 */
export function probeEnv(accountConfigDir: string | null): Record<string, string> | undefined {
  return accountConfigDir ? { CLAUDE_CONFIG_DIR: accountConfigDir } : undefined;
}

/**
 * The real attention dependencies: read the receipt file, ask `claude agents`.
 *
 * `accountConfigDir` is threaded in because the status probe (`claude agents
 * --json`) MUST run under the same managed account the gate was launched with
 * (#327). A `--bg` gate registers its background session in that account's
 * config; probing under the ambient/default config finds no such session and
 * reads it as `gone` — which is exactly how a live owner gate that was still
 * working got declared inconclusive minutes before it committed its work.
 */
function attentionDeps(config: SpawnConfig, accountConfigDir: string | null = null): AttentionDeps {
  const env = probeEnv(accountConfigDir);
  return {
    readFile: readIfPresent,
    run: (executable, argv) => runCommand(executable, [...argv], { timeoutMs: PROBE_TIMEOUT_MS, env }),
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
/**
 * The base branch to cut each repo's worktree from: the repo's
 * `integration_branch` in the central config, or `development` when the config
 * is unset/unreadable (never an error — a missing config just means the default).
 */
async function baseBranches(repos: readonly string[]): Promise<Record<string, string>> {
  try {
    const res = await loadOrchestrationConfig();
    if (res.status !== 'ok') return {};
    const out: Record<string, string> = {};
    for (const repo of repos) {
      const branch = res.config.repos[repo]?.integrationBranch;
      if (branch) out[repo] = branch;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The owner agent the central config names for each repo (Phase 4). Repos the
 * config doesn't name are omitted — they fall back to the harness's
 * single-candidate resolution in `resolveOwners`.
 */
async function configOwnersFor(repos: readonly string[]): Promise<Record<string, string>> {
  try {
    const res = await loadOrchestrationConfig();
    if (res.status !== 'ok') return {};
    const out: Record<string, string> = {};
    for (const repo of repos) {
      const agent = res.config.repos[repo]?.ownerAgent;
      if (agent) out[repo] = agent;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * A repo's expected checks (Phase 3): from the central config, not
 * `registry_entry.py`. No config repo set → noBar (nothing defines green); a
 * config that can't be read → retry (transient, re-attempted like a gh failure).
 */
async function expectedChecksLookupFor(repo: string): Promise<ChecksLookup> {
  if (machine.configRepo() === null) {
    return { kind: 'noBar', reason: `no config repo is set, so nothing defines green for ${repo}` };
  }
  let res: ConfigResult | null = null;
  try {
    res = await loadOrchestrationConfig();
  } catch (err) {
    // Logged, not swallowed silently: a genuine config-load bug should be
    // distinguishable from a transient fetch failure. Either way it maps to
    // `retry` (expectedChecksLookup treats a null result that way).
    log.error(`[RunLoop] expected-checks: config load threw for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return expectedChecksLookup(res, repo);
}

/** Cut a run's worktrees in TS: resolve base branches from config, then `cutWorktrees`. */
async function cutRunWorktrees(initiative: string, repos: readonly string[], bodhiRoot: string) {
  const bases = await baseBranches(repos);
  const plan = {
    initiative,
    repos: repos.map((repo) => ({ repo, integrationBranch: bases[repo] ?? 'development' })),
  };
  return cutWorktrees(
    {
      // Worktree cutting fetches repos, so it gets the provisioning ceiling.
      git: (argv) => runCommand(machine.gitPath(), argv, { timeoutMs: 3 * 60_000 }),
      dirExists: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
      mkdirp: (p) => { try { fs.mkdirSync(p, { recursive: true }); } catch { /* best effort */ } },
      bodhiRoot,
      org: machine.githubOrg(),
    },
    plan,
  );
}

/**
 * The spawn step's side effects (CO-722, Phase 3): cut the worktrees in TS (no
 * Python), read seams.yaml for the merge order, and write the owner rows via the
 * same `materializeOwners` arming uses. No per-run config.
 */
const spawnDeps: SpawnDeps = {
  cut: (initiative, repos, bodhiRoot) => cutRunWorktrees(initiative, repos, bodhiRoot),
  configOwners: (repos) => configOwnersFor(repos),
  readFile: readIfPresent,
  materialize: (request) =>
    materializeOwners(request, { run: (exe, argv) => runCommand(exe, argv, { timeoutMs: 60_000 }) }),
  log: (line) => log.info(`[RunLoop] ${line}`),
};

/** The managed account a run's gates launch under (#327), or null for ambient. */
function accountConfigDirFor(run: RunRow): string | null {
  return resolveAccountForGroup(run.groupId)?.configDir ?? null;
}

/**
 * The central config's context for an owner's repo + owner agent (Phase 4),
 * joined for the gate brief, or null when the config names none. Externally
 * authored — the app carries it, it doesn't invent it.
 */
async function repoContextFor(owner: RunOwnerRow): Promise<string | null> {
  try {
    const res = await loadOrchestrationConfig();
    if (res.status !== 'ok') return null;
    const parts = [res.config.repos[owner.repo]?.context, owner.agent ? res.config.owners?.[owner.agent]?.context : undefined];
    const joined = parts.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).join('\n\n');
    return joined.length > 0 ? joined : null;
  } catch {
    return null;
  }
}

function archDeps(config: SpawnConfig, run: RunRow): ArchDeps {
  return {
    accountConfigDir: accountConfigDirFor(run),
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
/** Run a provision command in a worktree through the platform shell (PATH + compound commands). */
function runProvisionCommand(command: string, cwd: string): Promise<CommandResult> {
  const ceilingMs = 15 * 60_000; // an install compiles native modules on a cold worktree.
  if (process.platform === 'win32') {
    return runCommand(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { cwd, timeoutMs: ceilingMs });
  }
  return runCommand('/bin/sh', ['-c', command], { cwd, timeoutMs: ceilingMs });
}

/**
 * Provision a run in TS (Phase 3): run each owner's config `provision` command in
 * its worktree. Shaped as a `CommandResult` so `executor.ts` maps `code` through
 * `provisionEvent` exactly as it did the Python exit. A config repo that is set
 * but unreadable is undriveable (code 2), never a silent "provisioned" — only a
 * genuinely unconfigured config repo means "nothing owed".
 */
async function provisionRunFor(run: RunRow): Promise<CommandResult> {
  const hasConfigRepo = machine.configRepo() !== null;
  let result: ConfigResult | null = null;
  if (hasConfigRepo) {
    try {
      result = await loadOrchestrationConfig();
    } catch (err) {
      log.error(`[RunLoop] provision: config load threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const commands = resolveProvisionCommands(hasConfigRepo, result);
  if ('undriveable' in commands) {
    log.error(`[RunLoop] provision: ${commands.undriveable}`);
    return { code: 2, stdout: '', stderr: commands.undriveable };
  }
  const summary = await provisionRun({
    owners: () => runsRepo.listOwners(run.id).map((o) => ({ repo: o.repo, worktree: o.worktree })),
    commandFor: commands.commandFor,
    run: runProvisionCommand,
    log: (line) => log.info(`[RunLoop] provision ${line}`),
  });
  return { code: summary.code, stdout: summary.log, stderr: '' };
}

async function executorFor(config: SpawnConfig, ghPath: string, run: RunRow, owner: RunOwnerRow) {
  const roles = await agentsForOwner(run, owner);
  const target = targetFor(run, owner, roles.agents, machine.approvers());
  const commands = processDeps({ ghPath, pythonPath: run.pythonPath ?? 'python' });
  const spawnGate = spawnGateFor(run, owner, config, runsRepo.activeGate, (line) => log.info(`[RunLoop] ${line}`), accountConfigDirFor(run), await repoContextFor(owner));
  return { target, deps: { ...commands, spawnGate, provision: () => provisionRunFor(run) } };
}

export function loopDeps(config: SpawnConfig, ghPath: string): LoopDeps {
  return {
    now: () => Date.now(),
    listActiveRuns: () => runsRepo.listActiveRuns(),
    listOwners: (id) => runsRepo.listOwners(id),
    activeGate: (id, repo) => runsRepo.activeGate(id, repo),
    look: (run, gate) => lookAtGate(run, gate, attentionDeps(config, accountConfigDirFor(run))),
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
    reconcile: async (run, t) =>
      reconcileOnce(t, await expectedChecksLookupFor(t.registryRepo), processDeps({ ghPath, pythonPath: run.pythonPath ?? 'python' })),
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
        arch: (r) => runArchGate(r, archDeps(config, r)),
        evaluateManifest: (r) => evaluateManifest(r),
        spawn: (r) => runSpawn(r, spawnDeps),
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

/** The `KEY-N` tracking key inside a board initiative's title (e.g. `[CO-838] …`), or null. */
export function boardInitiativeKey(title: string): string | null {
  const m = /\[([A-Za-z][A-Za-z0-9]*-\d+)\]/.exec(title);
  return m ? m[1] : null;
}

/**
 * Annotate each initiative with whether a run for its key is already active
 * (Phase 4). Pure — takes the set of active keys — so the join is testable and
 * the board read stays a plain GitHub read. An initiative whose title has no
 * `[KEY-N]` (key null) is never marked in-progress.
 */
export function annotateBoardInProgress(board: BoardResult, activeKeys: ReadonlySet<string>): BoardResult {
  if (board.status !== 'ok') return board;
  return {
    ...board,
    project: {
      ...board.project,
      initiatives: board.project.initiatives.map((init) => {
        const key = boardInitiativeKey(init.item.title);
        return { ...init, inProgress: key !== null && activeKeys.has(key) };
      }),
    },
  };
}

/**
 * Read the board and annotate which initiatives already have an active local run
 * (Phase 4), so the Board view shows "In progress" rather than offering a second
 * Initiate. This is what the `db:projects:board` IPC serves.
 */
export async function getBoardWithRunState(projectNumber?: number): Promise<BoardResult> {
  const board = await fetchProjectBoard(projectNumber);
  const activeKeys = new Set(runsRepo.listActive().map((r) => r.initiativeKey));
  return annotateBoardInProgress(board, activeKeys);
}

/** The tracking key + child repos to initiate, or a refusal. Pure, so the decision is testable. */
export type BoardInitiatePlan =
  | { status: 'ok'; key: string; repos: string[] }
  | { status: 'refused'; refusals: { what: string; fix: string }[] };

/**
 * Decide what a board initiative would initiate: find it, check it's eligible,
 * and derive its `[KEY-N]` key. Refuses (never guesses) when the initiative is
 * gone, not eligible, or has no `[KEY-N]` title.
 */
export function planBoardInitiate(board: BoardResult, repo: string, issueNumber: number): BoardInitiatePlan {
  if (board.status !== 'ok') {
    return { status: 'refused', refusals: [{ what: 'the board could not be read', fix: board.problem }] };
  }
  const init = board.project.initiatives.find((i) => i.item.repo === repo && i.item.number === issueNumber);
  if (!init) {
    return { status: 'refused', refusals: [{ what: `initiative ${repo}#${issueNumber} is not on the board`, fix: 'Refresh the board and try again.' }] };
  }
  if (!init.eligible) {
    return { status: 'refused', refusals: [{ what: `${repo}#${issueNumber} is not eligible to start`, fix: 'Approve it for development on the board first.' }] };
  }
  const key = boardInitiativeKey(init.item.title);
  if (!key) {
    return { status: 'refused', refusals: [{ what: `initiative has no [KEY-N] title: ${init.item.title}`, fix: 'Give the tracking issue a [KEY-N] title prefix so runs can key on it.' }] };
  }
  return { status: 'ok', key, repos: init.repos };
}

/**
 * Initiate a cross-repo run straight from a board initiative (Phase 4). Re-reads
 * the board (freshness), then hands the key + child repos to the same
 * `prepareCrossRepoRun` a tester's manual pick uses — driving the proven
 * scope→arch→manifest→spawn bootstrap unchanged.
 */
export async function initiateFromBoard(
  projectNumber: number,
  repo: string,
  issueNumber: number,
): Promise<RunCrossRepoPrepareResult> {
  const plan = planBoardInitiate(await fetchProjectBoard(projectNumber), repo, issueNumber);
  if (plan.status === 'refused') return { status: 'refused', refusals: plan.refusals };
  // Defense in depth behind the UI's "In progress" state: never start a second
  // run for an initiative that already has one active. The board view is polled
  // and can lag, and a stale tab could otherwise double-initiate.
  if (runsRepo.listActive().some((r) => r.initiativeKey === plan.key)) {
    return {
      status: 'refused',
      refusals: [{ what: `${plan.key} already has an active run`, fix: 'Open the Runs tab to see it; there is nothing to start.' }],
    };
  }
  return prepareCrossRepoRun(plan.key, plan.repos);
}

/**
 * The proposed seam manifest for a cross-repo run awaiting approval (CO-722).
 *
 * The raw seams.yaml plus its merge order, read from disk -- the app never
 * depended on the published-to-issue copy. Null when there is no run or no
 * manifest yet, which the UI shows as "nothing to approve".
 */
export function readRunManifest(runId: string): SeamManifest | null {
  const run = runsRepo.getRun(runId);
  if (!run) return null;
  const seams = readIfPresent(path.join(run.initiativeDir, 'seams.yaml'));
  if (seams === null) return null;
  return { mergeOrder: mergeOrderFromSeams(seams), seamsYaml: seams };
}

/**
 * Judge the parked seam manifest for auto-approval (CO-722 B2).
 *
 * Reads the seams.yaml arch just wrote and runs the policy checks. A missing
 * file is itself a hold: arch reports `parked` only after writing it, so its
 * absence here means something removed it and a person should look.
 */
function evaluateManifest(run: RunRow): ManifestAnomaly {
  const seams = readIfPresent(path.join(run.initiativeDir, 'seams.yaml'));
  return manifestVerdict(seams, run.scopeRepos ?? []);
}

/**
 * Approve a cross-repo run's manifest: release it to spawn (CO-722).
 *
 * The bootstrap driver deliberately bypasses `transition()` here -- the pure
 * machine's `waitingHumanGate` exit spawns gate 2, which has no owner before
 * spawn. This records the event for the audit trail, then flips the run to
 * `spawning` + `preparing` so the loop re-picks it and the spawn step runs.
 * Guarded on `awaitingManifest` so a double-click cannot re-approve.
 */
export function approveRunManifest(runId: string): boolean {
  const run = runsRepo.getRun(runId);
  if (!run || run.bootstrapState !== 'awaitingManifest') return false;
  runsRepo.appendEvent(runId, 'humanApprovedGate', { gate: 1 });
  runsRepo.setBootstrapState(runId, 'spawning');
  runsRepo.setRunState(runId, 'preparing');
  log.info(`[RunLoop] ${runId}: manifest approved; spawning next`);
  return true;
}

/** Reject a manifest: park the run inconclusive with the reason. */
export function rejectRunManifest(runId: string, reason: string): boolean {
  const run = runsRepo.getRun(runId);
  if (!run || run.bootstrapState !== 'awaitingManifest') return false;
  runsRepo.recordTransition(runId, 'inconclusive', 'manifestRejected', {
    gate: 1,
    blockedReason: reason.trim() || 'the seam manifest was rejected',
  });
  return true;
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
