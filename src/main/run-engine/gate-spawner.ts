/**
 * Turning a run into the things the executor needs to launch its gates (CO-722).
 *
 * The console grew this wiring one live run at a time: which roles serve
 * which gates, what a gate is told, where its permission channel lives, how
 * long it may run. Every piece was right and every piece lived in
 * `scripts/run-console.ts`, behind an environment variable -- which meant
 * the app could not run a gate at all, and a person was the dispatcher for
 * as long as that stayed true.
 *
 * This is that wiring as a module the app and the console both call. It
 * decides nothing new. Where the console read `BODHI_GATE_MODE` this takes a
 * function; where it read `BODHI_CLAUDE` this takes a path; where it logged,
 * this returns notes for the caller to print. The one thing it refuses is
 * the same thing the console refused: a spawn whose `run_gates` row is not
 * the one the driver just opened.
 */
import { randomUUID } from 'crypto';
import type { RunGateRow, RunOwnerRow, RunRow } from '../repositories/runs';
import type { ExecutorDeps, ExecutorTarget } from './executor';
import { gateBrief } from './gate-brief';
import type { GateMode } from './gate-command';
import { launchGate, rolesFromHarness } from './gate-launcher';
import { repoSlugFromUrl } from './pr-discovery';
import type { Gate } from './transitions';

export interface SpawnConfig {
  /** The `claude` executable. The app spawns it by name, as the PTY does. */
  claudePath: string;
  /** Where a print gate's role body is written for `--append-system-prompt-file`. */
  promptFileDir: string;
  /** Parent of the per-gate permission channel directories. */
  permissionsRoot: string;
  /** `permission-broker.js`, absolute, wherever this build keeps it. */
  brokerPath: string;
  /** How long a print gate may run before `runCommand` ends it. */
  gateTimeoutMs: number;
  /**
   * Which mode a gate runs in. Gate 2 is background by default so a long
   * owner run does not hold the caller; the reading gates are print, which
   * is the only mode that returns a structured verdict.
   */
  modeFor?: (gate: Gate) => GateMode;
  /**
   * The task text a gate is handed after its brief. The harness says HOW to
   * work a gate and the brief says WHAT run this is; this is the sentence in
   * between, and the default is deliberately plain.
   */
  taskFor?: (gate: Gate, run: RunRow) => string;
}

/** Roles per gate for this run, and what is worth saying about how they were found. */
export interface RunRoles {
  agents: Record<number, string[]>;
  notes: string[];
}

export const defaultModeFor = (gate: Gate): GateMode => (gate === 2 ? 'background' : 'print');
export const defaultTaskFor = (gate: Gate, run: RunRow): string => `Work gate ${gate} for ${run.initiativeKey}.`;

/**
 * Which role serves each gate of this run.
 *
 * Gate 2's is the repo's owner, recorded when the run was armed. Gates 3 and
 * 4 belong to the harness, so they are READ rather than held here -- an
 * engine carrying that mapping would have to maintain it against a plugin
 * that changes without it. A sequence is the harness's `gate_order`, read
 * and not decided here.
 */
export async function agentsForOwner(run: RunRow, owner: RunOwnerRow): Promise<RunRoles> {
  const fromHarness = await rolesFromHarness(run.harnessPath, [3, 4]);
  const agents: Record<number, string[]> = {};
  const notes: string[] = [];
  for (const [gate, role] of Object.entries(fromHarness.roles)) agents[Number(gate)] = [role];
  for (const seq of fromHarness.sequences) {
    agents[seq.gate] = [...seq.agents];
    notes.push(`gate ${seq.gate} runs ${seq.agents.join(' then ')}`);
  }
  // Gate 2 is THIS owner's role; gates 3 and 4 are the harness's, shared by
  // every owner of the run (CO-722 multi-owner).
  if (owner.agent) agents[2] = [owner.agent];
  for (const gate of fromHarness.unclaimed) notes.push(`no agent in this harness declares gate ${gate}`);
  for (const seq of fromHarness.unordered) {
    // Worse than a sequence, and said differently: the harness put several
    // agents on this gate and did not say which comes first.
    notes.push(`gate ${seq.gate} has ${seq.agents.length} agents (${seq.agents.join(', ')}) and no declared order`);
  }
  return { agents, notes };
}

/**
 * Names one role's turn at a gate, and so its permission channel.
 *
 * Run, repo, gate, role and attempt: the verifier and the scribe are both gate
 * 4, so a key without the role would hand the scribe the verifier's unanswered
 * requests, and a retry must not inherit its predecessor's either. The repo is
 * there because two owners share the gate-3/4 roles (CO-722 multi-owner), so
 * without it repo B's verifier and repo A's verifier would collide on one
 * channel -- and a person's decision would reach the wrong owner.
 */
export function channelKeyFor(
  runId: string,
  repo: string,
  gate: number,
  agent: string,
  attempt: number,
): string {
  return `${runId}-${repo}-g${gate}-${agent}-a${attempt}`;
}

/**
 * The run as the executor's target.
 *
 * The PR is the owner's: `pr_number` and `pr_url` on `run_owners`, recorded
 * when the loop discovers what the scribe opened. `repo` is `owner/name`
 * parsed from that URL, because the registry knows paths and not slugs, and
 * `gh --repo` wants the slug.
 */
export function targetFor(
  run: RunRow,
  owner: RunOwnerRow,
  agents: Record<number, string[]>,
  approvers: readonly string[],
): ExecutorTarget {
  return {
    repo: owner.prUrl ? repoSlugFromUrl(owner.prUrl) : null,
    prNumber: owner.prNumber ?? null,
    approvers: [...approvers],
    // NOT NULL in the schema and a non-optional `string` on RunRow, so there
    // is no null to guard: the console's old `?? '(not recorded)'` was dead
    // defensive code for a value that cannot be absent.
    initiativePath: run.initiativeDir,
    harnessPath: run.harnessPath,
    pythonPath: run.pythonPath ?? 'python',
    agents,
    posture: run.permissionPosture,
  };
}

/**
 * The `spawnGate` dependency for one run.
 *
 * `activeGate` is a dependency rather than an import so the refusal below is
 * assertable: the row for this role's turn was opened by the driver before
 * this is called, and it is the one thing that knows the attempt number --
 * and therefore the channel key a person will look up. Its absence is a
 * broken invariant, and a broken invariant that quietly defaulted would hand
 * this role a channel another turn already used.
 */
export function spawnGateFor(
  run: RunRow,
  owner: RunOwnerRow,
  config: SpawnConfig,
  activeGate: (runId: string, repo: string) => RunGateRow | null,
  log: (line: string) => void = () => undefined,
): ExecutorDeps['spawnGate'] {
  const modeFor = config.modeFor ?? defaultModeFor;
  const taskFor = config.taskFor ?? defaultTaskFor;
  return async (gate, agent) => {
    // THIS owner's turn: two owners can each have a gate in flight, so the
    // row this launch belongs to is found by repo, and the refusal below
    // compares repo too (CO-722 multi-owner).
    const turn = activeGate(run.id, owner.repo);
    if (!turn || turn.gate !== gate || turn.agent !== agent || turn.repo !== owner.repo) {
      const found = turn ? `gate ${turn.gate} (${turn.agent}) for ${turn.repo ?? '?'}` : 'missing';
      throw new Error(
        `gate ${gate} (${agent}) for ${owner.repo} was asked to launch but the open run_gates row is ${found}; ` +
          'the driver opens the row before it spawns',
      );
    }
    log(`launching gate ${gate} as ${agent} for ${owner.repo}`);
    return launchGate({
      gate,
      agentName: agent,
      mode: modeFor(gate),
      prompt: gateBrief(
        {
          initiativeKey: run.initiativeKey,
          initiativePath: run.initiativeDir,
          repo: owner.repo,
          worktree: owner.worktree,
          harnessPath: run.harnessPath,
          gate,
        },
        taskFor(gate, run),
      ),
      promptFileDir: config.promptFileDir,
      permissions: {
        root: config.permissionsRoot,
        brokerPath: config.brokerPath,
        channelKey: channelKeyFor(run.id, owner.repo, gate, agent, turn.attempt),
      },
      context: {
        harnessPath: run.harnessPath,
        bodhiRoot: run.bodhiRoot,
        cwd: owner.worktree,
        pythonPath: run.pythonPath,
        posture: run.permissionPosture,
        sessionId: randomUUID(),
      },
      spawn: { executable: config.claudePath, timeoutMs: config.gateTimeoutMs },
    });
  };
}
