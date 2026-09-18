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
import type { PermissionPosture } from '../repositories/runs';

export interface ExecutorDeps {
  gh(argv: readonly string[]): Promise<CommandResult>;
  plugin(argv: readonly string[], stdin?: string): Promise<CommandResult>;
  /**
   * Provisioning, which is a plugin call with a different clock.
   *
   * Separate from `plugin` because the two are not the same kind of work and
   * one deadline cannot serve both. Every other plugin call reads something
   * and answers in about a second; provisioning installs a dependency tree
   * and compiles native modules, and takes minutes on a cold worktree.
   *
   * Sharing `plugin`'s deadline cost a real run: the install was killed
   * part-way and reported as `python did not finish within 60000ms`, which
   * sends whoever reads that line to look at Python. The install's own
   * failure -- the thing actually wrong -- was never printed, because the
   * process that would have printed it had been killed.
   *
   * As of Phase 3 this runs the config repo's per-repo `provision` command in
   * each worktree (TS — `provision.ts`), not `provision.py`; the wiring knows
   * the run's owners, so it takes no argv and reports a `CommandResult`-shaped
   * summary (`code` mapping through `provisionEvent`, `stdout` the log).
   */
  provision(): Promise<CommandResult>;
  /**
   * Launch one gate as one role. The launcher owns resolving the role to an
   * agent file; this owns what the outcome meant.
   *
   * The role is named by the caller because a gate can be served by several
   * in sequence -- gate 4 is verifier and then scribe -- and WHICH of them
   * is running is a fact the driver holds and this module must not guess at.
   */
  spawnGate(gate: Gate, agent: string): Promise<GateOutcome>;
}

/**
 * A decision's actions, with every spawn resolved to the role that serves it.
 *
 * The machine says `spawnGate 4`; it does not know who serves gate 4 and must
 * not. The driver knows -- it opened the `run_gates` row -- and hands this
 * module an action that says so, rather than this module reaching into
 * `target.agents` and picking, which would put the sequencing decision in
 * two places.
 */
export type ResolvedAction =
  | Exclude<RunAction, { kind: 'spawnGate' }>
  | { kind: 'spawnGate'; gate: Gate; agent: string };

export interface ExecutorTarget {
  /** `owner/name`, as `gh --repo` takes it. Null before a PR exists. */
  repo: string | null;
  prNumber: number | null;
  /** Who to ask. Empty means nobody can be asked, which is a problem, not a silence. */
  approvers: readonly string[];
  /** The initiative directory `provision.sh` reads worktrees out of. */
  initiativePath: string | null;
  /**
   * Which role serves each gate on THIS run.
   *
   * Gate 2's is the repo's owner, read from the run; gates 3 and 4 come from
   * the harness's own `gate:` declarations. Supplied as data because the
   * engine must not hold that mapping — and a gate with no role recorded is
   * refused rather than launched under a placeholder, because the column
   * exists precisely so somebody can tell afterwards who ran.
   *
   * A LIST, in run order, because a gate can be a sequence: gate 4 is the
   * verifier and then the scribe, and both run. Most gates are one role, and
   * a one-element list says so without a second shape for the common case.
   * The order is the harness's (`gate_order:`), read and never decided here.
   */
  agents: Partial<Record<Gate, readonly string[]>>;
  /**
   * How this run answers permission prompts.
   *
   * Recorded per gate rather than per run, because if you cannot tell
   * afterwards whether an owner ran unsandboxed, you cannot trust what it
   * produced.
   */
  posture: PermissionPosture;
  harnessPath: string;
  pythonPath: string;
}

/** A gate that started in the background, and the session it became. */
export interface LaunchedGate {
  gate: Gate;
  sessionId: string;
  backgroundId: string;
}

export interface ExecutorResult {
  events: RunEvent[];
  /**
   * Background gates that launched during these actions.
   *
   * `launched` produces no event -- the verdict comes later, by receipt --
   * but the session it became must be written down, or nothing can look at
   * the gate again (#287). Reported here rather than recorded here because
   * this module writes no state; the driver owns the rows.
   */
  launched: LaunchedGate[];
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
export function provisionEvent(code: number, detail?: string): RunEvent {
  if (code === 0 || code === 3) return { kind: 'provisioned' };
  if (code === 1) return { kind: 'provisionFailed', reason: detail };
  return { kind: 'provisionUndriveable' };
}

/** Cap a reason so a runaway install log can't flood blocked_reason. */
const MAX_REASON_CHARS = 600;
function clampReason(text: string): string {
  return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS)}… (truncated)`;
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
    // Carry WHY into the event so the run's blocked_reason names it: the generic
    // reason for context, plus the gate's own captured output when there is any.
    const reason = outcome.detail ? `${outcome.reason} — ${outcome.detail}` : outcome.reason;
    return { kind: 'gateFinished', gate, verdict: 'inconclusive', reason };
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
  const run = await deps.provision();
  // provisionRun's log — a per-repo summary that already condenses each failing
  // install to its first line, NOT the raw multi-line install blob. Capped so a
  // pathological log can't flood a persisted blocked_reason or a notification.
  const detail = clampReason(run.stdout.trim() || run.stderr.trim() || `provision exited ${run.code}`);
  const event = provisionEvent(run.code, detail);
  result.events.push(event);
  if (event.kind !== 'provisioned') {
    // The event moves the run; this is for the person who has to fix it, and
    // the plugin's own output says more than a code can.
    result.notifications.push(detail);
  }
}

/**
 * Perform one action, and say whether the rest of the decision may proceed.
 *
 * Returns the reason to halt, or null. Separate from the loop because the two
 * are different jobs — this one knows what each action means, the loop knows
 * what a failure costs the ones after it — and because a switch that also
 * carried the skip logic and the error handling was one function doing three
 * things, which is what Sonar counted.
 */
async function performAction(
  action: ResolvedAction,
  target: ExecutorTarget,
  deps: ExecutorDeps,
  result: ExecutorResult,
): Promise<string | null> {
  switch (action.kind) {
    case 'provision': {
      const before = result.events.length;
      await provision(target, deps, result);
      const event = result.events[before];
      return event?.kind === 'provisioned' ? null : 'the worktrees were not provisioned';
    }
    case 'requestReview': {
      const before = result.events.length;
      await requestReview(target, deps, result);
      return result.events.length === before ? 'the review was not requested' : null;
    }
    case 'spawnGate': {
      const outcome = await deps.spawnGate(action.gate, action.agent);
      const event = gateEvent(action.gate, outcome);
      if (event) result.events.push(event);
      if (outcome.status === 'launched') {
        result.launched.push({ gate: action.gate, sessionId: outcome.sessionId, backgroundId: outcome.backgroundId });
      }
      if (outcome.status !== 'undriveable') return null;
      result.notifications.push(outcome.reason);
      return `gate ${action.gate} could not be driven`;
    }
    case 'notify':
      result.notifications.push(action.reason);
      return null;
    case 'release':
      // Nothing to undo and nothing to call. Attending is something the
      // caller stops doing, so saying so is the whole action.
      result.released = true;
      return null;
    default:
      // `reconcile` lands here and does nothing on purpose: the loop owns
      // when to ask, and a pass here would ask twice for one decision and
      // race the pass already scheduled.
      return null;
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
  actions: readonly ResolvedAction[],
  target: ExecutorTarget,
  deps: ExecutorDeps,
): Promise<ExecutorResult> {
  const result: ExecutorResult = {
    events: [],
    launched: [],
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
      halted = await performAction(action, target, deps, result);
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
