/**
 * Drive the run engine by hand, one step at a time (CO-722).
 *
 *   bun run console -- arm    <initiative-dir> [--owner repo=agent]
 *   bun run console -- status
 *   bun run console -- events <run-id>
 *   bun run console -- step   <run-id> <event>
 *   bun run console -- perms  <run-id>
 *   bun run console -- answer <run-id> <tool-use-id> allow|deny [message]
 *   bun run console -- watch  <run-id>
 *   bun run console -- loop   [seconds]
 *
 * A first run is where assumptions get tested, and the ones this engine makes
 * are about paths, flags and which copy of the harness is on disk -- none of
 * which a test can check, because a test that supplied them would be
 * supplying the thing in doubt.
 *
 * So this is deliberately not a button. It arms a run and stops; each step
 * afterwards is a separate invocation, and the event log can be read between
 * any two of them. Nothing here decides anything: it calls the same `armRun`
 * and `advance` the app would, with the same real dependencies.
 *
 * ## It runs inside Electron, and that is the point
 *
 * Not a preference: `better-sqlite3` is built for Electron's ABI by
 * postinstall, so neither bun nor plain node can load it. Running here means
 * the console drives the same database module, the same native driver and the
 * same migrations the app does -- a console that swapped any of those would
 * be testing something other than what ships.
 *
 * ## It writes to a scratch store
 *
 * `app.setPath('userData', ...)` before anything opens a database, so a first
 * run that goes sideways cannot leave rows in the store the app reads on
 * start. `RUN_CONSOLE_DIR` chooses it; the default sits beside the repo.
 *
 * ## Nothing irreversible happens without a step that asks for it
 *
 * `arm` cuts nothing, launches nothing and pushes nothing: it checks the
 * machine, reads the initiative and writes rows. The first `step` that
 * reaches a gate is the first thing that spends anything, and it is a
 * separate command typed by a person.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getDatabase } from '../src/main/database';
import * as runs from '../src/main/repositories/runs';
import { armRun } from '../src/main/run-engine/ignition';
import { advance } from '../src/main/run-engine/driver';
import { GATE_BUSY_CEILING_MS } from '../src/main/run-engine/reconcile-loop';
import {
  agentsForRun,
  channelKeyFor,
  spawnGateFor,
  targetFor as engineTargetFor,
  type SpawnConfig,
} from '../src/main/run-engine/gate-spawner';
import { lookAtGate, type AttentionDeps } from '../src/main/run-engine/attention-pass';
import { createRunLoop } from '../src/main/run-engine/run-loop';
import { discoverPrArgv, readDiscoveredPr } from '../src/main/run-engine/pr-discovery';
import { reconcileOnce } from '../src/main/run-engine/reconcile';
import { runCommand, processDeps } from '../src/main/run-engine/command-runner';
import type { Gate, RunEvent } from '../src/main/run-engine/transitions';
import {
  channelDirFor,
  encodeDecision,
  isWaiting,
  readChannel,
  replyFileName,
  type PermissionDecision,
} from '../src/main/run-engine/permission-channel';

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

/**
 * Point Electron at a scratch store, before anything opens a database.
 *
 * Order matters and it is the only thing keeping a first run out of the app's
 * own file: `getDatabase` resolves its path from `app.getPath('userData')`
 * the first time it is called, and caches the handle.
 */
function useScratchStore(): string {
  const dir = path.resolve(process.env.RUN_CONSOLE_DIR ?? '.run-console');
  fs.mkdirSync(dir, { recursive: true });
  app.setPath('userData', dir);
  return dir;
}

/** Owners a person chose, as `--owner repo=agent`, repeatable. */
function chosenOwners(): Record<string, string> {
  const owners: Record<string, string> = {};
  process.argv.forEach((arg, i) => {
    if (arg !== '--owner') return;
    const [repo, agent] = (process.argv[i + 1] ?? '').split('=');
    if (repo && agent) owners[repo] = agent;
  });
  return owners;
}

function env(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

async function arm(): Promise<void> {
  const initiativePath = process.argv[3];
  if (!initiativePath) throw new Error('usage: arm <initiative-dir>');

  const request = {
    initiativePath,
    harnessPath: env('BODHI_HARNESS', 'C:/work/repos/claude-team-workflow'),
    bodhiRoot: env('BODHI_ROOT', 'C:/work/repos'),
    pythonPath: env('BODHI_PYTHON', 'python'),
    ghPath: env('BODHI_GH', 'gh'),
    posture: 'manual' as const,
    owners: chosenOwners(),
  };
  console.log('harness  ', request.harnessPath);
  console.log('python   ', request.pythonPath);
  console.log('');

  const result = await armRun(request, {
    run: (executable: string, argv: readonly string[]) =>
      runCommand(executable, argv, { timeoutMs: 60_000 }),
  });

  if (result.status === 'refused') {
    // Every refusal, not the first: the whole point of checking everything
    // before writing anything is that a person fixes one machine once.
    console.log('REFUSED. Nothing was written.\n');
    for (const refusal of result.refusals) {
      console.log(`  - ${refusal.what}`);
      console.log(`    fix: ${refusal.fix}\n`);
    }
    process.exitCode = 2;
    return;
  }

  console.log(`ARMED     ${result.runId}`);
  console.log(`initiative ${result.initiativeKey}`);
  for (const [repo, agent] of Object.entries(result.owners)) {
    console.log(`  ${repo} -> ${agent}`);
  }
  console.log('\nNothing has been cut, launched or pushed. To move it:');
  // Through the npm script, not the raw file: run directly under bun, the
  // `electron` import resolves to the package's path STRING rather than the
  // app API, and useScratchStore throws on app.setPath. A hand-off that
  // crashes if followed is worse than none.
  console.log(`  bun run console -- step ${result.runId} prepared`);
}

function status(): void {
  const rows = runs.listActiveRuns();
  if (rows.length === 0) {
    console.log('no active runs');
    return;
  }
  for (const run of rows) {
    console.log(`${run.id}  ${run.state.padEnd(20)} ${run.initiativeKey}`);
    if (run.blockedReason) console.log(`    ${run.blockedReason}`);
    for (const gate of runs.listGates(run.id)) {
      console.log(`    gate ${gate.gate} ${gate.status} (${gate.agent}, attempt ${gate.attempt})`);
    }
  }
  const inbox = runs.listInbox();
  console.log(`\ninbox: ${inbox.length} waiting on a person`);
}

function events(): void {
  const runId = process.argv[3];
  if (!runId) throw new Error('usage: events <run-id>');
  for (const event of runs.listEvents(runId)) {
    const detail = event.payloadJson ? ` ${event.payloadJson}` : '';
    console.log(`${event.at}  ${event.kind}${detail}`);
  }
}

/**
 * The run, shaped as the executor's target.
 *
 * Shared by every command that advances, so `perms` and `answer` cannot drift
 * from `step` on what a run IS -- two readings of the same row disagreeing is
 * how a run ends up advanced under a target nobody configured.
 */
function targetFor(runId: string) {
  const run = runs.getRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  const owners = runs.listOwners(runId);
  if (owners.length > 1) {
    // Not last-write-wins. `ExecutorTarget.agents` is keyed by GATE, so it
    // holds exactly one role for gate 2 -- which is sound for slice one,
    // where the design scopes a run to a single repo, and wrong the moment a
    // run has two owners. Refusing here says that; quietly keeping the last
    // owner would run one repo's gate under another repo's role.
    throw new Error(
      `run ${runId} has ${owners.length} owners (${owners.map((o) => o.repo).join(', ')}). ` +
      'This slice drives one repo: the gate-2 role is held per gate, not per repo.',
    );
  }
  // Gate 2's role is the owner's, recorded when the run was armed. Gates 3
  // and 4 are read from the harness, so they are not named here.
  const agents: Record<number, string> = {};
  if (owners[0]?.agent) agents[2] = owners[0].agent;

  return {
    repo: env('BODHI_REPO', ''),
    prNumber: Number(env('BODHI_PR', '0')) || null,
    // No default. Baking real logins into a tool makes it request review
    // from people who did not ask for it, and the engine already refuses
    // clearly when nobody is recorded.
    approvers: env('BODHI_APPROVERS', '').split(',').filter(Boolean),
    initiativePath: run.initiativeDir,
    harnessPath: run.harnessPath,
    pythonPath: run.pythonPath ?? 'python',
    agents,
    posture: run.permissionPosture,
  };
}

/**
 * Dependencies for an advance that must not DO anything.
 *
 * `permissionRequested` and `permissionAnswered` only move the run between
 * `running` and `waitingPermission`, and neither transition carries an
 * action. Passing the real `gh` and the real spawner would leave a gate that
 * is alive and working liable to be launched a second time by the act of
 * looking at it -- so these refuse instead, loudly, if the machine ever
 * decides otherwise.
 */
function stubDeps() {
  const refuse = (what: string) => async () => {
    throw new Error(`a permission command tried to ${what}, which it must never do`);
  };
  return {
    gh: refuse('call gh'),
    plugin: refuse('run a plugin script'),
    provision: refuse('provision'),
    spawnGate: refuse('launch a gate'),
  } as unknown as Parameters<typeof advance>[3];
}

async function step(): Promise<void> {
  const runId = process.argv[3];
  const kind = process.argv[4];
  if (!runId || !kind) throw new Error('usage: step <run-id> <event>');
  await driveEvent(runId, { kind } as RunEvent);
}

/**
 * Apply one event with the real dependencies, and say what happened.
 *
 * Shared by `step`, which takes the event from a person, and `watch`, which
 * derives it from a gate's receipt -- so a gate finishing by receipt spawns
 * the next gate exactly as one finishing by structured output does.
 */
/**
 * The environment-derived settings the console still allows, and what the
 * app will read from configuration instead. Every BODHI_* here was once the
 * only way a gate got launched; now each is a field on `SpawnConfig`.
 */
function spawnConfig(): SpawnConfig {
  return {
    claudePath: env('BODHI_CLAUDE', 'claude'),
    promptFileDir: path.join(process.cwd(), '.run-console-prompts'),
    permissionsRoot: permissionRoot(),
    brokerPath: path.join(__dirname, '..', 'scripts', 'permission-broker.js'),
    gateTimeoutMs: Number(env('BODHI_GATE_TIMEOUT', '900000')),
    modeFor: (gate) => env('BODHI_GATE_MODE', gate === 2 ? 'background' : 'print') as 'background' | 'print',
    taskFor: (gate, run) => env('BODHI_TASK', `Work gate ${gate} for ${run.initiativeKey}.`),
  };
}

function approvers(): string[] {
  // No default. Baking real logins into a tool makes it request review from
  // people who did not ask for it, and the engine refuses clearly when
  // nobody is recorded.
  return env('BODHI_APPROVERS', '').split(',').filter(Boolean);
}

/** The dependencies `advance` needs for one run, built the way the app will build them. */
async function executorFor(runId: string) {
  const run = runs.getRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  const owners = runs.listOwners(runId);
  if (owners.length > 1) {
    throw new Error(
      `run ${runId} has ${owners.length} owners (${owners.map((o) => o.repo).join(', ')}). ` +
      'This slice drives one repo: the gate-2 role is held per gate, not per repo.',
    );
  }
  const roles = await agentsForRun(run, owners);
  for (const note of roles.notes) console.log(`  note      ${note}`);
  const target = engineTargetFor(run, owners, roles.agents, approvers());
  const commands = processDeps({ ghPath: env('BODHI_GH', 'gh'), pythonPath: target.pythonPath });
  const spawnGate = spawnGateFor(run, owners, spawnConfig(), runs.activeGate, (line) => console.log(`  ${line}`));
  return { run, owners, target, deps: { ...commands, spawnGate } };
}

/**
 * Apply one event with the real dependencies, and say what happened.
 *
 * Shared by `step`, which takes the event from a person, `watch`, which
 * derives it from a gate's receipt, and `loop`, which derives it from
 * nobody -- so a gate finishing by receipt spawns the next gate exactly as
 * one finishing by structured output does.
 */
async function driveEvent(runId: string, event: RunEvent): Promise<void> {
  const { run, target, deps } = await executorFor(runId);
  console.log(`stepping ${runId}: ${run.state} + ${event.kind}\n`);
  const result = await advance(runId, event, target, deps);
  console.log(`\nstate     ${result.state}`);
  console.log(`applied   ${result.applied.map((e: { kind: string }) => e.kind).join(', ') || '(nothing)'}`);
  for (const problem of result.problems) console.log(`problem   ${problem}`);
  for (const note of result.notifications) console.log(`notify    ${note}`);
  if (result.runaway) console.log(`RUNAWAY   ${result.runaway}`);
}

/** Where every gate's channel lives, under the scratch store. */
function permissionRoot(): string {
  return path.join(process.cwd(), '.run-console-permissions');
}


/** The channel of the gate currently in flight, or null when none is. */
function activeChannel(runId: string): string | null {
  const gate = runs.activeGate(runId);
  if (!gate) return null;
  return channelDirFor(permissionRoot(), channelKeyFor(runId, gate.gate, gate.agent, gate.attempt));
}

function readActiveChannel(runId: string) {
  const dir = activeChannel(runId);
  if (!dir || !fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).map((name) => {
    try {
      return { name, text: fs.readFileSync(path.join(dir, name), 'utf8') };
    } catch {
      // Null rather than skipped: an unreadable request still blocks the gate.
      return { name, text: null };
    }
  });
  return { dir, reading: readChannel(files) };
}

/**
 * What the gate is stuck on, and move the run to say so.
 *
 * The event is applied here rather than by a person typing it, because
 * `waitingPermission` is a fact about the channel, not a decision anybody
 * makes. Answering is the decision.
 */
/**
 * Look at the gate in flight again (#287).
 *
 * A background gate reports by receipt, and until this nothing read it: the
 * gate finished, its process exited, and the run said `gate 2 running` for as
 * long as anyone cared to look. This gathers the two facts `attend` decides
 * from -- the receipt, and whether the session is alive -- and applies what
 * it decides through the same path `step` uses.
 */
async function watch(): Promise<void> {
  const runId = process.argv[3];
  if (!runId) throw new Error('usage: watch <run-id>');
  const run = runs.getRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  const gate = runs.activeGate(runId);
  if (!gate) {
    console.log('no gate in flight, so there is nothing to look at');
    return;
  }
  const look = await lookAtGate(run, gate, attentionDeps());
  const ran = look.runningForMs === null ? 'started at an unreadable time' : `running ${Math.round(look.runningForMs / 60_000)}m`;
  console.log(`gate ${look.gate} (${look.agent}, attempt ${look.attempt}, ${ran})`);
  console.log(`  receipt ${look.receiptVerdict ?? 'none'}  ${look.receiptPath}`);
  console.log(`  session ${gate.bgSessionId ?? '(not recorded)'}  status: ${look.status ?? 'unknown'}`);
  if (look.statusNote) console.log(`  note    ${look.statusNote}`);
  if (look.attention.note) console.log(`  note    ${look.attention.note}`);
  if (!look.attention.event) {
    console.log('nothing to do; as far as can be seen, the gate is working');
    return;
  }
  await driveEvent(runId, look.attention.event);
}

/** How the console reads the world for `attend`. The app reads it the same way. */
function attentionDeps(): AttentionDeps {
  return {
    readFile: readIfPresent,
    run: (executable, argv) => runCommand(executable, argv, { timeoutMs: 30_000 }),
    claudePath: env('BODHI_CLAUDE', 'claude'),
    now: () => Date.now(),
    busyCeilingMs: GATE_BUSY_CEILING_MS,
  };
}

/**
 * Run the engine's loop for a while, with nobody typing.
 *
 * This is the demonstration the whole console was built toward: arm a run,
 * step it once to `prepared`, then `loop`, and watch it go gate to gate --
 * receipts read, PRs found, checks reconciled -- with a person needed only
 * for permissions. The app does the same on a timer; this does it on a
 * timer you can see the end of.
 */
async function loop(): Promise<void> {
  const seconds = Number(process.argv[3] ?? '600');
  const tickMs = Number(env('BODHI_LOOP_TICK_MS', '15000'));
  const engine = createRunLoop({
    now: () => Date.now(),
    listActiveRuns: () => runs.listActiveRuns(),
    listOwners: (id) => runs.listOwners(id),
    activeGate: (id) => runs.activeGate(id),
    look: (run, gate) => lookAtGate(run, gate, attentionDeps()),
    discoverPr: async (_run, owner) => {
      const out = await runCommand(env('BODHI_GH', 'gh'), discoverPrArgv(owner.branch), { timeoutMs: 30_000, cwd: owner.worktree });
      return out.code === 0 ? readDiscoveredPr(out.stdout) : null;
    },
    recordPr: (run, owner, pr) => runs.recordOwnerPullRequest(run.id, owner.repo, { prNumber: pr.number, prUrl: pr.url }),
    reconcile: async (run, target) => {
      const commands = processDeps({ ghPath: env('BODHI_GH', 'gh'), pythonPath: run.pythonPath ?? 'python' });
      return reconcileOnce(target, commands);
    },
    advance: async (run, event) => {
      const { target, deps } = await executorFor(run.id);
      return advance(run.id, event, target, deps);
    },
    approvers,
    log: (line) => console.log(`  ${new Date().toISOString().slice(11, 19)}  ${line}`),
  });
  console.log(`looping for ${seconds}s, a tick every ${tickMs / 1000}s; ctrl-c to stop sooner\n`);
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const report = await engine.tick();
    const stamp = new Date(report.at).toISOString().slice(11, 19);
    if (report.due.length) {
      const bits = [
        ...report.looked.map((l) => `looked g${l.gate} ${l.agent}${l.decided ? ` -> ${l.decided}` : ''}`),
        ...report.reconciled.map((r) => `reconciled -> ${r.events.join(',') || 'nothing new'}`),
        ...report.skipped.map((sk) => `skipped: ${sk.why}`),
      ];
      console.log(`${stamp}  ${report.due.length} due: ${bits.join(' | ')}`);
    }
    for (const p of report.problems) console.log(`${stamp}  problem ${p.runId.slice(0, 8)}: ${p.problem}`);
    for (const id of report.escalated) console.log(`${stamp}  ESCALATE ${id.slice(0, 8)}: repeated failures; a person should look`);
    if (!runs.listActiveRuns().some((r) => r.state === 'running' || r.state === 'waitingChecks' || r.state === 'waitingReview' || r.state === 'reviewNotRequested')) {
      console.log(`${stamp}  nothing left that a loop can move; stopping`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
  status();
}

/** The file's text, or null when there is no file. Anything else is thrown. */
function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}


async function perms(): Promise<void> {
  const runId = process.argv[3];
  if (!runId) throw new Error('usage: perms <run-id>');
  const found = readActiveChannel(runId);
  if (!found) {
    console.log('no gate in flight, so nothing can be waiting on you');
    return;
  }
  const { dir, reading } = found;
  console.log(`channel   ${dir}`);
  for (const request of reading.pending) {
    console.log(`\nPENDING   ${request.toolUseId}`);
    console.log(`  tool    ${request.toolName}`);
    console.log(`  asked   ${request.askedAt}`);
    // Indented whole rather than truncated: a person approving a Bash call
    // is approving its command line, and an approval given against an
    // elided version is not an approval of what runs.
    const shown = JSON.stringify(request.input, null, 2).split('\n').join('\n          ');
    console.log(`  input   ${shown}`);
  }
  for (const bad of reading.unreadable) {
    console.log(`\nUNREADABLE ${bad.toolUseId}: ${bad.reason}`);
  }
  if (!isWaiting(reading)) {
    console.log('\nnothing pending');
    return;
  }
  const run = runs.getRun(runId);
  if (run && run.state === 'running') {
    const result = await advance(runId, { kind: 'permissionRequested' }, targetFor(runId), stubDeps());
    console.log(`\nstate     ${result.state}`);
  }
  console.log(`\nto answer: bun run console -- answer ${runId} <tool-use-id> allow`);
  console.log(`           bun run console -- answer ${runId} <tool-use-id> deny "why"`);
}

/** Write the decision the broker is waiting on, and let the run go again. */
async function answer(): Promise<void> {
  const [, , , runId, toolUseId, verdict, ...rest] = process.argv;
  if (!runId || !toolUseId || (verdict !== 'allow' && verdict !== 'deny')) {
    throw new Error('usage: answer <run-id> <tool-use-id> allow|deny [message]');
  }
  const dir = activeChannel(runId);
  if (!dir) throw new Error('no gate is in flight for that run');
  const message = rest.join(' ').trim();
  if (verdict === 'deny' && !message) {
    // A refusal the model cannot read teaches an owner to retry. The CLI
    // passes this through, so requiring it costs nothing and buys a gate
    // that knows WHY it was stopped.
    throw new Error('a refusal needs a message: answer <run-id> <id> deny "why"');
  }
  const decision: PermissionDecision =
    verdict === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message };
  fs.writeFileSync(path.join(dir, replyFileName(toolUseId)), encodeDecision(decision));
  console.log(`answered  ${toolUseId} ${verdict}`);

  const run = runs.getRun(runId);
  if (run && run.state === 'waitingPermission') {
    const result = await advance(runId, { kind: 'permissionAnswered' }, targetFor(runId), stubDeps());
    console.log(`state     ${result.state}`);
  }
}

async function main(): Promise<void> {
  const dir = useScratchStore();
  // The app's own getDatabase, with its pragmas, its tables and its
  // migrations. A console that built its own schema would be driving one
  // nobody ships.
  getDatabase();
  console.log(`store     ${dir}`);

  const command = process.argv[2];
  if (command === 'arm') await arm();
  else if (command === 'status') status();
  else if (command === 'events') events();
  else if (command === 'step') await step();
  else if (command === 'perms') await perms();
  else if (command === 'answer') await answer();
  else if (command === 'watch') await watch();
  else if (command === 'loop') await loop();
  else {
    console.log(`unknown command ${command ?? '(none)'}. See the header of this file.`);
    process.exitCode = 64;
  }
}

// Electron needs its own lifecycle even for a process that opens no window:
// quitting explicitly is what stops this sitting there afterwards.
void app.whenReady().then(async () => {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
  app.quit();
});
