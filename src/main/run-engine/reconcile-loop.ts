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
 * `reviewNotRequested` is not polled either, and that one is worth saying out
 * loud: it is a state the engine ACTS on. Polling it would ask GitHub the
 * same question repeatedly about a request nobody has made yet. Making the
 * request is the executor's job, not the poller's.
 *
 * The scheduling decisions here are pure. A timer is one line; deciding
 * whether a run is due, and when to wake next, is the part worth asserting.
 */
import type { RunState } from './transitions';

/** Checks are a machine's work: minutes, and the run is blocked behind them. */
export const CHECKS_INTERVAL_MS = 60_000;
/** A review is a person's work: hours to days, so asking often buys nothing. */
export const REVIEW_INTERVAL_MS = 300_000;
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

/** How long to wait before asking about this run again, or null to stop asking. */
export function baseIntervalFor(state: RunState): number | null {
  if (state === 'waitingChecks') return CHECKS_INTERVAL_MS;
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
