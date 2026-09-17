/**
 * The `arch` gate (gate 1) for a cross-repo run, driven from the app (CO-722).
 *
 * This is the one part of the cross-repo bootstrap that needs an LLM: the seam
 * manifest is a set of producer/consumer contracts across the in-scope repos,
 * read off both sides' live code, which a person cannot pick the way they pick
 * scope. So the app launches `arch` as a real print gate -- the same machinery
 * every reading gate uses (`launchGate`, the permission broker, the verdict
 * schema) -- with two differences from an owner gate: there is no worktree yet,
 * so it runs in the workspace root where the repo clones live; and there is no
 * owner, so its `run_gates` row and permission channel are keyed on the scope
 * sentinel (`SCOPE_REPO`).
 *
 * The verdict is the FILE plus the harness's own verifier, not the model's word
 * alone: a pass with no `seams.yaml`, or one `verify_seams.py` rejects, parks
 * the run inconclusive rather than advancing a manifest that is fiction.
 *
 * arch is gate 1, which the pure machine's `Gate` type (2|3|4) intentionally
 * excludes -- gate 1 never enters `transitions.ts`. `launchGate` uses the gate
 * only as a label (the prompt-file name and the channel key), so a single
 * documented bridge cast is the whole cost of reusing the machinery.
 */
import * as path from 'path';
import type { RunGateRow, RunRow, StartGateInput } from '../repositories/runs';
import type { GateLaunch } from './gate-launcher';
import type { GateOutcome } from './gate-process';
import type { CommandOutput } from './prepare-initiative';
import { channelKeyFor } from './gate-spawner';
import { readGateVerdict, type GateReading } from './gate-verdict';
import type { Gate } from './transitions';
import { SCOPE_REPO } from './bootstrap';

/** arch's gate number, bridged past the pure machine's `Gate` union (see file header). */
const ARCH_GATE = 1 as Gate;
const ARCH_AGENT = 'arch';

/** The app-level spawn settings the arch gate needs; per-run values come off the run. */
export interface ArchConfig {
  claudePath: string;
  promptFileDir: string;
  permissionsRoot: string;
  brokerPath: string;
  gateTimeoutMs: number;
}

/** Everything the arch gate touches, injected so the orchestration is testable dry. */
export interface ArchDeps {
  startGate(input: StartGateInput): void;
  activeGate(runId: string, repo: string): RunGateRow | null;
  finishGate(id: string, status: string, verdict?: unknown): void;
  launch(launch: GateLaunch): Promise<GateOutcome>;
  run(exe: string, argv: readonly string[], opts: { env?: Record<string, string> }): Promise<CommandOutput>;
  readFile(p: string): string | null;
  config: ArchConfig;
  newId(): string;
  /** The run's managed account config dir (#327), resolved by the wiring; null = ambient. */
  accountConfigDir?: string | null;
  log(line: string): void;
}

export type ArchResult = { status: 'parked' } | { status: 'inconclusive'; reason: string };

/**
 * Run gate 1 for a cross-repo run: author + verify the seam manifest, or say why
 * a person is needed. Returns `parked` when the manifest exists and verifies
 * (the run is ready for approval), `inconclusive` otherwise.
 *
 * Idempotent on resume: if `seams.yaml` is already present (arch wrote it but the
 * app closed before parking) it re-verifies rather than re-running the gate.
 */
export async function runArchGate(run: RunRow, deps: ArchDeps): Promise<ArchResult> {
  const seamsPath = path.join(run.initiativeDir, 'seams.yaml');

  // Resume: arch already authored the manifest. Re-verify, don't re-run.
  if (deps.readFile(seamsPath) !== null) {
    return verifyManifest(run, seamsPath, deps);
  }

  // Open the gate-1 row BEFORE the launch (the activeGate invariant the driver
  // keeps for owner gates), then read it back for the attempt the channel key
  // needs. Keyed on SCOPE_REPO so the inbox finds the same channel the broker
  // writes into.
  deps.startGate({
    id: deps.newId(),
    runId: run.id,
    gate: ARCH_GATE,
    repo: SCOPE_REPO,
    agent: ARCH_AGENT,
    posture: run.permissionPosture,
  });
  const turn = deps.activeGate(run.id, SCOPE_REPO);
  if (!turn) return { status: 'inconclusive', reason: 'the arch gate row could not be opened' };

  const outcome = await deps.launch({
    gate: ARCH_GATE,
    agentName: ARCH_AGENT,
    mode: 'print',
    prompt: archBrief(run),
    promptFileDir: deps.config.promptFileDir,
    permissions: {
      root: deps.config.permissionsRoot,
      brokerPath: deps.config.brokerPath,
      // Built from the row so it is byte-identical to what channelDirForGate
      // derives -- otherwise a person's answer lands in a directory arch is not
      // reading.
      channelKey: channelKeyFor(run.id, turn.repo ?? SCOPE_REPO, turn.gate, turn.agent, turn.attempt),
    },
    context: {
      harnessPath: run.harnessPath,
      bodhiRoot: run.bodhiRoot,
      // No worktree exists yet: arch reads across the repo clones under the
      // workspace root, on their integration branches.
      cwd: run.bodhiRoot,
      pythonPath: run.pythonPath,
      posture: run.permissionPosture,
      // The arch gate runs under the run's managed account (#327), not ambient.
      configDir: deps.accountConfigDir ?? null,
      sessionId: deps.newId(),
    },
    spawn: { executable: deps.config.claudePath, timeoutMs: deps.config.gateTimeoutMs },
  });

  if (outcome.status === 'undriveable') {
    deps.finishGate(turn.id, 'undriveable', { reason: outcome.reason, detail: outcome.detail });
    return { status: 'inconclusive', reason: `arch could not run: ${outcome.reason}` };
  }
  if (outcome.status === 'launched') {
    // Print mode never returns 'launched' (that is a --bg result); defensive.
    deps.finishGate(turn.id, 'inconclusive', { reason: 'unexpected background launch' });
    return { status: 'inconclusive', reason: 'arch returned no verdict (unexpected background launch)' };
  }

  const reading = readGateVerdict(outcome.structuredOutput);
  deps.finishGate(turn.id, 'done', reading);
  if (reading.verdict !== 'pass') {
    return { status: 'inconclusive', reason: reasonFor(reading) };
  }
  if (deps.readFile(seamsPath) === null) {
    // A pass with no manifest is the exact "verdict from nobody" the schema
    // guards against, one layer up: believe the file, not the word.
    return { status: 'inconclusive', reason: 'arch reported pass but wrote no seams.yaml' };
  }
  return verifyManifest(run, seamsPath, deps);
}

/** Run the harness verifier against the manifest; park when it fails. */
async function verifyManifest(run: RunRow, seamsPath: string, deps: ArchDeps): Promise<ArchResult> {
  const argv = [path.join(run.harnessPath, 'scripts', 'lib', 'verify_seams.py'), seamsPath];
  const result = await deps.run(run.pythonPath ?? 'python', argv, {});
  if (result.code !== 0) {
    return {
      status: 'inconclusive',
      reason: firstLine(result.stderr, result.stdout) ?? 'the seam manifest failed verification',
    };
  }
  deps.log(`${run.id}: seam manifest verified; awaiting manifest approval`);
  return { status: 'parked' };
}

/** The reason to show for a non-pass reading -- its own note, or its summary/finding. */
function reasonFor(reading: GateReading): string {
  if (reading.reason) return reading.reason;
  if (reading.summary) return reading.summary;
  if (reading.blocking[0]) return reading.blocking[0].what;
  return 'arch did not pass the seam manifest';
}

/** The task arch is given; its own body (arch.md) carries the how. */
function archBrief(run: RunRow): string {
  const repos = (run.scopeRepos ?? []).join(', ');
  return [
    '# This run',
    '',
    `initiative   ${run.initiativeKey}`,
    'gate         1 (arch / seam manifest)',
    `directory    ${run.initiativeDir}`,
    `harness      ${run.harnessPath}`,
    `workspace    ${run.bodhiRoot}`,
    repos ? `in scope     ${repos}` : '',
    '',
    'team.yaml (the in-scope repos and their briefs) is in the directory above.',
    'The repo clones are under the workspace path above; read them on their',
    'integration branches. Harness scripts are under the harness path, absolute.',
    '',
    '# Task',
    '',
    'Author the seam manifest for this initiative (gate 1). Read team.yaml for the',
    'in-scope repos, open each cross-repo contract on both sides’ live code, and write',
    'seams.yaml in the directory above -- every seam with its evidence, forbidden_keys,',
    'and the merge_order. Verify it with the harness before you finish, and return your',
    'gate verdict.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** The first non-empty line across the given texts, for a one-line reason. */
function firstLine(...texts: string[]): string | null {
  for (const text of texts) {
    const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (line) return line;
  }
  return null;
}
