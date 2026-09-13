/**
 * Doing what the machine decided (CO-722).
 *
 * `transitions` names actions as data so that "did it decide to request
 * review?" is an assertion rather than an observation of side effects. This
 * is where the data becomes side effects, and it is the first module in the
 * engine that CHANGES anything outside this process — it asks GitHub to
 * notify a person, and it installs into a worktree.
 *
 * Two rules shape all of it.
 *
 * **An action that failed is not a run that failed.** `gh` refusing to add a
 * reviewer says nothing about the branch. The run stays where it is, the
 * problem is reported, and the next attention pass tries again — which is
 * why `reconcile-loop` gives `reviewNotRequested` a cadence of its own: a
 * state the engine acts on needs re-attempting, not re-asking.
 *
 * **An action that succeeded is reported as an event, not assumed.** The
 * caller applies the events; nothing here writes state. That keeps the
 * decision and the doing separable, and it is what makes a failed request
 * leave the run in `reviewNotRequested` rather than in a state that claims
 * somebody was asked.
 *
 * What this module does NOT do is decide. `spawnGate` arrives as a dependency
 * because launching a gate means resolving an agent file out of the pinned
 * harness and writing its body to disk — a slice of its own, and one that
 * must not be able to change what a verdict means on its way past.
 */
import type { Gate, RunAction, RunEvent } from './transitions';
import type { GateOutcome } from './gate-process';
import { readGateVerdict } from './gate-verdict';
import type { CommandResult } from './reconcile';

export interface ExecutorDeps {
  gh(argv: readonly string[]): Promise<CommandResult>;
  plugin(argv: readonly string[], stdin?: string): Promise<CommandResult>;
  /** Launch one gate. The launcher owns agent resolution; this owns what it meant. */
  spawnGate(gate: Gate): Promise<GateOutcome>;
}

export interface ExecutorTarget {
  /** `owner/name`, as `gh --repo` takes it. Null before a PR exists. */
  repo: string | null;
  prNumber: number | null;
  /** Who to ask. Empty means nobody can be asked, which is a problem, not a silence. */
  approvers: readonly string[];
  /** The initiative directory `provision.sh` reads worktrees out of. */
  initiativePath: string | null;
  harnessPath: string;
  pythonPath: string;
}

export interface ExecutorResult {
  events: RunEvent[];
  /** Retryable. The run stays put and the next attention pass tries again. */
  problems: string[];
  /** Reasons a person should be told, in the order they were produced. */
  notifications: string[];
  /** True once `release` ran: stop attending to this run. */
  released: boolean;
}

/**
 * `provision.sh`'s exit code as an event.
 *
 * The mapping is the plugin's own contract, unchanged: 0 installed, 1 an
 * install ran and failed, 2 nothing could be run here, 3 nothing was owed.
 * The last one is a provisioned run, not a fault — a repo recording neither
 * `pkg` nor `lang` has nothing to install, and stopping for it would block
 * every Go and dotnet repo on a step that does not apply to them.
 */
export function provisionEvent(code: number): RunEvent {
  if (code === 0 || code === 3) return { kind: 'provisioned' };
  if (code === 1) return { kind: 'provisionFailed' };
  return { kind: 'provisionUndriveable' };
}

/**
 * What launching a gate established.
 *
 * A background gate that launched produces NO event: it is running, and its
 * verdict arrives later in a receipt. Saying anything here would be saying it
 * before the gate has done the work.
 */
export function gateEvent(gate: Gate, outcome: GateOutcome): RunEvent | null {
  if (outcome.status === 'launched') return null;
  if (outcome.status === 'undriveable') {
    return { kind: 'gateFinished', gate, verdict: 'inconclusive' };
  }
  return { kind: 'gateFinished', gate, verdict: readGateVerdict(outcome.structuredOutput).verdict };
}

async function requestReview(
  target: ExecutorTarget,
  deps: ExecutorDeps,
  result: ExecutorResult,
): Promise<void> {
  if (target.approvers.length === 0) {
    // Not a silence to wait out. Nothing is coming, and the run would sit in
    // reviewNotRequested re-attempting an empty request forever.
    result.problems.push('no approvers recorded for this run, so nobody can be asked to review');
    return;
  }
  if (!target.repo || target.prNumber === null) {
    result.problems.push('cannot request review before a PR exists');
    return;
  }
  const run = await deps.gh([
    'pr',
    'edit',
    String(target.prNumber),
    '--repo',
    target.repo,
    '--add-reviewer',
    target.approvers.join(','),
  ]);
  if (run.code !== 0) {
    const why = run.stderr.trim() || `exit ${run.code}`;
    result.problems.push(`could not request review on ${target.repo}#${target.prNumber}: ${why}`);
    return;
  }
  // Only now. The event says a person was asked, and it must not be recorded
  // by anything that did not confirm the asking.
  result.events.push({ kind: 'reviewRequested' });
}

async function provision(
  target: ExecutorTarget,
  deps: ExecutorDeps,
  result: ExecutorResult,
): Promise<void> {
  if (!target.initiativePath) {
    result.problems.push('cannot provision without an initiative directory');
    return;
  }
  const run = await deps.plugin([
    target.pythonPath,
    `${target.harnessPath}/scripts/lib/provision.py`,
    target.initiativePath,
  ]);
  const event = provisionEvent(run.code);
  result.events.push(event);
  if (event.kind !== 'provisioned') {
    // The event moves the run; this is for the person who has to fix it, and
    // the plugin's own output says more than a code can.
    result.notifications.push(run.stdout.trim() || run.stderr.trim() || `provision exited ${run.code}`);
  }
}

/**
 * Perform a decision's actions, in order, stopping at the first that failed.
 *
 * In order because they ARE ordered: a decision that provisions and then
 * spawns a gate means the install happens first. Stopping because ordering
 * alone does not deliver that — an install that fails and a gate launched
 * anyway is an owner started in a worktree with no dependencies, which is
 * exactly the failure `verify.sh` now reports as undriveable, arrived at by
 * the engine rather than by a person.
 *
 * `notify` is the one action that still runs after a halt. It changes nothing
 * outside the process; it is how a person finds out. Suppressing it would
 * make the halt itself the quietest thing in the run.
 *
 * `release` is NOT exempt. Releasing a run whose actions failed stops the
 * engine attending to the one run that most needs attending to.
 */
export async function execute(
  actions: readonly RunAction[],
  target: ExecutorTarget,
  deps: ExecutorDeps,
): Promise<ExecutorResult> {
  const result: ExecutorResult = {
    events: [],
    problems: [],
    notifications: [],
    released: false,
  };
  /** Why the rest of this decision is not being performed, once something is. */
  let halted: string | null = null;

  for (const action of actions) {
    if (halted !== null && action.kind !== 'notify') {
      // Named rather than skipped silently: a decision that half happened is
      // a run whose state and world disagree, and the caller has to know
      // which half.
      result.problems.push(`${action.kind} was not performed: ${halted}`);
      continue;
    }

    try {
      switch (action.kind) {
        case 'provision': {
          const before = result.events.length;
          await provision(target, deps, result);
          const event = result.events[before];
          if (!event || event.kind !== 'provisioned') {
            halted = 'the worktrees were not provisioned';
          }
          break;
        }
        case 'requestReview': {
          const before = result.events.length;
          await requestReview(target, deps, result);
          if (result.events.length === before) halted = 'the review was not requested';
          break;
        }
        case 'spawnGate': {
          const outcome = await deps.spawnGate(action.gate);
          const event = gateEvent(action.gate, outcome);
          if (event) result.events.push(event);
          if (outcome.status === 'undriveable') {
            result.notifications.push(outcome.reason);
            halted = `gate ${action.gate} could not be driven`;
          }
          break;
        }
        case 'notify':
          result.notifications.push(action.reason);
          break;
        case 'release':
          // Nothing to undo and nothing to call. Attending is something the
          // caller stops doing, so saying so is the whole action.
          result.released = true;
          break;
        case 'reconcile':
          // The loop owns when to ask. Performing a pass here would ask twice
          // for one decision and race the pass already scheduled.
          break;
        default:
          break;
      }
    } catch (error) {
      // The dependencies are documented not to throw, and one of them can:
      // `runGate` throws synchronously for a call it cannot make at all — no
      // executable, an argv past the Windows ceiling. Letting that escape
      // would lose every event and problem already collected in this call,
      // including the ones that explain how the run got here.
      const why = error instanceof Error ? error.message : String(error);
      result.problems.push(`${action.kind} could not be performed: ${why}`);
      halted = `${action.kind} raised before it could run`;
    }
  }

  return result;
}
