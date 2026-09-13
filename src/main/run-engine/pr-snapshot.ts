/**
 * Turning what `gh` and the plugin actually return into what the readers take
 * (CO-722).
 *
 * `checks.ts` and `reviews.ts` decide; this is the layer that hands them
 * something to decide about. It is separate and pure because every hazard in
 * reconciliation is a SHAPE hazard, and a shape hazard discovered during a
 * real run is discovered on a PR that is already waiting.
 *
 * The shapes are measured, not documented-and-hoped:
 *
 * ```
 * $ gh pr view 269 --json statusCheckRollup --jq '[.[]|{t:.__typename,keys:keys}]'
 * CheckRun       name, status, conclusion, completedAt, detailsUrl, workflowName
 * StatusContext  context, state, targetUrl, startedAt
 * ```
 *
 * The two do not share a single field name that matters. `arbiter/review` is
 * a **StatusContext**, so a reader that only knew about `name`/`conclusion`
 * would see the review gate as absent — and absent reads as "not reported
 * yet", which waits forever rather than failing.
 *
 * Nothing here judges. A row this module cannot name is dropped rather than
 * guessed at, and a dropped row simply fails to satisfy an expected name,
 * which lands in `waiting` — the outcome that costs time instead of
 * correctness.
 */
import type { ExpectedCheck, ReportedCheck } from './checks';
import type { ReviewRow } from './reviews';

/** One `statusCheckRollup` entry, in either of the two shapes it arrives in. */
export interface RawRollupEntry {
  __typename?: string;
  /** CheckRun. */
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  /** StatusContext — and there is no `status` or `conclusion` beside it. */
  context?: string | null;
  state?: string | null;
}

/** One `reviews` entry. */
export interface RawReview {
  author?: { login?: string | null } | null;
  state?: string | null;
  submittedAt?: string | null;
  body?: string | null;
}

/** What `registry-entry.sh --expected-checks` prints. */
export interface RawExpectedChecks {
  ci?: readonly string[] | null;
  afterReviewRequest?: readonly string[] | null;
}

const REVIEW_STATES = new Set([
  'APPROVED',
  'CHANGES_REQUESTED',
  'COMMENTED',
  'DISMISSED',
  'PENDING',
]);

/**
 * Rollup entries as one flat shape.
 *
 * A StatusContext's `state` becomes `conclusion`, which is exactly right for
 * the reader downstream: `SUCCESS` and `FAILURE` mean the same in both, and
 * `PENDING` arrives where the reader already looks for in-flight values. It
 * carries no `status`, so none is invented — an absent status there is the
 * truth, not a gap to fill.
 */
export function flattenRollup(entries: readonly RawRollupEntry[]): ReportedCheck[] {
  const flat: ReportedCheck[] = [];
  for (const entry of entries) {
    const name = (entry.name ?? entry.context ?? '').trim();
    // A row with no name can never match an expected name, so it decides
    // nothing either way. Dropped rather than carried as '', which would
    // quietly match an expected check somebody recorded as an empty string.
    if (!name) continue;
    flat.push({
      name,
      conclusion: entry.conclusion ?? entry.state ?? null,
      status: entry.status ?? null,
    });
  }
  return flat;
}

/** A row that could not be translated, and what about it could not be. */
export interface DroppedReview {
  author: string;
  state: string;
  why: string;
}

/**
 * Review rows, and what was dropped getting them.
 *
 * A row whose author cannot be read is dropped: a deleted account still has
 * reviews, and one carried as `''` would match an approver list containing an
 * empty string.
 *
 * A row whose STATE this engine does not recognise is dropped too, and that
 * one is reported rather than merely discarded. GitHub adding a review state
 * is a thing that happens, and the failure it would cause here is the quiet
 * kind: a real review vanishing from the reconciliation with the run simply
 * waiting on. Returning it means a caller can say so out loud, which is the
 * difference between a mystery and a line in a log.
 */
export function toReviewRows(raw: readonly RawReview[]): {
  rows: ReviewRow[];
  dropped: DroppedReview[];
} {
  const rows: ReviewRow[] = [];
  const dropped: DroppedReview[] = [];
  for (const review of raw) {
    const author = (review.author?.login ?? '').trim();
    const state = (review.state ?? '').toUpperCase();
    if (!author) {
      dropped.push({
        author: '',
        state,
        why: 'the review has no readable author, so it can never match an approver',
      });
      continue;
    }
    if (!REVIEW_STATES.has(state)) {
      dropped.push({
        author,
        state,
        why: `${state || 'an empty state'} is not a review state this engine knows, so what `
          + 'it decided cannot be read',
      });
      continue;
    }
    rows.push({
      author,
      state: state as ReviewRow['state'],
      // A PENDING review has no submittedAt. Empty sorts before every real
      // timestamp, and PENDING is not a position anyway — but a missing field
      // must not become `undefined` in a comparison.
      submittedAt: review.submittedAt ?? '',
    });
  }
  return { rows, dropped };
}

/**
 * The two recorded phases as one list the evaluator can filter.
 *
 * `null` — the plugin's answer for a repo that records nothing, exit 3 —
 * becomes an empty list, and an empty list is what makes `evaluateChecks`
 * report `undriveable`. The "no bar was defined" message belongs to the
 * evaluator, which is the only place that can say it in terms of a run.
 */
export function toExpectedChecks(raw: RawExpectedChecks | null | undefined): ExpectedCheck[] {
  if (!raw) return [];
  const ci = (raw.ci ?? []).map((name) => ({ name }));
  const after = (raw.afterReviewRequest ?? []).map((name) => ({
    name,
    afterReviewRequest: true,
  }));
  return [...ci, ...after];
}

/**
 * `gh` arguments for one PR's reconcilable state.
 *
 * One call, not three. The design allows one pass per waiting run against a
 * 5,000/hour budget, and three calls for one answer spends that on nothing:
 * every field here comes back from the same request.
 */
export function prSnapshotArgv(repo: string, prNumber: number): string[] {
  return [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'statusCheckRollup,reviews,state,mergedAt,isDraft',
  ];
}

/**
 * The plugin's scripts, invoked as Python rather than through their `.sh`
 * wrappers.
 *
 * `verify.py` already does this and says why: `sh()` calls subprocess with no
 * shell, so Windows tried to CreateProcess a shell script directly and raised
 * WinError 193 — escaping before anything could be reported. The wrappers are
 * a thin `exec python lib/<name>.py "$@"`, so this is the same program
 * without requiring bash on PATH.
 */
export function pluginScriptArgv(
  pythonPath: string,
  harnessPath: string,
  script: 'registry_entry' | 'read_review',
  args: readonly string[] = [],
): string[] {
  return [pythonPath, `${harnessPath}/scripts/lib/${script}.py`, ...args];
}

/** What `registry-entry.sh --expected-checks` is asked. */
export function expectedChecksArgv(
  pythonPath: string,
  harnessPath: string,
  repo: string,
): string[] {
  return pluginScriptArgv(pythonPath, harnessPath, 'registry_entry', [repo, '--expected-checks']);
}

/**
 * What `read-review.sh` is asked — the body arrives on stdin.
 *
 * A review body is long and, on a PR, arbitrary text. Putting it in argv is a
 * quoting problem with no upside and a command-line length ceiling behind it.
 */
export function readReviewArgv(pythonPath: string, harnessPath: string): string[] {
  return pluginScriptArgv(pythonPath, harnessPath, 'read_review');
}
