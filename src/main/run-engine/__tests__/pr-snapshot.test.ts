/**
 * Snapshot-translation tests (CO-722).
 *
 * The fixtures are literal `gh` output from this org's PRs on 2026-09-13, not
 * shapes written from memory. That matters more here than anywhere else in
 * the engine: everything downstream is pure and exhaustively tested, so the
 * only way a wrong answer reaches a run is a row that was translated wrong or
 * never translated at all.
 *
 * The measured hazard is the one that would have gone unnoticed: `CheckRun`
 * and `StatusContext` share no field name that matters, and `arbiter/review`
 * — the review gate itself — is a StatusContext. A reader that knew only
 * `name`/`conclusion` would see it as absent, and absent reads as "not
 * reported yet", which waits forever rather than failing.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import {
  expectedChecksArgv,
  flattenRollup,
  prSnapshotArgv,
  readReviewArgv,
  toExpectedChecks,
  toReviewRows,
} from '../pr-snapshot';
import { evaluateChecks } from '../checks';
import { readReviews } from '../reviews';

/** Verbatim from `gh pr view 269 --json statusCheckRollup`. */
const ROLLUP = [
  { __typename: 'CheckRun', name: 'quality-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'test (ubuntu-latest)', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'test (windows-latest)', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'GitGuardian Security Checks', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'CheckRun', name: 'SonarQube Code Analysis', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'StatusContext', context: 'arbiter/review', state: 'SUCCESS' },
];

/** Verbatim from `gh pr view 270 --json reviews`. */
const REVIEWS = [
  {
    author: { login: 'brannon-bowden' },
    state: 'CHANGES_REQUESTED',
    submittedAt: '2026-09-13T16:40:00Z',
    body: 'This is a solid rework, but...',
  },
  {
    author: { login: 'brannon-bowden' },
    state: 'APPROVED',
    submittedAt: '2026-09-13T17:28:07Z',
    body: 'Approving.',
  },
];

describe('the two rollup shapes', () => {
  test('a StatusContext is named by its context, not by a name it lacks', () => {
    // THE measured hazard. arbiter/review is a StatusContext, and it carries
    // no `name` and no `conclusion` at all.
    const flat = flattenRollup(ROLLUP);
    expect(flat).toContainEqual({ name: 'arbiter/review', conclusion: 'SUCCESS', status: null });
  });

  test('a CheckRun keeps its status as well as its conclusion', () => {
    // The status is what separates a null conclusion that is still running
    // from one that finished and reported nothing.
    const flat = flattenRollup(ROLLUP);
    expect(flat).toContainEqual({
      name: 'quality-gate',
      conclusion: 'SUCCESS',
      status: 'COMPLETED',
    });
  });

  test('every row survives the translation', () => {
    expect(flattenRollup(ROLLUP)).toHaveLength(ROLLUP.length);
  });

  test('an in-flight CheckRun keeps its null conclusion', () => {
    // Observed mid-run: conclusion null, status IN_PROGRESS. Inventing a
    // conclusion here would be inventing a verdict.
    const flat = flattenRollup([
      { __typename: 'CheckRun', name: 'quality-gate', status: 'IN_PROGRESS', conclusion: null },
    ]);
    expect(flat).toEqual([{ name: 'quality-gate', conclusion: null, status: 'IN_PROGRESS' }]);
  });

  test('a pending StatusContext arrives where the reader looks for it', () => {
    const flat = flattenRollup([
      { __typename: 'StatusContext', context: 'arbiter/review', state: 'PENDING' },
    ]);
    expect(flat[0].conclusion).toBe('PENDING');
  });

  test('a row with no name at all is dropped, not carried as empty', () => {
    // It could never match an expected name, and carrying it as '' would
    // match an expected check somebody recorded as an empty string.
    expect(flattenRollup([{ __typename: 'CheckRun', conclusion: 'SUCCESS' }])).toEqual([]);
  });

  test('an empty rollup is an empty list, not a crash', () => {
    expect(flattenRollup([])).toEqual([]);
  });
});

describe('the translation reaches the right verdict end to end', () => {
  const EXPECTED = {
    ci: [
      'test (ubuntu-latest)',
      'test (windows-latest)',
      'quality-gate',
      'SonarQube Code Analysis',
      'GitGuardian Security Checks',
    ],
    afterReviewRequest: ['arbiter/review'],
  };

  test("Bodhilander's own recorded set reads green against its own PR", () => {
    // Real recorded names, real reported rows, the real evaluator. If any
    // name in registry.overrides.yaml disagrees with what GitHub posts, this
    // is where it shows up rather than on a run.
    const verdict = evaluateChecks(
      toExpectedChecks(EXPECTED),
      flattenRollup(ROLLUP),
      'afterReviewRequest',
    );
    expect(verdict).toEqual({ status: 'green' });
  });

  test('and green before the review request too, without arbiter', () => {
    // The same rows minus the StatusContext: a PR that has not been sent for
    // review yet reports five checks, and the sixth is not owed.
    const beforeRequest = ROLLUP.filter((r) => r.__typename !== 'StatusContext');
    const verdict = evaluateChecks(
      toExpectedChecks(EXPECTED),
      flattenRollup(beforeRequest),
      'beforeReviewRequest',
    );
    expect(verdict).toEqual({ status: 'green' });
  });

  test('and waits after the request when arbiter has not reported', () => {
    // Measured on PR #268: the arbiter status was absent from the rollup
    // entirely although a review had happened.
    const beforeRequest = ROLLUP.filter((r) => r.__typename !== 'StatusContext');
    const verdict = evaluateChecks(
      toExpectedChecks(EXPECTED),
      flattenRollup(beforeRequest),
      'afterReviewRequest',
    );
    expect(verdict.status).toBe('waiting');
  });

  test('a StatusContext failure reaches the evaluator as a failure', () => {
    // The whole point of translating `state` into `conclusion`: if it landed
    // anywhere else, a failing review gate would read as "not reported".
    const failing = ROLLUP.map((r) =>
      r.__typename === 'StatusContext' ? { ...r, state: 'FAILURE' } : r,
    );
    const verdict = evaluateChecks(
      toExpectedChecks(EXPECTED),
      flattenRollup(failing),
      'afterReviewRequest',
    );
    expect(verdict.status).toBe('failed');
  });
});

describe('review rows', () => {
  test('the author login is lifted out of its object', () => {
    const { rows } = toReviewRows(REVIEWS);
    expect(rows.map((r) => r.author)).toEqual(['brannon-bowden', 'brannon-bowden']);
  });

  test('both rows survive, because both are kept forever by GitHub', () => {
    const { rows, dropped } = toReviewRows(REVIEWS);
    expect(rows).toHaveLength(2);
    expect(dropped).toEqual([]);
  });

  test('the rows read as the later position through the real reducer', () => {
    const reading = readReviews({
      rows: toReviewRows(REVIEWS).rows,
      approvers: ['brannon-bowden'],
    });
    expect(reading.status).toBe('approved');
  });

  test('a review with no readable author is dropped and reported', () => {
    // A deleted account still has reviews. Carried as '', it would match an
    // approver list that contained an empty string.
    for (const author of [null, {}]) {
      const { rows, dropped } = toReviewRows([{ author, state: 'APPROVED', submittedAt: 'x' }]);
      expect(rows).toEqual([]);
      expect(dropped).toHaveLength(1);
      expect(dropped[0].why).toContain('no readable author');
    }
  });

  test('a state this engine does not know is dropped, and says so', () => {
    // The quiet failure this reports: GitHub adds a review state, a real
    // review vanishes from the reconciliation, and the run simply waits. A
    // caller can log this; it cannot log an absence.
    const { rows, dropped } = toReviewRows([
      { author: { login: 'brannon-bowden' }, state: 'SOMETHING_NEW', submittedAt: 'y' },
    ]);
    expect(rows).toEqual([]);
    expect(dropped).toEqual([
      {
        author: 'brannon-bowden',
        state: 'SOMETHING_NEW',
        why: 'SOMETHING_NEW is not a review state this engine knows, so what it decided '
          + 'cannot be read',
      },
    ]);
  });

  test('a dropped row names the author, so a person can go and look', () => {
    // An unrecognised state is only actionable if you know whose review it
    // was. Reporting the count alone would be a mystery with a number on it.
    const { dropped } = toReviewRows([
      { author: { login: 'someone' }, state: 'INVENTED', submittedAt: 'y' },
    ]);
    expect(dropped[0].author).toBe('someone');
  });

  test('a PENDING review with no timestamp does not become undefined', () => {
    // It is not a position, but it must not poison a comparison either.
    const { rows } = toReviewRows([
      { author: { login: 'x' }, state: 'PENDING', submittedAt: null },
    ]);
    expect(rows).toEqual([{ author: 'x', state: 'PENDING', submittedAt: '' }]);
  });

  test('a state in the wrong case is still read', () => {
    const { rows } = toReviewRows([
      { author: { login: 'x' }, state: 'approved', submittedAt: 'y' },
    ]);
    expect(rows[0].state).toBe('APPROVED');
  });

  test('a known state is never reported as dropped', () => {
    // CONTROL: a reporter that flagged everything would be as useless as one
    // that flagged nothing, and noisier.
    for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']) {
      const { dropped } = toReviewRows([
        { author: { login: 'x' }, state, submittedAt: 'y' },
      ]);
      expect(dropped).toEqual([]);
    }
  });
});

describe('the recorded check set', () => {
  test('the two phases become one list the evaluator can filter', () => {
    expect(toExpectedChecks({ ci: ['quality-gate'], afterReviewRequest: ['arbiter/review'] })).toEqual([
      { name: 'quality-gate' },
      { name: 'arbiter/review', afterReviewRequest: true },
    ]);
  });

  test('a repo that records nothing becomes an empty list', () => {
    // Exit 3 from the plugin. Empty is what makes the evaluator say
    // "undriveable" in terms of a run, which is the only place that sentence
    // belongs.
    expect(toExpectedChecks(null)).toEqual([]);
    expect(evaluateChecks(toExpectedChecks(null), [], 'beforeReviewRequest').status).toBe(
      'undriveable',
    );
  });

  test('one recorded phase does not invent the other', () => {
    expect(toExpectedChecks({ ci: ['quality-gate'] })).toEqual([{ name: 'quality-gate' }]);
    expect(toExpectedChecks({ afterReviewRequest: ['arbiter/review'] })).toEqual([
      { name: 'arbiter/review', afterReviewRequest: true },
    ]);
  });
});

describe('the commands', () => {
  test('one gh call carries every field a reconcile needs', () => {
    // Three calls for one answer spends a rate-limit budget on nothing: it
    // all comes back from the same request.
    const argv = prSnapshotArgv('Software-Development-LLC/Bodhilander', 270);
    expect(argv).toEqual([
      'pr', 'view', '270',
      '--repo', 'Software-Development-LLC/Bodhilander',
      '--json', 'statusCheckRollup,reviews,state,mergedAt,isDraft',
    ]);
  });

  test('the plugin scripts are invoked as Python, never through bash', () => {
    // verify.py already does this and says why: subprocess with no shell
    // cannot CreateProcess a .sh on Windows — WinError 193, raised before
    // anything can be reported.
    const argv = expectedChecksArgv('C:/py/python.exe', '/plugins/bodhi', 'Bodhilander');
    expect(argv).toEqual([
      'C:/py/python.exe',
      '/plugins/bodhi/scripts/lib/registry_entry.py',
      'Bodhilander',
      '--expected-checks',
    ]);
    expect(argv.some((a) => a.endsWith('.sh'))).toBe(false);
  });

  test('the review reader takes its body on stdin, not in argv', () => {
    // A review body is long, and on a PR it is arbitrary text.
    const argv = readReviewArgv('C:/py/python.exe', '/plugins/bodhi');
    expect(argv).toEqual(['C:/py/python.exe', '/plugins/bodhi/scripts/lib/read_review.py']);
  });
});
