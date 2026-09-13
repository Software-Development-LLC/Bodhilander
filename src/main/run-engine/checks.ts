/**
 * Is this PR green? (CO-722)
 *
 * Green is a NAMED SET that reported success — never an absence of failure.
 * GH-553 measured `required_status_checks` absent entirely on
 * `bodhi-service-insights`, so "nothing is failing" is satisfied by a repo
 * that checks nothing. And the reported sets differ per repo:
 * `bodhi-service-api` reports ten checks, `bodhi-web-apps` reports eight with
 * `test` **SKIPPED** — and a skipped check is not a passing one.
 *
 * So the engine is told what to expect (`expected_checks`, recorded per repo
 * in the plugin's `registry.overrides.yaml`) and answers against that list. A
 * repo with no list recorded is `undriveable`, not green.
 *
 * Pure, like the state machine: `(expected, reported, phase) -> verdict`. No
 * `gh`, no network, no clock. The hazards here are all shape hazards — a
 * conclusion that is null because a check has not finished, a name that
 * reported twice after a re-run, a check whose trigger the engine is itself
 * withholding — and every one of them is a fixture rather than something to
 * be discovered on a PR that is already waiting.
 *
 * The verdict vocabulary is the plugin's exit-code contract again:
 * `undriveable` is exit 2. A run must never advance on it, and must never
 * send an owner back for it either.
 */

/** One name the engine requires before it will call a PR green. */
export interface ExpectedCheck {
  name: string;
  /**
   * True for a check that cannot report until review is requested —
   * `arbiter/review` is the one that exists today.
   *
   * Without this flag a freshly opened PR parks in `waitingChecks` forever on
   * a check whose trigger the engine is itself withholding, because the
   * engine does not request review until checks are green. The deadlock is
   * mutual and silent: nothing fails, nothing arrives, and the run looks busy.
   */
  afterReviewRequest?: boolean;
}

/**
 * One row of `gh pr view --json statusCheckRollup`.
 *
 * Two shapes come back from that field and they do not share field names — a
 * CheckRun carries `name`/`status`/`conclusion`, a StatusContext carries
 * `context`/`state`. The caller flattens; this module takes the flattened
 * form so the difference cannot leak into the rules.
 */
export interface ReportedCheck {
  name: string;
  /**
   * `SUCCESS`, `FAILURE`, `SKIPPED`, … or **null while the check is still
   * running**. Null is the field's normal state for minutes at a time, and
   * reading it as a failure would red every PR the moment it opens.
   */
  conclusion: string | null;
  /** `COMPLETED`, `IN_PROGRESS`, `QUEUED`, or null when the source has none. */
  status?: string | null;
}

export type ChecksVerdict =
  | { status: 'green' }
  /** A real result about the branch: something ran and said no. */
  | { status: 'failed'; failing: string[] }
  /** Some expected name has not reported yet. Nothing is wrong; wait. */
  | { status: 'waiting'; pending: string[] }
  /**
   * Exit 2. Either nothing was declared to check, or a required check
   * reported something that is not a result — skipped, cancelled, neutral.
   * Not a fault in the branch, and not a pass.
   */
  | { status: 'undriveable'; reason: string; names: string[] };

/** Which names count right now. */
export type ChecksPhase = 'beforeReviewRequest' | 'afterReviewRequest';

/**
 * Conclusions that are a real, final answer about the branch.
 *
 * `ACTION_REQUIRED` is here rather than in the undriveable set because it is
 * a check refusing the change until someone does something — a verdict, not
 * an absence of one.
 */
const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE']);

/**
 * Conclusions that are final and say NOTHING about the branch.
 *
 * `SKIPPED` is the measured one: `bodhi-web-apps` reports `test` skipped, and
 * counting that as a pass is how a required suite that never ran becomes part
 * of a green. `CANCELLED` and `STALE` are the same statement after a re-run.
 */
const ESTABLISHED_NOTHING = new Set(['SKIPPED', 'NEUTRAL', 'CANCELLED', 'STALE']);

/** Rollup states that mean "still going", whatever field they arrived in. */
const IN_FLIGHT = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']);

type Outcome = 'passed' | 'failed' | 'nothing' | 'pending';

/**
 * What one reported row says.
 *
 * A null conclusion on an unfinished check is pending, not failure. A null
 * conclusion on a check that claims to be COMPLETED is neither: it finished
 * and reported nothing, which is exactly the undriveable case.
 */
function outcomeOf(check: ReportedCheck): Outcome {
  const state = (check.status ?? '').toUpperCase();
  if (IN_FLIGHT.has(state)) return 'pending';
  const conclusion = (check.conclusion ?? '').toUpperCase();
  if (conclusion === 'SUCCESS') return 'passed';
  if (FAILING.has(conclusion)) return 'failed';
  if (ESTABLISHED_NOTHING.has(conclusion)) return 'nothing';
  if (IN_FLIGHT.has(conclusion)) return 'pending';
  // No conclusion and no state saying why. Observed exactly this on a rollup
  // queried mid-run: both fields empty. Unfinished, not failed.
  return conclusion === '' ? 'pending' : 'nothing';
}

/**
 * Fold every row reported under one expected name.
 *
 * A re-run leaves the old row in place, so a name can report twice with
 * different answers. This fails closed: a name is `passed` only when every
 * row under it passed. The alternative — trusting the newest — needs a
 * timestamp the rollup does not always carry, and guessing which row is
 * current is how a stale green gets believed.
 */
function outcomeFor(name: string, reported: readonly ReportedCheck[]): Outcome | 'absent' {
  const rows = reported.filter((r) => r.name === name);
  if (rows.length === 0) return 'absent';
  const outcomes = rows.map(outcomeOf);
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('pending')) return 'pending';
  if (outcomes.includes('nothing')) return 'nothing';
  return 'passed';
}

/**
 * The verdict for one PR.
 *
 * Ranked, and the ranking is the contract:
 *
 * 1. **failed** — final, and the only answer that says the branch is wrong.
 * 2. **waiting** — something may still change, so nothing is decided.
 * 3. **undriveable** — final, but not about the branch.
 * 4. **green** — every expected name reported success.
 *
 * `failed` outranks `waiting` because a failure will not un-fail. `waiting`
 * outranks `undriveable` because a skipped check beside a running one is not
 * yet the whole story, and reporting the run stuck while CI is still working
 * would pull a person to a PR that needs nobody.
 */
export function evaluateChecks(
  expected: readonly ExpectedCheck[],
  reported: readonly ReportedCheck[],
  phase: ChecksPhase,
): ChecksVerdict {
  const due =
    phase === 'afterReviewRequest' ? [...expected] : expected.filter((c) => !c.afterReviewRequest);

  if (expected.length === 0) {
    return {
      status: 'undriveable',
      reason:
        'no expected_checks recorded for this repo, so nothing defines green here. ' +
        'A repo that checks nothing does not report green — record the set in ' +
        "the plugin's registry.overrides.yaml.",
      names: [],
    };
  }
  if (due.length === 0) {
    // Every declared name is review-triggered, so before the request there is
    // nothing CI is expected to say. Advancing would request review on a
    // branch nothing has checked.
    return {
      status: 'undriveable',
      reason:
        'every expected check is review-triggered, so nothing reports before review ' +
        'is requested. There is no CI result to gate the request on.',
      names: expected.map((c) => c.name),
    };
  }

  const graded = due.map((check) => ({ name: check.name, outcome: outcomeFor(check.name, reported) }));
  const failing = graded.filter((g) => g.outcome === 'failed').map((g) => g.name);
  if (failing.length > 0) return { status: 'failed', failing };

  const pending = graded
    .filter((g) => g.outcome === 'pending' || g.outcome === 'absent')
    .map((g) => g.name);
  if (pending.length > 0) return { status: 'waiting', pending };

  const nothing = graded.filter((g) => g.outcome === 'nothing').map((g) => g.name);
  if (nothing.length > 0) {
    return {
      status: 'undriveable',
      reason:
        `${nothing.join(', ')} finished without establishing anything — skipped, ` +
        'cancelled or neutral. A required check that did not run is not a passing one.',
      names: nothing,
    };
  }

  return { status: 'green' };
}
