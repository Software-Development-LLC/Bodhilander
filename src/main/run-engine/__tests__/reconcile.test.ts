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
import { phaseFor, reconcileOnce, type ReconcileDeps, type ReconcileTarget } from '../reconcile';
import { transition } from '../transitions';

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

const RECORDED = {
  expected_checks: { ci: ['quality-gate'], afterReviewRequest: ['arbiter/review'] },
};

const ok = (stdout: unknown) => ({ code: 0, stdout: JSON.stringify(stdout), stderr: '' });

interface FakeOptions {
  pr?: { code: number; stdout: string; stderr: string };
  checks?: { code: number; stdout: string; stderr: string };
  marker?: { code: number; stdout: string; stderr: string };
}

/** Records every command, so "what ran, and in what order" is assertable. */
function fake(options: FakeOptions = {}) {
  const calls: { argv: string[]; stdin?: string }[] = [];
  const deps: ReconcileDeps = {
    gh: async (argv) => {
      calls.push({ argv: [...argv] });
      return options.pr ?? ok({ statusCheckRollup: GREEN_ROLLUP, reviews: [], mergedAt: null });
    },
    plugin: async (argv, stdin) => {
      calls.push({ argv: [...argv], stdin });
      if (argv.some((a) => a.includes('read_review'))) {
        return options.marker ?? ok({ arbiter: false, highest: null });
      }
      return options.checks ?? ok(RECORDED);
    },
  };
  return { deps, calls };
}

describe('what a failure MEANS is not uniform', () => {
  test('gh failing produces no event, because asking again might work', async () => {
    // A run parked on a flaky connection is worse than a run a minute behind.
    const { deps } = fake({ pr: { code: 1, stdout: '', stderr: 'could not resolve host' } });
    const result = await reconcileOnce(TARGET, deps);
    expect(result.events).toEqual([]);
    expect(result.problems[0]).toContain('could not resolve host');
  });

  test('a repo with no recorded check set stops the run, because it never will', async () => {
    // Exit 3 from the plugin: registered, records nothing. No number of
    // retries defines a bar, so this is an event and not a problem.
    const { deps } = fake({
      checks: {
        code: 3,
        stdout: JSON.stringify({ expected_checks: null, detail: 'records no expected_checks' }),
        stderr: '',
      },
    });
    const result = await reconcileOnce(TARGET, deps);
    expect(result.events).toEqual([
      { kind: 'checksUndriveable', reason: 'records no expected_checks' },
    ]);
    expect(result.problems).toEqual([]);
  });

  test('an unregistered repo stops the run too, and says which it was', async () => {
    const { deps } = fake({
      checks: {
        code: 2,
        stdout: JSON.stringify({ detail: 'Bodhilander is not in registry.yaml' }),
        stderr: '',
      },
    });
    const result = await reconcileOnce(TARGET, deps);
    expect(result.events[0]).toEqual({
      kind: 'checksUndriveable',
      reason: 'Bodhilander is not in registry.yaml',
    });
  });

  test('the two are not the same answer', async () => {
    // Asserted directly, because collapsing them either way is the bug: one
    // parks every run on a network blip, the other retries a config fault
    // forever with nobody told.
    const network = await reconcileOnce(
      TARGET,
      fake({ pr: { code: 1, stdout: '', stderr: 'offline' } }).deps,
    );
    const config = await reconcileOnce(
      TARGET,
      fake({ checks: { code: 3, stdout: '{}', stderr: '' } }).deps,
    );
    expect(network.events).toHaveLength(0);
    expect(config.events).toHaveLength(1);
  });

  test('a non-zero lookup is not redeemed by a payload that looks fine', async () => {
    // docs/EXIT-CODES.md exists because a caller reads the CODE, not the
    // message. A tool that exited 2 and still printed a check set has
    // contradicted itself, and believing the half that is convenient is how
    // an unusable configuration becomes a green.
    const { deps } = fake({
      checks: {
        code: 2,
        stdout: JSON.stringify({ ...RECORDED, detail: 'not in registry.yaml' }),
        stderr: '',
      },
    });
    const result = await reconcileOnce(TARGET, deps);
    expect(result.events).toEqual([
      { kind: 'checksUndriveable', reason: 'not in registry.yaml' },
    ]);
  });

  test('an exit code the lookup does not define is retryable, not a config fault', async () => {
    // registry-entry answers 0, 2 or 3 and nothing else today, so another
    // code is a crash, a spawn failure, or a version that grew a meaning this
    // engine was never taught. None of those is evidence about the repo, and
    // stopping a run for a crash is the mistake this module documents about
    // gh -- applied to the other path.
    const { deps } = fake({ checks: { code: 1, stdout: '', stderr: 'Traceback...' } });
    const result = await reconcileOnce(TARGET, deps);
    expect(result.events).toEqual([]);
    expect(result.problems[0]).toContain('outside its own contract');
  });

  test('a lookup that exits 0 and prints rubbish is retryable too', async () => {
    // It claimed to have answered and then said nothing readable. Most
    // plausibly a half-written stream, and nothing about the registry.
    const { deps } = fake({ checks: { code: 0, stdout: 'Traceback (most recent', stderr: '' } });
    const result = await reconcileOnce(TARGET, deps);
    expect(result.events).toEqual([]);
    expect(result.problems[0]).toContain('not JSON');
  });

  test('2 and 3 still stop the run, and 1 still does not', async () => {
    // The line itself, asserted across the codes rather than one at a time:
    // the question is never "did it fail" but "could asking again help".
    for (const code of [2, 3]) {
      const { deps } = fake({ checks: { code, stdout: '{"detail":"no bar"}', stderr: '' } });
      const result = await reconcileOnce(TARGET, deps);
      expect(result.events).toEqual([{ kind: 'checksUndriveable', reason: 'no bar' }]);
    }
    const { deps } = fake({ checks: { code: 1, stdout: '{"detail":"no bar"}', stderr: '' } });
    expect((await reconcileOnce(TARGET, deps)).events).toEqual([]);
  });

  test('gh returning something that is not JSON is a problem, not a state', async () => {
    const { deps } = fake({ pr: { code: 0, stdout: 'rate limit exceeded', stderr: '' } });
    const result = await reconcileOnce(TARGET, deps);
    expect(result.events).toEqual([]);
    expect(result.problems[0]).toContain('not JSON');
  });
});

describe('a merged PR is answered alone', () => {
  test('merged ends the pass before anything else is asked', async () => {
    // A late check result must not move a finished run, and nothing below the
    // merge check is a question about a PR that is still open.
    const { deps, calls } = fake({
      pr: ok({ statusCheckRollup: [], reviews: [], mergedAt: '2026-09-13T18:00:00Z' }),
    });
    const result = await reconcileOnce(TARGET, deps);
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
    const result = await reconcileOnce({ ...TARGET, state: 'waitingChecks' }, deps);
    expect(result.events).toEqual([{ kind: 'checksGreen' }]);
  });

  test('and the same PR is still waiting once review has been requested', async () => {
    const { deps } = fake({
      pr: ok({ statusCheckRollup: [GREEN_ROLLUP[0]], reviews: [], mergedAt: null }),
    });
    const result = await reconcileOnce({ ...TARGET, state: 'waitingReview' }, deps);
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
    await reconcileOnce({ ...TARGET, state: 'waitingReview' }, deps);
    expect(calls.some((c) => c.argv.some((a) => a.includes('read_review')))).toBe(false);
  });

  test('an approver’s body is read, and arrives on stdin', async () => {
    const { deps, calls } = fake({
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
    await reconcileOnce({ ...TARGET, state: 'waitingReview' }, deps);
    const read = calls.find((c) => c.argv.some((a) => a.includes('read_review')));
    expect(read?.stdin).toBe('Approving.');
  });

  test('the right body goes with the right author when a row was dropped', async () => {
    // The misattribution this guards: a dropped row shifts every index after
    // it, so a body matched back by position is a different person's review.
    const { deps, calls } = fake({
      pr: ok({
        statusCheckRollup: GREEN_ROLLUP,
        reviews: [
          { author: null, state: 'APPROVED', submittedAt: '1', body: 'from a deleted account' },
          {
            author: { login: 'brannon-bowden' },
            state: 'APPROVED',
            submittedAt: '2',
            body: "brannon's review",
          },
        ],
        mergedAt: null,
      }),
    });
    await reconcileOnce({ ...TARGET, state: 'waitingReview' }, deps);
    const read = calls.find((c) => c.argv.some((a) => a.includes('read_review')));
    expect(read?.stdin).toBe("brannon's review");
  });
});

describe('a marker parser answering outside its contract', () => {
  test('an unknown exit code is undriveable, not "not an arbiter review"', async () => {
    // The two readings are miles apart. 2 says nobody knows what this review
    // decided, and the run stops. 3 says it is a person's review, and the
    // run acts on its GitHub state -- here, releasing on an approval whose
    // markers the parser choked on.
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
      marker: { code: 99, stdout: JSON.stringify({ arbiter: true, highest: null }), stderr: '' },
    });
    const result = await reconcileOnce({ ...TARGET, state: 'waitingReview' }, deps);
    expect(result.events).toContainEqual({
      kind: 'reviewUndriveable',
      reason: "brannon-bowden's review carries arbiter markers that could not be read, so "
        + 'what it decided is unknown',
    });
  });

  test('a parser that printed nothing readable leaves the review unmarked', async () => {
    // No marker at all, which reads as a person's review -- the safe default,
    // because the mistake it can make costs an owner cycle and the opposite
    // ignores somebody who said stop.
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
      marker: { code: 2, stdout: 'Traceback (most recent', stderr: '' },
    });
    const result = await reconcileOnce({ ...TARGET, state: 'waitingReview' }, deps);
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
    const result = await reconcileOnce({ ...TARGET, state: 'waitingReview' }, deps);
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
    const result = await reconcileOnce({ ...TARGET, state: 'waitingReview' }, deps);
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
    const result = await reconcileOnce({ ...TARGET, state: 'waitingReview' }, deps);
    expect(result.problems[0]).toContain('brannon-bowden');
    expect(result.problems[0]).toContain('SOMETHING_NEW');
  });

  test('one pass makes exactly one gh call', async () => {
    // The design allows one per waiting run against a 5,000/hour budget.
    // Three calls for one answer spends it on nothing.
    const { deps, calls } = fake();
    await reconcileOnce(TARGET, deps);
    expect(calls.filter((c) => c.argv[0] === 'pr')).toHaveLength(1);
  });
});
