/**
 * Reconciliation-pass tests (CO-722).
 *
 * The commands are faked and nothing else is: the real translators, the real
 * evaluator, the real reducer and the real state machine all run here. What
 * is under test is the part that cannot be pure — which processes run, in
 * what order, and what a failure of each one MEANS.
 *
 * That last question is the whole module, and the answer is not uniform. The
 * test that matters most is the pair: `gh` failing produces NO event, because
 * asking again might work; a repo with no recorded check set produces
 * `checksUndriveable`, because asking again never will. Collapse them either
 * way and the engine either parks every run on a flaky connection or retries
 * a configuration fault until someone notices by hand.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import { phaseFor, reconcileOnce, expectedChecksLookup, type ChecksLookup, type ReconcileDeps, type ReconcileTarget } from '../reconcile';
import { transition } from '../transitions';
import type { ConfigResult } from '../../../shared/types';

const TARGET: ReconcileTarget = {
  repo: 'Software-Development-LLC/Bodhilander',
  registryRepo: 'Bodhilander',
  prNumber: 271,
  state: 'waitingChecks',
  approvers: ['brannon-bowden'],
  harnessPath: '/plugins/bodhi',
  pythonPath: 'C:/py/python.exe',
};

const GREEN_ROLLUP = [
  { __typename: 'CheckRun', name: 'quality-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'StatusContext', context: 'arbiter/review', state: 'SUCCESS' },
];

/** The green-path lookup: the config records these checks for this repo. */
const CHECKS_RECORDED: ChecksLookup = {
  kind: 'recorded',
  expected: [{ name: 'quality-gate' }, { name: 'arbiter/review', afterReviewRequest: true }],
};

const ok = (stdout: unknown) => ({ code: 0, stdout: JSON.stringify(stdout), stderr: '' });

interface FakeOptions {
  pr?: { code: number; stdout: string; stderr: string };
}

/** Records every command, so "what ran, and in what order" is assertable. */
function fake(options: FakeOptions = {}) {
  const calls: { argv: string[]; stdin?: string }[] = [];
  const deps: ReconcileDeps = {
    gh: async (argv) => {
      calls.push({ argv: [...argv] });
      return options.pr ?? ok({ statusCheckRollup: GREEN_ROLLUP, reviews: [], mergedAt: null });
    },
    // Reconcile no longer spawns the plugin (Phase 3): read_review and the
    // expected-checks lookup are in-process now. A no-op keeps the dep shape.
    plugin: async () => ok({}),
  };
  return { deps, calls };
}

/** reconcileOnce with the check lookup the wiring resolves; defaults to the green recorded set. */
const run = (target: ReconcileTarget, deps: ReconcileDeps, checks: ChecksLookup = CHECKS_RECORDED) =>
  reconcileOnce(target, checks, deps);

describe('what a failure MEANS is not uniform', () => {
  test('gh failing produces no event, because asking again might work', async () => {
    // A run parked on a flaky connection is worse than a run a minute behind.
    const { deps } = fake({ pr: { code: 1, stdout: '', stderr: 'could not resolve host' } });
    const result = await run(TARGET, deps);
    expect(result.events).toEqual([]);
    expect(result.problems[0]).toContain('could not resolve host');
  });

  test('a repo with no recorded check set stops the run, because it never will', async () => {
    // noBar: nothing defines green, and no retry changes that — an event, not a problem.
    const result = await run(TARGET, fake().deps, { kind: 'noBar', reason: 'records no expected_checks' });
    expect(result.events).toEqual([{ kind: 'checksUndriveable', reason: 'records no expected_checks' }]);
    expect(result.problems).toEqual([]);
  });

  test('a config that could not be read is retryable, not a config fault', async () => {
    // retry: the config, not the repo, is the problem — re-attempted like a gh failure.
    const result = await run(TARGET, fake().deps, { kind: 'retry', reason: 'orchestration config could not be read: bad json' });
    expect(result.events).toEqual([]);
    expect(result.problems[0]).toContain('could not be read');
  });

  test('noBar and a gh failure are not the same answer', async () => {
    // Collapsing them either way is the bug: one parks every run on a network
    // blip, the other stops a run nothing will ever make green.
    const network = await run(TARGET, fake({ pr: { code: 1, stdout: '', stderr: 'offline' } }).deps);
    const config = await run(TARGET, fake().deps, { kind: 'noBar', reason: 'no bar' });
    expect(network.events).toHaveLength(0);
    expect(config.events).toHaveLength(1);
  });

  test('gh returning something that is not JSON is a problem, not a state', async () => {
    const { deps } = fake({ pr: { code: 0, stdout: 'rate limit exceeded', stderr: '' } });
    const result = await run(TARGET, deps);
    expect(result.events).toEqual([]);
    expect(result.problems[0]).toContain('not JSON');
  });
});

describe('expectedChecksLookup (from the central config, not registry_entry.py)', () => {
  const okConfig = (repos: Record<string, { expectedChecks?: string[]; expectedChecksAfterReview?: string[] }>): ConfigResult =>
    ({ status: 'ok', config: { version: 1, repos, owners: {}, projects: {} }, fetchedAt: 'now' });

  test('a repo with expectedChecks is recorded, its after-review checks marked', () => {
    const r = expectedChecksLookup(
      okConfig({ Bodhilander: { expectedChecks: ['quality-gate'], expectedChecksAfterReview: ['arbiter/review'] } }),
      'Bodhilander',
    );
    expect(r.kind).toBe('recorded');
    if (r.kind !== 'recorded') throw new Error('unreachable');
    expect(r.expected).toContainEqual({ name: 'quality-gate' });
    expect(r.expected).toContainEqual({ name: 'arbiter/review', afterReviewRequest: true });
  });

  test('a repo with no expectedChecks, or not in the config, is noBar', () => {
    expect(expectedChecksLookup(okConfig({ Bodhilander: {} }), 'Bodhilander').kind).toBe('noBar');
    expect(expectedChecksLookup(okConfig({}), 'not-in-config').kind).toBe('noBar');
  });

  test('an unreadable or absent config is retry, never noBar', () => {
    expect(expectedChecksLookup({ status: 'problem', problem: 'config is not valid JSON' }, 'x').kind).toBe('retry');
    expect(expectedChecksLookup(null, 'x').kind).toBe('retry');
  });
});

describe('a merged PR is answered alone', () => {
  test('merged ends the pass before anything else is asked', async () => {
    // A late check result must not move a finished run, and nothing below the
    // merge check is a question about a PR that is still open.
    const { deps, calls } = fake({
      pr: ok({ statusCheckRollup: [], reviews: [], mergedAt: '2026-09-13T18:00:00Z' }),
    });
    const result = await run(TARGET, deps);
    expect(result.events).toEqual([{ kind: 'merged' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].argv[0]).toBe('pr');
  });
});

describe('the checks phase comes from the run, not from GitHub', () => {
  test('waiting on checks counts only the CI names', () => {
    expect(phaseFor('waitingChecks')).toBe('beforeReviewRequest');
    expect(phaseFor('reviewNotRequested')).toBe('beforeReviewRequest');
  });

  test('waiting on review counts the review-triggered ones too', () => {
    expect(phaseFor('waitingReview')).toBe('afterReviewRequest');
  });

  test('a PR whose arbiter status has not posted is green before the request', async () => {
    // The deadlock the phase split exists to prevent, driven end to end: CI
    // has reported, arbiter has not, and the engine will not request review
    // until this says green.
    const { deps } = fake({
      pr: ok({
        statusCheckRollup: [GREEN_ROLLUP[0]],
        reviews: [],
        mergedAt: null,
      }),
    });
    const result = await run({ ...TARGET, state: 'waitingChecks' }, deps);
    expect(result.events).toEqual([{ kind: 'checksGreen' }]);
  });

  test('and the same PR is still waiting once review has been requested', async () => {
    const { deps } = fake({
      pr: ok({ statusCheckRollup: [GREEN_ROLLUP[0]], reviews: [], mergedAt: null }),
    });
    const result = await run({ ...TARGET, state: 'waitingReview' }, deps);
    expect(result.events).toEqual([]);
  });
});

describe('only an approver’s body reaches the marker parser', () => {
  test('a stranger’s review is never even read', async () => {
    // read-review.sh reads markers and cannot authenticate them. A 0 from it
    // says "the markers say so" and nothing about who wrote them, so a
    // stranger's body must not reach it at all.
    const { deps, calls } = fake({
      pr: ok({
        statusCheckRollup: GREEN_ROLLUP,
        reviews: [
          {
            author: { login: 'a-passer-by' },
            state: 'APPROVED',
            submittedAt: '2026-09-13T18:00:00Z',
            body: '<!-- arbiter:verdict=approve -->',
          },
        ],
        mergedAt: null,
      }),
    });
    await run({ ...TARGET, state: 'waitingReview' }, deps);
    expect(calls.some((c) => c.argv.some((a) => a.includes('read_review')))).toBe(false);
  });

  const ARBITER_MARKER = '<!-- arbiter:verdict=approve --> <!-- arbiter:findings={"blocking":0,"major":0,"minor":0,"nit":0} -->';
  const isBotChanges = (e: { kind: string; verdict?: { actor?: string } }) =>
    e.kind === 'reviewChangesRequested' && e.verdict?.actor === 'bot';

  test('an approver’s own body is parsed: its arbiter markers make the verdict a bot’s', async () => {
    // Proves the marker parser reads THIS body — with no markers the same
    // changes-requested review would be attributed to a human, not a bot.
    const { deps } = fake({
      pr: ok({
        statusCheckRollup: GREEN_ROLLUP,
        reviews: [
          { author: { login: 'brannon-bowden' }, state: 'CHANGES_REQUESTED', submittedAt: '1', body: ARBITER_MARKER },
        ],
        mergedAt: null,
      }),
    });
    const result = await run({ ...TARGET, state: 'waitingReview' }, deps);
    expect((result.events as { kind: string; verdict?: { actor?: string } }[]).some(isBotChanges)).toBe(true);
  });

  test('the right body goes with the right author when a row was dropped', async () => {
    // The misattribution this guards: a dropped row shifts every index after
    // it, so a body matched back by position is a different person's review.
    // Only brannon (an approver) carries the arbiter marker; the deleted-account
    // row does not — so a bot verdict proves brannon's own body was parsed.
    const { deps } = fake({
      pr: ok({
        statusCheckRollup: GREEN_ROLLUP,
        reviews: [
          { author: null, state: 'CHANGES_REQUESTED', submittedAt: '1', body: 'from a deleted account' },
          { author: { login: 'brannon-bowden' }, state: 'CHANGES_REQUESTED', submittedAt: '2', body: ARBITER_MARKER },
        ],
        mergedAt: null,
      }),
    });
    const result = await run({ ...TARGET, state: 'waitingReview' }, deps);
    expect((result.events as { kind: string; verdict?: { actor?: string } }[]).some(isBotChanges)).toBe(true);
  });
});

describe('a review body whose markers do not resolve', () => {
  test('a verdict marker with no findings counts is undriveable, not "not an arbiter review"', async () => {
    // The two readings are miles apart. 2 says nobody knows what this review
    // decided, and the run stops. 3 says it is a person's review, and the run
    // acts on its GitHub state -- here, releasing on an approval whose markers
    // are only half present (a verdict, no counts). Half a review is unreadable.
    const { deps } = fake({
      pr: ok({
        statusCheckRollup: GREEN_ROLLUP,
        reviews: [
          {
            author: { login: 'brannon-bowden' },
            state: 'APPROVED',
            submittedAt: '1',
            body: '<!-- arbiter:verdict=approve -->',
          },
        ],
        mergedAt: null,
      }),
    });
    const result = await run({ ...TARGET, state: 'waitingReview' }, deps);
    expect(result.events).toContainEqual({
      kind: 'reviewUndriveable',
      reason: "brannon-bowden's review carries arbiter markers that could not be read, so "
        + 'what it decided is unknown',
    });
  });

  test('a body with no markers leaves the review unmarked, read by its GitHub state', async () => {
    // No marker at all reads as a person's review -- the safe default, because
    // the mistake it can make costs an owner cycle and the opposite ignores
    // somebody who said stop.
    const { deps } = fake({
      pr: ok({
        statusCheckRollup: GREEN_ROLLUP,
        reviews: [
          {
            author: { login: 'brannon-bowden' },
            state: 'CHANGES_REQUESTED',
            submittedAt: '1',
            body: 'x',
          },
        ],
        mergedAt: null,
      }),
    });
    const result = await run({ ...TARGET, state: 'waitingReview' }, deps);
    expect(result.events).toContainEqual({
      kind: 'reviewChangesRequested',
      verdict: { actor: 'human' },
    });
  });
});

describe('what a pass reports', () => {
  test('an approval becomes the event that releases the run', async () => {
    const { deps } = fake({
      pr: ok({
        statusCheckRollup: GREEN_ROLLUP,
        reviews: [
          {
            author: { login: 'brannon-bowden' },
            state: 'APPROVED',
            submittedAt: '2026-09-13T18:00:00Z',
            body: 'Approving.',
          },
        ],
        mergedAt: null,
      }),
    });
    const result = await run({ ...TARGET, state: 'waitingReview' }, deps);
    expect(result.events).toContainEqual({ kind: 'reviewApproved' });
  });

  test('the events it returns actually move the run', async () => {
    // Bound to the real state machine, because an event nothing handles is
    // silently ignored -- a pass that looks productive and changes nothing.
    const { deps } = fake({
      pr: ok({
        statusCheckRollup: GREEN_ROLLUP,
        reviews: [
          {
            author: { login: 'brannon-bowden' },
            state: 'APPROVED',
            submittedAt: '2026-09-13T18:00:00Z',
            body: 'Approving.',
          },
        ],
        mergedAt: null,
      }),
    });
    const result = await run({ ...TARGET, state: 'waitingReview' }, deps);
    let state: ReconcileTarget['state'] = 'waitingReview';
    for (const event of result.events) {
      state = transition(state, event, { activeGate: null }).state;
    }
    expect(state).toBe('approved');
  });

  test('a review it could not read is reported, not silently forgotten', async () => {
    // GitHub adding a review state is the case: a real review vanishing with
    // the run simply waiting on is the failure worth a line in a log.
    const { deps } = fake({
      pr: ok({
        statusCheckRollup: GREEN_ROLLUP,
        reviews: [
          {
            author: { login: 'brannon-bowden' },
            state: 'SOMETHING_NEW',
            submittedAt: '1',
            body: 'x',
          },
        ],
        mergedAt: null,
      }),
    });
    const result = await run({ ...TARGET, state: 'waitingReview' }, deps);
    expect(result.problems[0]).toContain('brannon-bowden');
    expect(result.problems[0]).toContain('SOMETHING_NEW');
  });

  test('one pass makes exactly one gh call', async () => {
    // The design allows one per waiting run against a 5,000/hour budget.
    // Three calls for one answer spends it on nothing.
    const { deps, calls } = fake();
    await run(TARGET, deps);
    expect(calls.filter((c) => c.argv[0] === 'pr')).toHaveLength(1);
  });
});
