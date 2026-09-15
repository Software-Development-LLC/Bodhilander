/**
 * Drive the run engine by hand, one step at a time (CO-722).
 *
 *   bun run console -- arm    <initiative-dir> [--owner repo=agent]
 *   bun run console -- status
 *   bun run console -- events <run-id>
 *   bun run console -- step   <run-id> <event>
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
import { launchGate, rolesFromHarness } from '../src/main/run-engine/gate-launcher';
import { gateBrief } from '../src/main/run-engine/gate-brief';
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
  const run = runs.getRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  const owners = runs.listOwners(runId);
  // Gate 2's role is the repo's owner, recorded when the run was armed.
  // Gates 3 and 4 belong to the harness, so they are READ rather than held
  // here -- an engine carrying that mapping would have to maintain it
  // against a plugin that changes without it.
  const fromHarness = await rolesFromHarness(run.harnessPath, [3, 4]);
  // A list per gate, in run order. A single role is a one-element list; a
  // sequence is the harness's `gate_order`, read and not decided here.
  const agents: Record<number, string[]> = {};
  for (const [gate, role] of Object.entries(fromHarness.roles)) agents[Number(gate)] = [role];
  for (const seq of fromHarness.sequences) {
    agents[seq.gate] = [...seq.agents];
    console.log(`  gate ${seq.gate}    ${seq.agents.join(' then ')}`);
  }
  if (owners[0]?.agent) agents[2] = [owners[0].agent];
  for (const gate of fromHarness.unclaimed) {
    console.log(`  note      no agent in this harness declares gate ${gate}`);
  }
  for (const seq of fromHarness.unordered) {
    // Worse than a sequence, and worth saying differently: the harness put
    // several agents on this gate and did not say which comes first.
    console.log(`  note      gate ${seq.gate} has ${seq.agents.length} agents (${seq.agents.join(', ')}) and no declared order`);
  }
  const target = { ...targetFor(runId), agents };

  const commands = processDeps({
    ghPath: env('BODHI_GH', 'gh'),
    pythonPath: target.pythonPath,
  });

  console.log(`stepping ${runId}: ${run.state} + ${kind}\n`);
  const result = await advance(runId, { kind } as RunEvent, target, {
    ...commands,
    spawnGate: async (gate: Gate, agent: string) => {
      const owner = owners[0];
      // The row for this role's turn was opened by the driver before this
      // call, so it is the one thing that knows the attempt number -- and
      // therefore the channel key `perms` will look up.
      const turn = runs.activeGate(runId);
      console.log(`  launching gate ${gate} as ${agent}`);
      return launchGate({
        gate,
        agentName: agent,
        // Gate 2 is background by default so a long owner run does not hold
        // the console open. BODHI_GATE_MODE overrides it, because the
        // permission channel is only consulted in print mode -- `--help` says
        // `--permission-prompts` applies "with --print", and a background gate
        // starts the broker and then never asks it anything.
        mode: (env('BODHI_GATE_MODE', gate === 2 ? 'background' : 'print') as 'background' | 'print'),
        // The harness says HOW to work a gate; only the run knows WHAT it is
        // working on, and none of it is derivable from an agent file. The
        // first real launch was handed a bare sentence and opened by
        // guessing at directories that did not exist.
        prompt: gateBrief(
          {
            initiativeKey: run.initiativeKey,
            initiativePath: run.initiativeDir ?? '(not recorded)',
            repo: owner?.repo ?? '(not recorded)',
            worktree: owner?.worktree ?? process.cwd(),
            harnessPath: run.harnessPath,
            gate,
          },
          env('BODHI_TASK', `Work gate ${gate} for ${run.initiativeKey}.`),
        ),
        promptFileDir: path.join(process.cwd(), '.run-console-prompts'),
        // Without this a `manual` gate blocks on its first gated tool and
        // nothing can answer it (#288). The key is what `perms` looks up, so
        // it is built from what a person already has in front of them.
        permissions: {
          root: permissionRoot(),
          brokerPath: path.join(__dirname, '..', 'scripts', 'permission-broker.js'),
          channelKey: channelKeyFor(runId, gate, agent, turn?.attempt ?? 1),
        },
        context: {
          harnessPath: run.harnessPath,
          bodhiRoot: run.bodhiRoot,
          cwd: owner?.worktree ?? process.cwd(),
          pythonPath: run.pythonPath,
          posture: run.permissionPosture,
          sessionId: crypto.randomUUID(),
        },
        spawn: {
          executable: env('BODHI_CLAUDE', 'claude'),
          timeoutMs: Number(env('BODHI_GATE_TIMEOUT', '900000')),
        },
      });
    },
  });

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

/**
 * Names one role's turn at a gate.
 *
 * Run, gate, role and attempt, because those are what a person reading
 * `status` already has -- and because the verifier and the scribe are both
 * gate 4, so a key without the role would hand the scribe the verifier's
 * unanswered requests. A retry must not inherit its predecessor's either.
 */
function channelKeyFor(runId: string, gate: number, agent: string, attempt: number): string {
  return `${runId}-g${gate}-${agent}-a${attempt}`;
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
