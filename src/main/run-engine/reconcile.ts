/**
 * One reconciliation pass over one run (CO-722).
 *
 * Reconciliation is the engine's ONLY state path. Events from a webhook, a
 * relay reconnect or a timer may trigger a pass; none of them is ever parsed
 * for state. That rule is what makes a missed, replayed or out-of-order
 * delivery cost at worst a redundant `gh` call, and it is why this module
 * asks GitHub rather than being told.
 *
 * Everything it decides with is already merged and pure — `evaluateChecks`,
 * `readReviews`, and the translators in `pr-snapshot`. What is left here is
 * the part that touches the world, so what is left to get wrong is: which
 * processes run, in what order, and what a failure of each one MEANS.
 *
 * The meanings are the interesting part, and they are not uniform:
 *
 * - **`gh` failed.** Nothing was established, and nothing is wrong with the
 *   branch. No event: the next pass asks again. Escalating a transient
 *   network failure into a run state would park runs on a flaky connection.
 * - **The repo records no check set.** Something IS wrong, it is a
 *   configuration fault, and no number of retries fixes it. That becomes
 *   `checksUndriveable`, which stops the run and tells a person.
 * - **A review carries unreadable markers.** Same: `reviewUndriveable`.
 *
 * The difference is whether asking again could change the answer. Problems
 * that retrying cannot fix are events; problems that retrying might fix are
 * reported to the caller and left for the next pass.
 */
import type { RunEvent, RunState } from './transitions';
import { checksEvent, evaluateChecks, type ChecksPhase } from './checks';
import { readReviews, reviewEvent, type MarkerReading, type ReviewRow } from './reviews';
import {
  expectedChecksArgv,
  flattenRollup,
  prSnapshotArgv,
  readReviewArgv,
  toExpectedChecks,
  toReviewRows,
  type RawExpectedChecks,
  type RawReview,
  type RawRollupEntry,
} from './pr-snapshot';

/** What a spawned command answered. Supplied by the caller, so this is testable. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ReconcileDeps {
  /** `gh`, already located. */
  gh(argv: readonly string[]): Promise<CommandResult>;
  /** Any plugin script, as python + path + args. `stdin` for the review body. */
  plugin(argv: readonly string[], stdin?: string): Promise<CommandResult>;
}

export interface ReconcileTarget {
  /** `owner/name`, as `gh --repo` takes it. */
  repo: string;
  /** The name `registry.yaml` spells, which is not always the same string. */
  registryRepo: string;
  prNumber: number;
  /** Where the run is. This decides the check PHASE — see `phaseFor`. */
  state: RunState;
  approvers: readonly string[];
  harnessPath: string;
  pythonPath: string;
}

export interface ReconcileResult {
  /** In order. The caller applies each through `transition`. */
  events: RunEvent[];
  /**
   * What went wrong in a way that asking again might fix, and what was
   * dropped on the way. Not a state: the caller logs these, and a loop that
   * sees the same one repeatedly is the thing that should escalate.
   */
  problems: string[];
}

interface Snapshot {
  statusCheckRollup?: RawRollupEntry[] | null;
  reviews?: RawReview[] | null;
  state?: string | null;
  mergedAt?: string | null;
  isDraft?: boolean | null;
}

/**
 * Which checks are owed right now.
 *
 * Read from the RUN, not from GitHub. The engine performs the review request
 * itself, so it already knows whether it has happened — and `reviewRequests`
 * on the PR would not answer this anyway: GitHub clears a pending request the
 * moment the review lands, so a PR that has been reviewed looks exactly like
 * one that was never asked.
 */
export function phaseFor(state: RunState): ChecksPhase {
  return state === 'waitingChecks' || state === 'reviewNotRequested'
    ? 'beforeReviewRequest'
    : 'afterReviewRequest';
}

function parseJson<T>(text: string): T | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

/**
 * A review body, read by the plugin's parser.
 *
 * Only ever called for an approver's own row. `read-review.sh` states that it
 * reads markers, cannot authenticate them, and that where the body came from
 * is the caller's problem — this is the caller, and `readReviews` filters to
 * approvers before anything reaches here.
 */
async function readMarkers(
  body: string,
  target: ReconcileTarget,
  deps: ReconcileDeps,
): Promise<MarkerReading | undefined> {
  const result = await deps.plugin(readReviewArgv(target.pythonPath, target.harnessPath), body);
  const payload = parseJson<{ arbiter?: boolean; highest?: MarkerReading['highest'] }>(
    result.stdout,
  );
  if (!payload) return undefined;
  return {
    arbiter: payload.arbiter === true,
    highest: payload.highest ?? null,
    code: markerCode(result.code),
  };
}

/**
 * The parser's exit code, or 2 for one this engine does not know.
 *
 * 2 is the honest answer for an unrecognised code: a parser that answered
 * something outside its own contract has not established a verdict, and
 * `undriveable` is what "nobody knows" is called here. Reading it as 3 would
 * say "not an arbiter review", which is a claim about the body rather than
 * about the tool.
 */
function markerCode(code: number): MarkerReading['code'] {
  return code === 0 || code === 1 || code === 3 ? code : 2;
}

/**
 * What the recorded-check-set lookup established.
 *
 * Three answers, and the split is the same one the whole module turns on:
 * whether asking again could change it.
 *
 * - **recorded** — 0, and the payload reads.
 * - **noBar** — 2 or 3. The repo is not registered, or records no set. Both
 *   are configuration, and no number of retries defines a bar.
 * - **retry** — anything else. `registry-entry` answers 0, 2 or 3 and nothing
 *   else today, so another code is a crash, a spawn failure, or a version
 *   that has grown a meaning this engine has not been taught. None of those
 *   is evidence about the repo, and stopping a run for one would be the very
 *   mistake this module documents about `gh`.
 *
 * A 0 with output that will not parse lands in `retry` too. The tool claimed
 * to have answered and then said nothing readable — a contradiction, most
 * plausibly a half-written stream, and nothing about the registry.
 */
type ChecksLookup =
  | { kind: 'recorded'; expected: ReturnType<typeof toExpectedChecks> }
  | { kind: 'noBar'; reason: string }
  | { kind: 'retry'; reason: string };

function classifyLookup(result: CommandResult): ChecksLookup {
  const payload = parseJson<{ expected_checks?: RawExpectedChecks | null; detail?: string }>(
    result.stdout,
  );
  if (result.code === 0) {
    if (!payload) {
      return {
        kind: 'retry',
        reason: 'registry-entry exited 0 and printed output that is not JSON, so what it '
          + 'read cannot be known',
      };
    }
    return { kind: 'recorded', expected: toExpectedChecks(payload.expected_checks) };
  }
  if (result.code === 2 || result.code === 3) {
    return {
      kind: 'noBar',
      reason: payload?.detail
        ?? 'this repo records no usable expected_checks, so nothing defines green for it',
    };
  }
  const why = result.stderr.trim() || `exit ${result.code}`;
  return {
    kind: 'retry',
    reason: `registry-entry answered outside its own contract: ${why}`,
  };
}

/** One pass. Never throws for a run that went badly — that is an outcome. */
export async function reconcileOnce(
  target: ReconcileTarget,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const events: RunEvent[] = [];
  const problems: string[] = [];

  const pr = await deps.gh(prSnapshotArgv(target.repo, target.prNumber));
  if (pr.code !== 0) {
    // Retrying might fix it, so it is not a state. A run parked on a flaky
    // connection is worse than a run that is simply a minute behind.
    const why = pr.stderr.trim() || `exit ${pr.code}`;
    problems.push(`gh could not read ${target.repo}#${target.prNumber}: ${why}`);
    return { events, problems };
  }
  const snapshot = parseJson<Snapshot>(pr.stdout);
  if (!snapshot) {
    problems.push(`gh returned output that is not JSON for ${target.repo}#${target.prNumber}`);
    return { events, problems };
  }

  // Merged first and alone. Everything below it is a question about a PR that
  // is still open, and asking them about a merged one invites a late check
  // result to move a finished run.
  if (snapshot.mergedAt) {
    events.push({ kind: 'merged' });
    return { events, problems };
  }

  const recorded = await deps.plugin(
    expectedChecksArgv(target.pythonPath, target.harnessPath, target.registryRepo),
  );
  const lookup = classifyLookup(recorded);
  if (lookup.kind === 'retry') {
    // The same rule as `gh` above, applied to the same kind of failure: the
    // tool did not answer within its own contract, which says nothing about
    // the repo's configuration. Folding this into "nobody defined a bar"
    // would stop a run for a crash, and a crash is the thing most likely to
    // be gone on the next pass.
    problems.push(lookup.reason);
  } else {
    const expected = lookup.kind === 'recorded' ? lookup.expected : [];
    const phase = phaseFor(target.state);
    const verdict = evaluateChecks(
      expected,
      flattenRollup(snapshot.statusCheckRollup ?? []),
      phase,
    );
    const checks = checksEvent(verdict);
    if (checks) {
      // The plugin's own sentence beats anything this module could write
      // about a file it does not own, so it is preferred when present.
      events.push(
        checks.kind === 'checksUndriveable' && lookup.kind === 'noBar'
          ? { kind: 'checksUndriveable', reason: lookup.reason }
          : checks,
      );
    }
  }

  const { rows, dropped } = toReviewRows(snapshot.reviews ?? []);
  for (const row of dropped) {
    // A review that vanished silently is the failure this reports. Naming the
    // author is what makes it actionable.
    problems.push(`review by ${row.author || 'an unreadable author'} ignored: ${row.why}`);
  }

  const approvers = new Set(target.approvers.map((a) => a.toLowerCase()));
  const withMarkers: ReviewRow[] = [];
  for (const row of rows) {
    if (!approvers.has(row.author.toLowerCase())) {
      // Not read at all, let alone parsed. A marker in a stranger's body must
      // never reach the parser: a 0 from it says "the markers say so" and
      // nothing whatever about who wrote them.
      withMarkers.push(row);
      continue;
    }
    // row.body, never snapshot.reviews[i]. A dropped row shifts every index
    // after it, so matching back by position reads one person's body as
    // another's -- and a marker in it would be attributed to whoever happened
    // to be next in the list.
    withMarkers.push({ ...row, marker: await readMarkers(row.body, target, deps) });
  }

  const review = reviewEvent(readReviews({ rows: withMarkers, approvers: target.approvers }));
  if (review) events.push(review);

  return { events, problems };
}
