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
import { launchGate } from '../src/main/run-engine/gate-launcher';
import { runCommand, processDeps } from '../src/main/run-engine/command-runner';
import type { Gate, RunEvent } from '../src/main/run-engine/transitions';

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

async function step(): Promise<void> {
  const runId = process.argv[3];
  const kind = process.argv[4];
  if (!runId || !kind) throw new Error('usage: step <run-id> <event>');

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

  const target = {
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

  const commands = processDeps({
    ghPath: env('BODHI_GH', 'gh'),
    pythonPath: target.pythonPath,
  });

  console.log(`stepping ${runId}: ${run.state} + ${kind}\n`);
  const result = await advance(runId, { kind } as RunEvent, target, {
    ...commands,
    spawnGate: async (gate: Gate) => {
      const owner = owners[0];
      console.log(`  launching gate ${gate} as ${agents[gate] ?? '(from harness)'}`);
      return launchGate({
        gate,
        agentName: agents[gate] ?? 'reviewer',
        mode: gate === 2 ? 'background' : 'print',
        prompt: env('BODHI_PROMPT', `Work gate ${gate} for ${run.initiativeKey}.`),
        promptFileDir: path.join(process.cwd(), '.run-console-prompts'),
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
