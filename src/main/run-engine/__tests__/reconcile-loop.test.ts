/**
 * Scheduling tests (CO-722).
 *
 * "How often" is "how stale may a run be", and the design answers it per
 * wait because the waits differ by three orders of magnitude. What is
 * asserted here is mostly what is NOT polled: a state polled that should not
 * be spends a rate-limit budget asking a question nobody is answering, and a
 * state not polled that should be is a run that never moves again.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import {
  CHECKS_INTERVAL_MS,
  ESCALATE_AFTER,
  MAX_INTERVAL_MS,
  REVIEW_INTERVAL_MS,
  baseIntervalFor,
  delayUntil,
  dueRuns,
  intervalFor,
  nextWakeAt,
  shouldEscalate,
  type ScheduledRun,
} from '../reconcile-loop';
import type { RunState } from '../transitions';

const NOW = 1_800_000_000_000;

function run(over: Partial<ScheduledRun> = {}): ScheduledRun {
  return { id: 'r1', state: 'waitingChecks', lastPassAt: NOW, failures: 0, ...over };
}

describe('each wait gets the cadence its subject works at', () => {
  test('checks are a machine’s work, so a minute', () => {
    expect(baseIntervalFor('waitingChecks')).toBe(CHECKS_INTERVAL_MS);
  });

  test('a review is a person’s work, so five minutes', () => {
    expect(baseIntervalFor('waitingReview')).toBe(REVIEW_INTERVAL_MS);
  });

  test('review is the slower of the two, not merely different', () => {
    // The ordering is the point, and it is easy to swap two constants.
    expect(REVIEW_INTERVAL_MS).toBeGreaterThan(CHECKS_INTERVAL_MS);
  });
});

describe('what is deliberately not polled', () => {
  test('a finished run is never asked about again', () => {
    // A run is released at APPROVAL, not at merge: the wait for somebody to
    // press merge is unbounded, and one initiative sat twelve hours in it.
    for (const state of ['approved', 'done', 'failed'] as RunState[]) {
      expect(baseIntervalFor(state)).toBeNull();
    }
  });

  test('a run waiting on a person in the app is not polled', () => {
    // They are looking at it. GitHub has nothing to say about a permission
    // prompt.
    for (const state of ['waitingPermission', 'waitingHumanGate'] as RunState[]) {
      expect(baseIntervalFor(state)).toBeNull();
    }
  });

  test('a run waiting on a process is not polled', () => {
    // The process exits and says so. Asking GitHub about it answers nothing.
    for (const state of ['running', 'preparing', 'provisioning'] as RunState[]) {
      expect(baseIntervalFor(state)).toBeNull();
    }
  });

  test('reviewNotRequested is not polled, because the engine acts there', () => {
    // Polling would ask GitHub the same question about a request nobody has
    // made. Making the request is the executor's job, not the poller's.
    expect(baseIntervalFor('reviewNotRequested')).toBeNull();
  });

  test('an inconclusive run is not polled', () => {
    // It stopped and told a person. Asking again cannot unstick it, and a
    // run that polls while nobody is coming is a run that looks busy.
    expect(baseIntervalFor('inconclusive')).toBeNull();
  });
});

describe('a run that keeps establishing nothing is asked less often', () => {
  test('the interval doubles per consecutive failure', () => {
    expect(intervalFor('waitingChecks', 0)).toBe(CHECKS_INTERVAL_MS);
    expect(intervalFor('waitingChecks', 1)).toBe(CHECKS_INTERVAL_MS * 2);
    expect(intervalFor('waitingChecks', 3)).toBe(CHECKS_INTERVAL_MS * 8);
  });

  test('and stops at a ceiling, so a fixed problem is noticed soon after', () => {
    // Not "keep doubling": an hour-long gap means a run stays broken for an
    // hour after somebody fixes it.
    expect(intervalFor('waitingChecks', 40)).toBe(MAX_INTERVAL_MS);
    expect(intervalFor('waitingReview', 40)).toBe(MAX_INTERVAL_MS);
  });

  test('backing off never revives a state that is not polled', () => {
    // A failure count must not turn "stop asking" into "ask in an hour".
    expect(intervalFor('done', 3)).toBeNull();
    expect(intervalFor('inconclusive', 99)).toBeNull();
  });

  test('a person is told at the threshold, and exactly once', () => {
    // `>=` would report every pass after the fifth, which is an alarm that
    // repeats until somebody mutes it. `>` would make the constant a lie.
    expect(shouldEscalate(ESCALATE_AFTER - 1)).toBe(false);
    expect(shouldEscalate(ESCALATE_AFTER)).toBe(true);
    expect(shouldEscalate(ESCALATE_AFTER + 1)).toBe(false);
  });
});

describe('which runs are due', () => {
  test('a run that has never been reconciled is due immediately', () => {
    // This is what makes "reconcile on app start" fall out of the same rule
    // rather than being a second code path that can disagree with it.
    expect(dueRuns([run({ lastPassAt: null })], NOW)).toHaveLength(1);
  });

  test('a run reconciled a moment ago is not', () => {
    expect(dueRuns([run({ lastPassAt: NOW - 1_000 })], NOW)).toHaveLength(0);
  });

  test('a run is due exactly at its interval, not a tick after', () => {
    const at = run({ lastPassAt: NOW - CHECKS_INTERVAL_MS });
    expect(dueRuns([at], NOW)).toHaveLength(1);
    const just = run({ lastPassAt: NOW - CHECKS_INTERVAL_MS + 1 });
    expect(dueRuns([just], NOW)).toHaveLength(0);
  });

  test('a waiting review is not due on the checks cadence', () => {
    // The mistake this catches is one interval used for both: it would ask
    // about a human review sixty times an hour.
    const review = run({ state: 'waitingReview', lastPassAt: NOW - CHECKS_INTERVAL_MS });
    expect(dueRuns([review], NOW)).toHaveLength(0);
    expect(dueRuns([{ ...review, lastPassAt: NOW - REVIEW_INTERVAL_MS }], NOW)).toHaveLength(1);
  });

  test('a state that is not polled is never due, however old', () => {
    const ancient = run({ state: 'done', lastPassAt: NOW - 86_400_000 });
    expect(dueRuns([ancient], NOW)).toEqual([]);
  });

  test('a backed-off run is not due at its base interval', () => {
    const failing = run({ failures: 2, lastPassAt: NOW - CHECKS_INTERVAL_MS });
    expect(dueRuns([failing], NOW)).toHaveLength(0);
    expect(dueRuns([{ ...failing, lastPassAt: NOW - CHECKS_INTERVAL_MS * 4 }], NOW)).toHaveLength(1);
  });

  test('several runs are each judged on their own clock', () => {
    const due = run({ id: 'due', lastPassAt: NOW - CHECKS_INTERVAL_MS });
    const fresh = run({ id: 'fresh', lastPassAt: NOW });
    expect(dueRuns([due, fresh], NOW).map((r) => r.id)).toEqual(['due']);
  });
});

describe('when to wake', () => {
  test('nothing waiting means no timer at all', () => {
    // What stops the loop. A timer ticking over an empty list wakes a laptop
    // all night to do nothing.
    expect(nextWakeAt([], NOW)).toBeNull();
    expect(nextWakeAt([run({ state: 'done' })], NOW)).toBeNull();
  });

  test('the soonest due run decides', () => {
    const soon = run({ id: 'soon', state: 'waitingChecks', lastPassAt: NOW - 30_000 });
    const later = run({ id: 'later', state: 'waitingReview', lastPassAt: NOW });
    expect(nextWakeAt([later, soon], NOW)).toBe(NOW - 30_000 + CHECKS_INTERVAL_MS);
  });

  test('a run that has never been reconciled wakes us now', () => {
    expect(nextWakeAt([run({ lastPassAt: null })], NOW)).toBe(NOW);
  });

  test('a run that is not polled cannot hold the timer', () => {
    const finished = run({ id: 'finished', state: 'approved', lastPassAt: NOW - 86_400_000 });
    const waiting = run({ id: 'waiting', lastPassAt: NOW });
    expect(nextWakeAt([finished, waiting], NOW)).toBe(NOW + CHECKS_INTERVAL_MS);
  });

  test('an overdue run asks for no delay rather than a negative one', () => {
    const overdue = NOW - 10_000;
    expect(delayUntil(overdue, NOW)).toBe(0);
  });

  test('no wake time means no delay to compute', () => {
    expect(delayUntil(null, NOW)).toBeNull();
  });

  test('a future wake is the distance to it', () => {
    expect(delayUntil(NOW + 42_000, NOW)).toBe(42_000);
  });
});
