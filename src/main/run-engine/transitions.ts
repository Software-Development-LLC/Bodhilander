/**
 * The run state machine (CO-722).
 *
 * `claude-team-workflow` documents a gate model and nothing enforces it. Its
 * own docstrings record what that costs: owners dispatched serially where the
 * command says concurrent, two owner dispatches that ended with "open a PR" so
 * gates 3 and 4 never ran, 97 turns spent locating a tool across three
 * reachable copies of it. None of those is a reasoning failure — they are
 * sequencing, ordering and isolation, which is what a state machine is for.
 *
 * So this module holds the arrows and nothing else. It contains no domain
 * judgment: it does not know what a reviewer looks for, what a seam is, or
 * how to verify anything. It knows which agent runs next, what blocks, and
 * what a given outcome means for the run. The judgment stays in the model and
 * the deterministic checks stay in the plugin's Python.
 *
 * Pure by design — `(state, event) -> decision`. No processes, no git, no
 * network, no clock. That is what lets every path, including every
 * inconclusive one, be asserted in a unit test rather than discovered during
 * a run that costs real tokens.
 */

/**
 * Where a run is. Four of these cannot advance without a person:
 * `waitingPermission`, `waitingHumanGate`, `waitingReview`, `inconclusive` —
 * which is why the run inbox is the primary surface rather than a timeline.
 */
export type RunState =
  | 'preparing'
  | 'provisioning'
  | 'running'
  | 'waitingPermission'
  | 'waitingHumanGate'
  | 'waitingChecks'
  /**
   * Checks are green and no approver has been asked yet.
   *
   * This is a state the engine ACTS on, not one it waits in. `arbiter/review`
   * does not fire until review is requested, so a PR sitting un-requested is
   * invisible to the bot and to the human queue alike — nothing is coming,
   * and waiting here is waiting for something nobody started.
   */
  | 'reviewNotRequested'
  | 'waitingReview'
  | 'inconclusive'
  | 'failed'
  | 'approved'
  | 'done';

/** Gates this slice drives. 0 and 1 are bootstrapped by `init-task.sh`. */
export type Gate = 2 | 3 | 4;

/**
 * What a gate reported.
 *
 * `inconclusive` is not a shade of failure. It means the gate could not
 * establish anything — a missing verdict, one that failed schema validation,
 * a toolchain that could not be driven. Collapsing it into `fail` sends an
 * owner back to fix code that was never broken; collapsing it into `pass` is
 * the green-having-checked-nothing defect the plugin has filed seven times.
 */
export type GateVerdict = 'pass' | 'fail' | 'inconclusive';

/** Who filed a review, and how badly. */
export interface ReviewVerdict {
  /** A bot block is not a human block, and only one of them ends the run. */
  actor: 'human' | 'bot';
  /**
   * Bot findings at `major` send the run back to gate 2. `nit` is recorded
   * and surfaced — CO-447 measured `arbiter/review` at "major 0, minor 0,
   * nit 1", and re-entering gate 2 for that burns a cycle on a note.
   */
  severity?: 'major' | 'nit';
}

export type RunEvent =
  | { kind: 'prepared' }
  | { kind: 'provisioned' }
  /** An install ran and failed. A real result, unlike the one below. */
  | { kind: 'provisionFailed' }
  /** Nothing ran: no worktree, no package manager. Not a result. */
  | { kind: 'provisionUndriveable' }
  | { kind: 'gateFinished'; gate: Gate; verdict: GateVerdict }
  | { kind: 'permissionRequested' }
  | { kind: 'permissionAnswered' }
  | { kind: 'prOpened' }
  | { kind: 'checksGreen' }
  | { kind: 'checksFailed' }
  | { kind: 'reviewRequested' }
  | { kind: 'reviewApproved' }
  | { kind: 'reviewChangesRequested'; verdict: ReviewVerdict }
  | { kind: 'humanApprovedGate' }
  | { kind: 'budgetExceeded' }
  | { kind: 'merged' };

/**
 * What the engine should do on arriving at the next state. Naming these as
 * data rather than performing them keeps the machine pure and makes "did it
 * decide to request review?" an assertion rather than an observation of side
 * effects.
 */
export type RunAction =
  | { kind: 'provision' }
  | { kind: 'spawnGate'; gate: Gate }
  /** Ask an approver. The engine's move, not a wait. */
  | { kind: 'requestReview' }
  /** Poll `gh`. Only ever an accelerant — reconciliation is the truth. */
  | { kind: 'reconcile' }
  | { kind: 'notify'; reason: string }
  /**
   * Stop attending to this run. Reached at APPROVAL, not at merge: once every
   * PR is approved and green nothing further comes back, and the wait for
   * someone to press merge is unbounded. One initiative sat twelve hours
   * there while the rest stayed drafts.
   */
  | { kind: 'release' };

export interface Decision {
  state: RunState;
  actions: RunAction[];
  /** Why, for `run_events`. The audit trail is the product, not a by-product. */
  note: string;
}

/** The gate that follows, or null when 4 is done. */
function nextGate(gate: Gate): Gate | null {
  return gate === 2 ? 3 : gate === 3 ? 4 : null;
}

function stay(state: RunState, note: string): Decision {
  return { state, actions: [], note };
}

/**
 * The one rule with no exceptions: a run that cannot establish something
 * stops and tells a person. It never advances, and it never reports failure,
 * because neither is true.
 */
function inconclusive(note: string): Decision {
  return { state: 'inconclusive', actions: [{ kind: 'notify', reason: note }], note };
}

/**
 * `(state, event) -> decision`.
 *
 * Unknown pairings return the current state unchanged with a note rather than
 * throwing. A run is durable and resumable, so it will be handed stale and
 * duplicate events — a reconcile that races a webhook, a gate that reports
 * twice after a restart. Throwing there would turn a duplicate into an
 * outage; advancing on one would be worse.
 */
export function transition(state: RunState, event: RunEvent): Decision {
  switch (state) {
    case 'preparing':
      if (event.kind === 'prepared') {
        return {
          state: 'provisioning',
          actions: [{ kind: 'provision' }],
          note: 'worktrees cut; installing dependencies before gate 2',
        };
      }
      break;

    case 'provisioning':
      // Provisioning comes BEFORE gate 2 because an unprovisioned worktree
      // makes verify.sh report a missing runner as FAIL — measured as
      // "'jest' is not recognized", exit 1, over code that was fine. An
      // engine reading that as red sends the owner back into the same red
      // until the budget stops it.
      if (event.kind === 'provisioned') {
        return {
          state: 'running',
          actions: [{ kind: 'spawnGate', gate: 2 }],
          note: 'dependencies installed; gate 2 (owner)',
        };
      }
      if (event.kind === 'provisionFailed') {
        return {
          state: 'failed',
          actions: [{ kind: 'notify', reason: 'install failed' }],
          note: 'an install ran and failed — a real result',
        };
      }
      if (event.kind === 'provisionUndriveable') {
        // Nothing ran, so there is no result for the change. Calling this
        // `failed` is the confusion the provisioning work exists to remove.
        return inconclusive('nothing could be installed here — no result for the change');
      }
      break;

    case 'running':
      if (event.kind === 'gateFinished') {
        if (event.verdict === 'inconclusive') {
          return inconclusive(`gate ${event.gate} could not establish a verdict`);
        }
        if (event.verdict === 'fail') {
          // Red means the owner keeps working. It does not mean "note it on
          // the PR" — and a failing gate 3 or 4 returns to gate 2 rather than
          // ending the run, because the branch is still soft.
          return {
            state: 'running',
            actions: [{ kind: 'spawnGate', gate: 2 }],
            note: `gate ${event.gate} red; back to gate 2`,
          };
        }
        const next = nextGate(event.gate);
        if (next) {
          return {
            state: 'running',
            actions: [{ kind: 'spawnGate', gate: next }],
            note: `gate ${event.gate} passed; gate ${next}`,
          };
        }
        // Gate 4 passed: scribe has opened the PR. Checks decide what next.
        return {
          state: 'waitingChecks',
          actions: [{ kind: 'reconcile' }],
          note: 'PR open; waiting for checks',
        };
      }
      if (event.kind === 'permissionRequested') {
        return stay('waitingPermission', 'a tool needs approval');
      }
      if (event.kind === 'budgetExceeded') {
        return inconclusive('budget ceiling reached before a verdict');
      }
      break;

    case 'waitingPermission':
      // No timeout. A silent auto-deny is indistinguishable from a gate
      // finding, and the run would carry a verdict nobody gave.
      if (event.kind === 'permissionAnswered') {
        return stay('running', 'permission answered; gate continues');
      }
      break;

    case 'waitingHumanGate':
      if (event.kind === 'humanApprovedGate') {
        return {
          state: 'running',
          actions: [{ kind: 'spawnGate', gate: 2 }],
          note: 'manifest approved; gate 2',
        };
      }
      break;

    case 'waitingChecks':
      if (event.kind === 'checksGreen') {
        // Green checks do NOT mean approved — they mean it is now worth
        // asking. Requesting earlier spends an adversarial pass on a build
        // that may still change, which is the same reasoning that puts gate 3
        // before the specs harden.
        return {
          state: 'reviewNotRequested',
          actions: [{ kind: 'requestReview' }],
          note: 'checks green; requesting review',
        };
      }
      if (event.kind === 'checksFailed') {
        return {
          state: 'running',
          actions: [{ kind: 'spawnGate', gate: 2 }],
          note: 'checks red; back to gate 2',
        };
      }
      break;

    case 'reviewNotRequested':
      if (event.kind === 'reviewRequested') {
        return {
          state: 'waitingReview',
          actions: [{ kind: 'reconcile' }],
          note: 'review requested; arbiter and the human queue can now see it',
        };
      }
      break;

    case 'waitingReview':
      if (event.kind === 'reviewApproved') {
        // Released at approval, not at merge.
        return {
          state: 'approved',
          actions: [{ kind: 'release' }],
          note: 'approved and green; nothing further comes back',
        };
      }
      if (event.kind === 'reviewChangesRequested') {
        const { actor, severity } = event.verdict;
        if (actor === 'bot' && severity !== 'major') {
          // Recorded and surfaced, not acted on. Re-entering gate 2 for a nit
          // spends an owner cycle on a note.
          return {
            state: 'waitingReview',
            actions: [{ kind: 'notify', reason: 'bot nit recorded' }],
            note: 'bot finding below major; recorded, still waiting on review',
          };
        }
        return {
          state: 'running',
          actions: [{ kind: 'spawnGate', gate: 2 }],
          note: `${actor} requested changes; back to gate 2`,
        };
      }
      break;

    case 'approved':
      if (event.kind === 'merged') {
        return stay('done', 'merged');
      }
      break;

    case 'inconclusive':
      // Only a person leaves this state. Whatever they fixed, the run resumes
      // by re-entering gate 2 rather than assuming the earlier gate's result.
      if (event.kind === 'humanApprovedGate') {
        return {
          state: 'running',
          actions: [{ kind: 'spawnGate', gate: 2 }],
          note: 'resumed by a person after an inconclusive gate',
        };
      }
      break;

    case 'failed':
    case 'done':
      break;
  }

  return stay(state, `ignored ${event.kind} in ${state}`);
}

/** States that cannot advance without a person. The run inbox is built on this. */
export const NEEDS_A_PERSON: readonly RunState[] = [
  'waitingPermission',
  'waitingHumanGate',
  'waitingReview',
  'inconclusive',
];

/** States the engine is actively working, so nothing external is owed. */
export const IS_WORKING: readonly RunState[] = ['preparing', 'provisioning', 'running'];

/** Nothing further will happen on its own. */
export function isTerminal(state: RunState): boolean {
  return state === 'approved' || state === 'done' || state === 'failed';
}
