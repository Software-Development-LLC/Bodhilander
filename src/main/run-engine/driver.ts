/**
 * Advancing a run, durably (CO-722).
 *
 * Every other module in this engine is a half: `transitions` decides and
 * touches nothing, `executor` acts and decides nothing, the repository writes
 * and knows nothing about either. This is where they meet, and the order they
 * meet in is the whole design.
 *
 * **Persist before acting.** The transition is written first, in one
 * transaction with the event that caused it, and only then are the actions
 * performed. Acting first and recording afterwards loses the record of
 * anything that crashes mid-action — and the actions here start agents and
 * ask people for things, so "did that already happen?" is a question somebody
 * would otherwise have to answer by looking at GitHub.
 *
 * The cost of that order is that an action can fail after its transition is
 * recorded, leaving a run whose state says more than the world does. That is
 * the lesser problem and it is already handled: the executor reports rather
 * than assumes, so nothing false is recorded, and the run sits in a state the
 * loop re-attends. A run one minute stale is better than a run whose history
 * has a hole in it.
 *
 * **The loop is bounded.** Events produce actions which produce events, and
 * the machine has cycles by design — gate 3 sends a run back to gate 2, which
 * comes forward again. A cycle that does not settle is a run that would spin
 * for as long as the process lives, so this stops after a fixed number of
 * steps and says so. The number is not a tuning knob: it is a tripwire, and
 * hitting it means something is wrong rather than something is busy.
 */
import type { Gate, RunAction, RunEvent, RunState } from './transitions';
import { transition } from './transitions';
import {
  execute,
  type ExecutorDeps,
  type ExecutorResult,
  type ExecutorTarget,
  type ResolvedAction,
} from './executor';
import { randomUUID } from 'crypto';
import * as runs from '../repositories/runs';

/**
 * How many decide-act rounds one call may take.
 *
 * A real advance takes one or two: an event decides a state, its actions
 * produce at most one event that decides another. Eight is far past anything
 * legitimate and still small enough to stop before a log fills.
 */
export const MAX_ROUNDS = 8;

export interface AdvanceResult {
  /** Where the run ended up. */
  state: RunState;
  /** Every event applied, in order — including ones the actions produced. */
  applied: RunEvent[];
  problems: string[];
  notifications: string[];
  released: boolean;
  /** Set when the round limit stopped the loop. Always a fault, never a wait. */
  runaway: string | null;
}

/**
 * A gate number from the database, if it is one this machine drives.
 *
 * Narrowed rather than cast. A row carrying a gate this engine does not know
 * — a column written by a later version, a value somebody edited — is not an
 * active gate, and asserting it into the type would hand the machine a state
 * it has no handler for.
 */
function asGate(value: number | null | undefined): Gate | null {
  return value === 2 || value === 3 || value === 4 ? value : null;
}

/**
 * The detail an event carries into the log.
 *
 * Kept narrow on purpose: the log is read by a person asking what happened,
 * and an event carrying the whole payload of everything is one nobody reads.
 */
function detailFor(event: RunEvent): runs.EventDetail {
  if (event.kind === 'gateFinished') {
    return { gate: event.gate, payload: { verdict: event.verdict } };
  }
  if (event.kind === 'reviewChangesRequested') return { payload: event.verdict };
  if (event.kind === 'checksUndriveable' || event.kind === 'reviewUndriveable') {
    return { payload: { reason: event.reason } };
  }
  return {};
}

/** The two states that must say why they stopped. */
function blockedReasonFor(state: RunState, event: RunEvent, note: string): string | null {
  if (state !== 'inconclusive' && state !== 'failed') return null;
  if (event.kind === 'checksUndriveable' || event.kind === 'reviewUndriveable') {
    return event.reason;
  }
  // The machine's own note, which names the transition that stopped the run.
  // Better than a generic sentence: it is written where the decision was.
  return note;
}

/**
 * Apply one event, persist the result, perform what it decided, and repeat
 * with whatever those actions established.
 *
 * Reads the state from the DATABASE rather than taking it as an argument.
 * Two things can advance a run — a reconcile pass and a gate finishing — and
 * a caller holding a state it read a minute ago would overwrite the other's
 * work with a decision made from a stale position.
 */
export function advance(
  runId: string,
  first: RunEvent,
  target: ExecutorTarget,
  deps: ExecutorDeps,
): Promise<AdvanceResult> {
  // One at a time per run. Two things advance a run -- a reconcile pass and a
  // gate reporting back -- and they arrive independently. Reading the state,
  // deciding, and writing it are three steps with an `await` in the middle,
  // so two calls interleaving would have the second decide from a position
  // the first is in the middle of leaving.
  //
  // A promise chain rather than a lock: there is nothing to time out and
  // nothing to deadlock, and a caller that never gets a turn is a caller
  // whose predecessor never returned, which is a different bug and a louder
  // one. Runs do not block each other -- the chain is per run id.
  const queued = (inFlight.get(runId) ?? Promise.resolve()).then(() =>
    advanceOnce(runId, first, target, deps),
  );
  // Kept even when it rejects, so one failure does not wedge the run's queue.
  inFlight.set(
    runId,
    queued.then(
      () => undefined,
      () => undefined,
    ),
  );
  return queued;
}

/** One run's turn, held only while that run is advancing. */
const inFlight = new Map<string, Promise<void>>();

async function advanceOnce(
  runId: string,
  first: RunEvent,
  target: ExecutorTarget,
  deps: ExecutorDeps,
): Promise<AdvanceResult> {
  const result: AdvanceResult = {
    state: 'preparing',
    applied: [],
    problems: [],
    notifications: [],
    released: false,
    runaway: null,
  };

  let pending: RunEvent[] = [first];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (pending.length === 0) return result;

    const next: RunEvent[] = [];
    for (const event of pending) {
      const run = runs.getRun(runId);
      if (!run) {
        result.problems.push(`run ${runId} is not in the database`);
        return result;
      }
      const gate = runs.activeGate(runId);

      // A step passing is not the gate passing -- see `continueSequence`.
      // Handled before the machine hears anything, and the machine hears
      // nothing at all if there was a next role to run.
      const nextStep = await continueSequence(runId, event, gate, target, deps, result);
      if (nextStep) {
        next.push(...nextStep);
        continue;
      }

      const decision = transition(run.state, event, { activeGate: asGate(gate?.gate) });
      result.state = decision.state;
      recordDecision(runId, run.state, event, gate, decision, result);

      // Recorded BEFORE the gate runs, for the same reason the transition is:
      // a gate that starts and then crashes must leave a row, and the guard
      // that stops a stale report from regressing the run reads that row.
      const actions = openGates(runId, decision, target, result);
      const performed = await execute(actions, target, deps);
      recordLaunches(runId, performed);
      collect(result, performed);
      next.push(...performed.events);
    }
    pending = next;
  }

  // STILL producing events, which is not the same as having used every round.
  // A run that settles on the last permitted round exits the loop here too,
  // and reporting that as a cycle would put a fault on a run that finished
  // correctly — it merely took the long way.
  if (pending.length > 0) {
    result.runaway =
      `stopped after ${MAX_ROUNDS} rounds still producing events. This is a cycle, not progress.`;
    result.problems.push(result.runaway);
  }
  return result;
}

/**
 * Open a `run_gates` row for every gate this decision spawns, and return the
 * actions that may go ahead.
 *
 * Before the spawn, not after: the activeGate guard — the one that stops a
 * late gate-2 verdict from pulling a run back past gate 4 — reads this table,
 * and a gate whose row appears afterwards is a gate whose own report is
 * rejected. Ordering it the other way looks identical on every happy path,
 * which is exactly why it is asserted against a crash.
 *
 * A gate with no role recorded is DROPPED, not merely unrecorded.
 * `run_gates.agent` exists so somebody can tell afterwards who ran, and a
 * gate that runs with no row is worse than one that does not run: it spends
 * tokens, changes a worktree, and leaves nothing saying it happened.
 */
function openGates(
  runId: string,
  decision: { actions: readonly RunAction[] },
  target: ExecutorTarget,
  result: AdvanceResult,
): ResolvedAction[] {
  const allowed: ResolvedAction[] = [];
  for (const action of decision.actions) {
    if (action.kind !== 'spawnGate') {
      allowed.push(action);
      continue;
    }
    // The machine names the gate; the run's roles say who serves it, and a
    // sequence starts at its first role. Later steps are opened by
    // `stepAfter`, on the previous step's report -- never here.
    const first = target.agents[action.gate]?.[0];
    if (!first) {
      result.problems.push(
        `gate ${action.gate} has no role recorded for this run, so it was not started`,
      );
      continue;
    }
    allowed.push(startStep(runId, action.gate, first, target));
  }
  return allowed;
}

/**
 * Write the decision down, when there is something to write.
 *
 * Recorded when something HAPPENED, which is not the same as when the state
 * changed. A gate-2 pass leaves a run in `running` and spawns gate 3: no
 * move, and the most important line in the log. An event that changes
 * nothing AND does nothing is the one worth omitting, because a log full of
 * rows saying "nothing happened" is a log nobody reads.
 *
 * The gate row is closed here, once the machine has ACCEPTED the report --
 * not when it arrived. Closing first clears activeGate, and the guard then
 * rejects the very report that was closing it: a gate finishes, its verdict
 * is discarded, and the run sits in `running` forever. That is not
 * hypothetical; it is what the driver tests caught.
 */
function recordDecision(
  runId: string,
  before: RunState,
  event: RunEvent,
  gate: runs.RunGateRow | null,
  decision: { state: RunState; actions: readonly RunAction[]; note: string },
  result: AdvanceResult,
): void {
  if (decision.state === before && decision.actions.length === 0) return;
  const reason = blockedReasonFor(decision.state, event, decision.note);
  writeTransition(runId, decision.state, event.kind, {
    ...detailFor(event),
    blockedReason: reason ?? undefined,
  });
  result.applied.push(event);
  if (event.kind === 'gateFinished' && gate?.gate === event.gate) {
    runs.finishGate(gate.id, 'done', { verdict: event.verdict });
  }
}

/**
 * Run the next role of a gate whose previous role just passed.
 *
 * Gate 4 is the verifier and then the scribe. When the verifier's report
 * arrives the gate is half done, and telling the machine `gateFinished`
 * there would send the run to waitingChecks with no PR open -- the scribe,
 * the only role that opens one, has not run. So this closes the step's row,
 * opens the next, spawns it, and returns what that spawn produced; the caller
 * then says NOTHING to the machine, which hears about the gate only when the
 * last role reports.
 *
 * Returns null whenever the machine should hear this event after all: it is
 * not a passing gate report, it is for some other gate than the one in
 * flight, or the role that reported was the last in its sequence. A failure
 * at any step lands here too -- red is red whoever found it, and the machine
 * already knows what red means.
 *
 * Its own function because `advanceOnce` is a loop with several decisions in
 * it already, and one more nested inside it put the whole thing past the
 * complexity Sonar allows. That was a fair complaint: the step boundary is a
 * separate idea from the round loop, and reads as one here.
 */
async function continueSequence(
  runId: string,
  event: RunEvent,
  gate: runs.RunGateRow | null,
  target: ExecutorTarget,
  deps: ExecutorDeps,
  result: AdvanceResult,
): Promise<RunEvent[] | null> {
  if (!gate || event.kind !== 'gateFinished' || event.verdict !== 'pass' || gate.gate !== event.gate) {
    return null;
  }
  const following = stepAfter(target.agents[event.gate], gate.agent, result, event.gate);
  if (!following) return null;
  runs.finishGate(gate.id, 'done', { verdict: 'pass' });
  const performed = await execute([startStep(runId, event.gate, following, target)], target, deps);
  recordLaunches(runId, performed);
  collect(result, performed);
  return performed.events;
}

/**
 * Open the row for one role's turn at a gate, and return the spawn that runs it.
 *
 * The row exists before the spawn for the reason `openGates` gives: the
 * guard that stops a stale report from regressing the run reads this table,
 * and a role that runs before its row appears has its own report rejected.
 */
function startStep(
  runId: string,
  gate: Gate,
  agent: string,
  target: ExecutorTarget,
): ResolvedAction {
  runs.startGate({ id: randomUUID(), runId, gate, agent, posture: target.posture });
  return { kind: 'spawnGate', gate, agent };
}

/**
 * The role that runs next in this gate, or null when the one that just
 * reported was the last.
 *
 * Null ALSO when the reporting role is not in the sequence at all -- a run
 * armed under one harness and advanced under another, or a row somebody
 * edited. There is no correct next step from an unknown position, so the
 * report is handed to the machine as the gate's, which is what every gate
 * did before sequences existed, and the mismatch is said out loud rather
 * than absorbed.
 */
function stepAfter(
  sequence: readonly string[] | undefined,
  reporting: string,
  result: AdvanceResult,
  gate: Gate,
): string | null {
  if (!sequence) return null;
  const at = sequence.indexOf(reporting);
  if (at < 0) {
    result.problems.push(
      `gate ${gate} was reported by ${reporting}, which is not in this run's sequence ` +
        `(${sequence.join(' then ')}); treated as the gate's own report`,
    );
    return null;
  }
  return sequence[at + 1] ?? null;
}

/**
 * Write down which session each launched gate became.
 *
 * The row was opened before the spawn and the launcher named the session
 * during it, so this is the first moment both are known. A gate with no
 * session recorded is a gate nothing can look at again -- the receipt can
 * still be found by path, but whether the process is alive cannot.
 */
function recordLaunches(runId: string, performed: ExecutorResult): void {
  for (const launch of performed.launched) {
    const row = runs.activeGate(runId);
    if (row && row.gate === launch.gate) {
      runs.recordGateSession(row.id, { claudeSessionId: launch.sessionId, bgSessionId: launch.backgroundId });
    }
  }
}

function collect(result: AdvanceResult, performed: ExecutorResult): void {
  result.problems.push(...performed.problems);
  result.notifications.push(...performed.notifications);
  if (performed.released) result.released = true;
}

/**
 * The repository's overloads make `blockedReason` required for the states
 * that block, which is the point of them — this narrows once so the rest of
 * the module does not have to.
 */
function writeTransition(
  runId: string,
  state: RunState,
  kind: string,
  detail: runs.EventDetail & { blockedReason?: string },
): void {
  if (state === 'inconclusive' || state === 'failed') {
    runs.recordTransition(runId, state, kind, {
      ...detail,
      blockedReason: detail.blockedReason ?? `run ${state}`,
    });
    return;
  }
  runs.recordTransition(runId, state, kind, detail);
}
