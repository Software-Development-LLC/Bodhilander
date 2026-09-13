/**
 * Check-set tests (CO-722).
 *
 * Every fixture here is a shape that was actually observed, because the
 * failure mode is not "the logic is wrong" — it is "the data did not look
 * like I assumed". Three of them are recorded in the design:
 *
 * - `required_status_checks` absent entirely (GH-553), so absence-of-failure
 *   is satisfied by a repo that checks nothing;
 * - `bodhi-web-apps` reporting eight checks with `test` **SKIPPED**;
 * - a rollup queried mid-run answering with neither a conclusion nor a state.
 *
 * The fourth is this session's own: `arbiter/review` does not report until
 * review is requested, and the engine withholds the request until checks are
 * green, so counting it too early deadlocks both sides silently.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import {
  checksEvent,
  evaluateChecks,
  type ExpectedCheck,
  type ReportedCheck,
  type ChecksVerdict,
} from '../checks';

const CI: ExpectedCheck[] = [
  { name: 'test (ubuntu-latest)' },
  { name: 'test (windows-latest)' },
  { name: 'quality-gate' },
];

const CI_AND_REVIEW: ExpectedCheck[] = [...CI, { name: 'arbiter/review', afterReviewRequest: true }];

function reported(rows: Record<string, string | null>): ReportedCheck[] {
  return Object.entries(rows).map(([name, conclusion]) => ({
    name,
    conclusion,
    status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  }));
}

const ALL_GREEN = {
  'test (ubuntu-latest)': 'SUCCESS',
  'test (windows-latest)': 'SUCCESS',
  'quality-gate': 'SUCCESS',
};

function before(rows: ReportedCheck[], expected = CI): ChecksVerdict {
  return evaluateChecks(expected, rows, 'beforeReviewRequest');
}

describe('green is a named set, not an absence of failure', () => {
  test('every expected name reporting success is green', () => {
    expect(before(reported(ALL_GREEN))).toEqual({ status: 'green' });
  });

  test('a repo with no expected_checks is undriveable, never green', () => {
    // GH-553: required_status_checks absent entirely. Nothing is failing, and
    // that is precisely the problem — nothing checked anything.
    const verdict = before(reported(ALL_GREEN), []);
    expect(verdict.status).toBe('undriveable');
    if (verdict.status !== 'undriveable') throw new Error('unreachable');
    expect(verdict.reason).toContain('nothing defines green');
  });

  test('an empty rollup against a declared set is waiting, not green', () => {
    // The same shape as the case above from the other side: here something IS
    // expected, so silence means "not yet", not "nothing to check".
    const verdict = before([]);
    expect(verdict.status).toBe('waiting');
    if (verdict.status !== 'waiting') throw new Error('unreachable');
    expect(verdict.pending).toEqual(CI.map((c) => c.name));
  });

  test('checks nobody asked for cannot make a PR green', () => {
    // A rollup full of passes that does not include the expected names is the
    // exact shape of a workflow rename. Reading "no failures" would call it
    // green with the required suite never having run.
    const verdict = before(reported({ lint: 'SUCCESS', 'some-other-job': 'SUCCESS' }));
    expect(verdict.status).toBe('waiting');
  });
});

describe('a skipped check is not a passing one', () => {
  test('SKIPPED is undriveable, not green', () => {
    // Measured on bodhi-web-apps: eight checks reported, `test` SKIPPED.
    const verdict = before(reported({ ...ALL_GREEN, 'test (windows-latest)': 'SKIPPED' }));
    expect(verdict.status).toBe('undriveable');
    if (verdict.status !== 'undriveable') throw new Error('unreachable');
    expect(verdict.names).toEqual(['test (windows-latest)']);
  });

  test('SKIPPED is not a failure either', () => {
    // The other half. A skipped check says nothing about the branch, so
    // sending an owner back for it is as wrong as advancing past it.
    const verdict = before(reported({ ...ALL_GREEN, 'quality-gate': 'SKIPPED' }));
    expect(verdict.status).not.toBe('failed');
  });

  test('CANCELLED and NEUTRAL are the same statement', () => {
    for (const conclusion of ['CANCELLED', 'NEUTRAL', 'STALE']) {
      const verdict = before(reported({ ...ALL_GREEN, 'quality-gate': conclusion }));
      expect(verdict.status).toBe('undriveable');
    }
  });
});

describe('a null conclusion is not a failure', () => {
  test('a check still running leaves the set waiting', () => {
    // Null is this field's normal state for minutes at a time. Reading it as
    // a failure reds every PR the moment it opens.
    const verdict = before(reported({ ...ALL_GREEN, 'quality-gate': null }));
    expect(verdict.status).toBe('waiting');
    if (verdict.status !== 'waiting') throw new Error('unreachable');
    expect(verdict.pending).toEqual(['quality-gate']);
  });

  test('a row with neither conclusion nor status is pending', () => {
    // Observed exactly this querying a rollup mid-run: both fields empty.
    const verdict = before([
      ...reported(ALL_GREEN).slice(0, 2),
      { name: 'quality-gate', conclusion: null, status: null },
    ]);
    expect(verdict.status).toBe('waiting');
  });

  test('QUEUED in the status field is pending even with no conclusion', () => {
    const verdict = before([
      ...reported(ALL_GREEN).slice(0, 2),
      { name: 'quality-gate', conclusion: null, status: 'QUEUED' },
    ]);
    expect(verdict.status).toBe('waiting');
  });

  test('PENDING arriving in the conclusion field is still pending', () => {
    // A StatusContext carries `state`, not `conclusion`, and the caller
    // flattens one into the other. This asserts the flattening cannot turn a
    // pending third-party status into a non-result.
    const verdict = before([
      ...reported(ALL_GREEN).slice(0, 2),
      { name: 'quality-gate', conclusion: 'PENDING' },
    ]);
    expect(verdict.status).toBe('waiting');
  });
});

describe('a failure is final and outranks everything', () => {
  test('one failing check fails the set', () => {
    const verdict = before(reported({ ...ALL_GREEN, 'quality-gate': 'FAILURE' }));
    expect(verdict.status).toBe('failed');
    if (verdict.status !== 'failed') throw new Error('unreachable');
    expect(verdict.failing).toEqual(['quality-gate']);
  });

  test('a failure beside a still-running check is failed, not waiting', () => {
    // A failure will not un-fail, so waiting for the rest only delays the
    // owner. This is the one ranking that is about time rather than truth.
    const verdict = before(
      reported({ ...ALL_GREEN, 'quality-gate': 'FAILURE', 'test (windows-latest)': null }),
    );
    expect(verdict.status).toBe('failed');
  });

  test('a failure beside a skipped check is failed', () => {
    const verdict = before(
      reported({ ...ALL_GREEN, 'quality-gate': 'FAILURE', 'test (windows-latest)': 'SKIPPED' }),
    );
    expect(verdict.status).toBe('failed');
  });

  test('TIMED_OUT and ACTION_REQUIRED are failures, not absences', () => {
    for (const conclusion of ['TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
      const verdict = before(reported({ ...ALL_GREEN, 'quality-gate': conclusion }));
      expect(verdict.status).toBe('failed');
    }
  });

  test('a skipped check beside a running one waits before it reports stuck', () => {
    // Ranking, asserted directly: waiting outranks undriveable. Reporting the
    // run stuck while CI is still working pulls a person to a PR that needs
    // nobody yet — and the skip will still be a skip in a minute.
    const verdict = before(
      reported({ ...ALL_GREEN, 'quality-gate': 'SKIPPED', 'test (windows-latest)': null }),
    );
    expect(verdict.status).toBe('waiting');
  });
});

describe('review-triggered checks have two phases', () => {
  test('arbiter/review is not counted before review is requested', () => {
    // The deadlock this flag exists to break: the engine withholds the review
    // request until checks are green, and arbiter does not report until the
    // request is made. Counted too early, both sides wait forever and nothing
    // looks wrong.
    expect(before(reported(ALL_GREEN), CI_AND_REVIEW)).toEqual({ status: 'green' });
  });

  test('it is counted once review has been requested', () => {
    const verdict = evaluateChecks(CI_AND_REVIEW, reported(ALL_GREEN), 'afterReviewRequest');
    expect(verdict.status).toBe('waiting');
    if (verdict.status !== 'waiting') throw new Error('unreachable');
    expect(verdict.pending).toEqual(['arbiter/review']);
  });

  test('a set that is ONLY review-triggered gates nothing before the request', () => {
    // Green here would mean requesting an adversarial review of a branch that
    // nothing has checked — which is what the CI gate exists to prevent.
    const verdict = before(reported(ALL_GREEN), [
      { name: 'arbiter/review', afterReviewRequest: true },
    ]);
    expect(verdict.status).toBe('undriveable');
    if (verdict.status !== 'undriveable') throw new Error('unreachable');
    expect(verdict.reason).toContain('review-triggered');
  });

  test('the phase changes the answer and nothing else does', () => {
    // Two calls, identical but for the phase, must differ — otherwise the
    // flag is decoration and the deadlock is still live.
    const rows = reported(ALL_GREEN);
    expect(evaluateChecks(CI_AND_REVIEW, rows, 'beforeReviewRequest').status).toBe('green');
    expect(evaluateChecks(CI_AND_REVIEW, rows, 'afterReviewRequest').status).toBe('waiting');
  });

  test('a failing arbiter review after the request is a failure', () => {
    const verdict = evaluateChecks(
      CI_AND_REVIEW,
      reported({ ...ALL_GREEN, 'arbiter/review': 'FAILURE' }),
      'afterReviewRequest',
    );
    expect(verdict.status).toBe('failed');
  });
});

describe('a name that reported twice', () => {
  test('a re-run that now passes does not erase the failure it replaced', () => {
    // A re-run leaves the old row in place and the rollup carries no
    // timestamp to order them by. Guessing which is current is how a stale
    // green gets believed, so this fails closed and a person looks.
    const verdict = before([
      ...reported(ALL_GREEN).slice(0, 2),
      { name: 'quality-gate', conclusion: 'FAILURE', status: 'COMPLETED' },
      { name: 'quality-gate', conclusion: 'SUCCESS', status: 'COMPLETED' },
    ]);
    expect(verdict.status).toBe('failed');
  });

  test('a re-run still in flight is waiting, not green', () => {
    const verdict = before([
      ...reported(ALL_GREEN).slice(0, 2),
      { name: 'quality-gate', conclusion: 'SUCCESS', status: 'COMPLETED' },
      { name: 'quality-gate', conclusion: null, status: 'IN_PROGRESS' },
    ]);
    expect(verdict.status).toBe('waiting');
  });

  test('two passes under one name are a pass', () => {
    // The control: failing closed must not mean failing on duplicates.
    const verdict = before([
      ...reported(ALL_GREEN).slice(0, 2),
      { name: 'quality-gate', conclusion: 'SUCCESS', status: 'COMPLETED' },
      { name: 'quality-gate', conclusion: 'SUCCESS', status: 'COMPLETED' },
    ]);
    expect(verdict).toEqual({ status: 'green' });
  });
});

describe('the shapes gh actually returns', () => {
  test('conclusions are matched case-insensitively', () => {
    // The REST API answers in lower case where GraphQL answers in upper, and
    // the engine reads whichever the caller had.
    const verdict = before([
      { name: 'test (ubuntu-latest)', conclusion: 'success', status: 'completed' },
      { name: 'test (windows-latest)', conclusion: 'success', status: 'completed' },
      { name: 'quality-gate', conclusion: 'success', status: 'completed' },
    ]);
    expect(verdict).toEqual({ status: 'green' });
  });

  test('an unknown conclusion is never a pass', () => {
    // A value this module has not seen is not evidence of anything. Treating
    // the unrecognised as fine is how a new GitHub state becomes a green.
    const verdict = before(reported({ ...ALL_GREEN, 'quality-gate': 'SOMETHING_NEW' }));
    expect(verdict.status).not.toBe('green');
    expect(verdict.status).toBe('undriveable');
  });
});

describe('the verdict as an event', () => {
  test('green, failed and undriveable each produce their own event', () => {
    expect(checksEvent({ status: 'green' })).toEqual({ kind: 'checksGreen' });
    expect(checksEvent({ status: 'failed', failing: ['quality-gate'] })).toEqual({
      kind: 'checksFailed',
    });
    expect(checksEvent({ status: 'undriveable', reason: 'test was SKIPPED', names: ['test'] })).toEqual(
      { kind: 'checksUndriveable', reason: 'test was SKIPPED' },
    );
  });

  test('waiting produces nothing', () => {
    // A run that is still waiting has nothing to record. An event every 60
    // seconds would bury the four that matter in a log whose whole value is
    // that it is append-only and readable.
    expect(checksEvent({ status: 'waiting', pending: ['quality-gate'] })).toBeNull();
  });

  test('the three events are distinct', () => {
    // Collapsing undriveable into either neighbour is the defect this whole
    // module exists to prevent, so it is asserted rather than left to reading.
    const kinds = [
      checksEvent({ status: 'green' })?.kind,
      checksEvent({ status: 'failed', failing: [] })?.kind,
      checksEvent({ status: 'undriveable', reason: 'x', names: [] })?.kind,
    ];
    expect(new Set(kinds).size).toBe(3);
  });

  test('the reason travels with the event, not just the log line', () => {
    const event = checksEvent({
      status: 'undriveable',
      reason: 'no expected_checks recorded for this repo',
      names: [],
    });
    expect(event).toEqual({
      kind: 'checksUndriveable',
      reason: 'no expected_checks recorded for this repo',
    });
  });
});
