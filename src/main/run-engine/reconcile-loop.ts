/**
 * When to ask again (CO-722).
 *
 * Reconciliation is the only state path, so the question "how often" is the
 * question "how stale may a run be". The design answers it per wait, because
 * the waits differ by three orders of magnitude:
 *
 *     CI / named checks    minutes, machine   60s while waitingChecks
 *     human review         hours to days      5 min while waitingReview
 *     human merge          unbounded          do not wait — release at approval
 *
 * At five minutes this is about twelve calls an hour per waiting run against
 * a 5,000/hour budget. Latency does not matter for a row measured in hours;
 * what mattered is that nobody is alive for it.
 *
 * Only two states are polled, and the omissions are deliberate. `running`
 * waits on a process, which exits and says so. `waitingPermission` and
 * `waitingHumanGate` wait on a person who is looking at the app. `approved`
 * and `done` are finished — the design is explicit that a run is released at
 * APPROVAL rather than at merge, because the wait for somebody to press merge
 * is unbounded and one initiative sat twelve hours in it.
 *
 * `reviewNotRequested` is here for a different reason, and an earlier version
 * of this file had it wrong. It is a state the engine ACTS on, so waking for
 * it does not mean asking GitHub anything — it means re-attempting the review
 * request. Left unscheduled, a request that failed once (a rate limit, a
 * dropped connection) would strand the run there permanently, because nothing
 * else was ever going to come back to it. What the loop schedules is
 * ATTENTION; what attention means is the state's business.
 *
 * The scheduling decisions here are pure. A timer is one line; deciding
 * whether a run is due, and when to wake next, is the part worth asserting.
 */
import type { RunState } from './transitions';

/**
 * How often a running gate is looked at.
 *
 * A background gate reports by receipt and cannot be heard any other way, so
 * a run in `running` must be LOOKED at: is there a receipt, and what does the
 * daemon say the session is doing (#287). The loop used to leave `running`
 * alone on the grounds that the process exits and says so -- true of a print
 * gate, and exactly wrong for a `--bg` one, which is how the first real run
 * said `gate 2 running` for hours after the process was gone.
 *
 * A minute, like checks: the look is cheap (one file, one `claude agents`)
 * and somebody is waiting on the far side of it.
 */
export const GATE_INTERVAL_MS = 60_000;

/**
 * The one clock this engine still runs on a gate, and what it means.
 *
 * #292 began as "the gate deadline killed a working reviewer": a cap on
 * elapsed time cannot tell a thinking gate from a stuck one. Nearly every
 * case that deadline was for is now read from the daemon instead -- `idle`
 * and `gone` without a receipt, `waiting` on a prompt. What remains is
 * `busy` with no word, indefinitely, and only a person can say whether that
 * is thought or a loop.
 *
 * So this is not a kill. Past it, the run goes to `inconclusive` -- the
 * inbox -- with the session id to attach to, and the gate is left running
 * for the person to judge. Two hours, because the reviewer that was killed
 * at fifteen minutes was mid-mutation-test and right to be, and today's
 * scribe ran thirty-five. A ceiling a thorough gate can hit is a ceiling
 * that will lie.
 */
export const GATE_BUSY_CEILING_MS = 2 * 60 * 60 * 1000;

/** Checks are a machine's work: minutes, and the run is blocked behind them. */
export const CHECKS_INTERVAL_MS = 60_000;
/** A review is a person's work: hours to days, so asking often buys nothing. */
export const REVIEW_INTERVAL_MS = 300_000;

/**
 * Re-attempting an action the engine already decided to take.
 *
 * The same cadence as checks, for the same reason: it is the engine's own
 * work, it is quick, and somebody is waiting on the far side of it.
 */
export const ACTION_RETRY_INTERVAL_MS = 60_000;
/**
 * The ceiling a backed-off run reaches.
 *
 * Fifteen minutes rather than "keep doubling": a run that has failed eleven
 * times is probably waiting on something a person must fix, and an hour-long
 * gap would mean it stays broken for an hour after they fix it.
 */
export const MAX_INTERVAL_MS = 900_000;
/**
 * Consecutive failed passes before a person is told.
 *
 * Five, which is five minutes of checks or twenty-five of review. Fewer and
 * a laptop closing its lid raises an alarm; more and a genuinely broken
 * configuration sits quiet for most of an hour.
 */
export const ESCALATE_AFTER = 5;

/**
 * How long before this run wants attention again, or null when it wants none.
 *
 * `reviewNotRequested` is on the fast cadence deliberately: the work there is
 * one `gh` call the engine already decided to make, and a person is waiting
 * on the far side of it. A failed request should be re-attempted in a minute,
 * not in five.
 */
export function baseIntervalFor(state: RunState): number | null {
  // A preparing run has never run its installer; it is due at once so the loop
  // can provision it and open its gates (CO-722). A never-started owner is
  // scheduled at this same cadence -- see run-loop's schedulingState.
  if (state === 'preparing') return GATE_INTERVAL_MS;
  if (state === 'running') return GATE_INTERVAL_MS;
  if (state === 'waitingChecks') return CHECKS_INTERVAL_MS;
  if (state === 'reviewNotRequested') return ACTION_RETRY_INTERVAL_MS;
  if (state === 'waitingReview') return REVIEW_INTERVAL_MS;
  return null;
}

/**
 * The interval after `failures` consecutive passes that established nothing.
 *
 * Doubling, capped. A pass that fails costs a call and answers nothing, and
 * the usual cause — no network — does not improve by being asked sixty times
 * an hour. The cap keeps a fixed problem from going unnoticed for long once
 * it is fixed.
 */
export function intervalFor(state: RunState, failures = 0): number | null {
  const base = baseIntervalFor(state);
  if (base === null) return null;
  const backoff = base * 2 ** Math.min(failures, 10);
  return Math.min(backoff, MAX_INTERVAL_MS);
}

/**
 * Whether this many consecutive failures is worth interrupting somebody for.
 *
 * Exactly at the threshold, not past it: `>` instead of `>=` would report the
 * sixth failure as the fifth and make the constant a lie.
 */
export function shouldEscalate(failures: number): boolean {
  return failures === ESCALATE_AFTER;
}

/** One run, as the scheduler needs to see it. */
export interface ScheduledRun {
  id: string;
  state: RunState;
  /** Epoch ms of the last pass, or null if it has never had one. */
  lastPassAt: number | null;
  /** Consecutive passes that established nothing. Reset by any pass that did. */
  failures: number;
}

/**
 * Runs due for a pass right now.
 *
 * A run that has never been reconciled is due immediately — that is what
 * makes "reconcile on app start" fall out of the same rule rather than being
 * a second code path that can disagree with this one.
 */
export function dueRuns(runs: readonly ScheduledRun[], now: number): ScheduledRun[] {
  return runs.filter((run) => {
    const interval = intervalFor(run.state, run.failures);
    if (interval === null) return false;
    return run.lastPassAt === null || now - run.lastPassAt >= interval;
  });
}

/**
 * When the next pass is owed, or null when nothing is waiting.
 *
 * Null is what stops the timer entirely. The design asks for a timer that
 * "runs only while some run is waiting", and a loop that keeps ticking over
 * an empty list is a loop that wakes a laptop all night to do nothing.
 */
export function nextWakeAt(runs: readonly ScheduledRun[], now: number): number | null {
  let soonest: number | null = null;
  for (const run of runs) {
    const interval = intervalFor(run.state, run.failures);
    if (interval === null) continue;
    const due = run.lastPassAt === null ? now : run.lastPassAt + interval;
    if (soonest === null || due < soonest) soonest = due;
  }
  return soonest;
}

/**
 * How long to sleep before the next wake, never negative.
 *
 * A due time already in the past means "now", and a negative delay handed to
 * setTimeout fires immediately anyway — but computing it honestly is what
 * keeps a caller from reading the number as "we are behind by this much".
 */
export function delayUntil(wakeAt: number | null, now: number): number | null {
  if (wakeAt === null) return null;
  return Math.max(0, wakeAt - now);
}
