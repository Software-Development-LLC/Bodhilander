/**
 * What the reviews on a PR add up to (CO-722).
 *
 * The state machine already knows what to do with a verdict: an approval
 * releases the run, a human's changes-requested returns it to gate 2, and a
 * bot finding below `major` is recorded without spending an owner cycle on a
 * note. What it needs is someone to read the rows honestly, and the rows are
 * messier than the rule.
 *
 * Measured on this org's own PRs, 2026-09-13:
 *
 * - GitHub keeps EVERY review, not the current one. A PR where an approver
 *   requested changes and later approved carries both rows forever.
 * - The `arbiter/review` verdict arrives as a **StatusContext** — `context`
 *   and `state`, not `name` and `conclusion` — and on one PR of three it was
 *   absent entirely although a review had happened.
 * - The PR review row beside that status is authored by a **human login** and
 *   carries **no arbiter markers at all**.
 *
 * That last one is why this module refuses to infer. It cannot tell a bot
 * review from a person's by the author, so it does not try: a review is a
 * PERSON'S unless something proves otherwise, and the only proof it accepts
 * is the plugin's own marker parser answering yes. The asymmetry is
 * deliberate. Reading a bot nit as a person costs one owner cycle; reading a
 * person's blocking review as a bot nit ignores someone who said stop, and
 * ships the change.
 *
 * Pure. The marker reading happens elsewhere — `read-review.sh` in the pinned
 * harness owns that judgment, and a copy of it here would be the domain
 * knowledge this engine may not hold — so its answer arrives as an input.
 */
import type { ReviewVerdict, RunEvent } from './transitions';

/** One row of `gh pr view --json reviews`. */
export interface ReviewRow {
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  /** ISO 8601. The only thing that orders the rows. */
  submittedAt: string;
  /**
   * What `read-review.sh` said about this row's body, when it was asked.
   *
   * Absent means not asked. Present with `arbiter: false` means asked and
   * told it carries no markers — which is the common case and is NOT an
   * error. Neither is evidence of a bot.
   */
  marker?: MarkerReading;
}

/** The payload `read-review.sh` prints, narrowed to what decides anything. */
export interface MarkerReading {
  arbiter: boolean;
  blocks: boolean | null;
  highest: 'blocking' | 'major' | 'minor' | 'nit' | null;
  /**
   * The script's exit code. 2 means markers were present and unreadable,
   * which is not the same as absent and must not be read as "a person's".
   */
  code: 0 | 1 | 2 | 3;
}

export type ReviewReading =
  | { status: 'approved'; by: string }
  | { status: 'changesRequested'; by: string; verdict: ReviewVerdict }
  /** Nobody has answered yet. */
  | { status: 'waiting'; reason: string }
  /** A review exists and could not be read. Exit 2's meaning, one level up. */
  | { status: 'undriveable'; reason: string };

/**
 * Rows this module will look at at all.
 *
 * Everything else on the PR is noise, and worse than noise: a review body is
 * the one place a marker can be forged by anyone who can comment. The plugin
 * says so in as many words — *"0 means the markers in this text say so, never
 * an approver said so, and where the body came from is the caller's
 * problem"* — and this is where that problem is answered. Only an approver's
 * own review row is ever read, so a marker typed by anyone else decides
 * nothing.
 */
function byApprovers(rows: readonly ReviewRow[], approvers: readonly string[]): ReviewRow[] {
  const allowed = new Set(approvers.map((a) => a.toLowerCase()));
  return rows.filter((row) => allowed.has(row.author.toLowerCase()));
}

/**
 * The latest row per author that says anything.
 *
 * `COMMENTED` and `PENDING` say nothing either way, and `DISMISSED` has been
 * explicitly withdrawn. Folding them in would let a drive-by comment outrank
 * the approval that came before it.
 *
 * Latest per AUTHOR, not latest overall: two approvers are two opinions, and
 * one person's approval does not answer another's block. That case — an
 * approval standing beside an unresolved changes-requested — is a recorded
 * hazard, and it is the reason this is a fold rather than a `find`.
 */
function currentPositions(rows: readonly ReviewRow[]): ReviewRow[] {
  const latest = new Map<string, ReviewRow>();
  for (const row of rows) {
    if (row.state !== 'APPROVED' && row.state !== 'CHANGES_REQUESTED') continue;
    const key = row.author.toLowerCase();
    const held = latest.get(key);
    if (!held || row.submittedAt > held.submittedAt) latest.set(key, row);
  }
  return [...latest.values()];
}

/**
 * Who filed this, and how badly — from evidence, never from inference.
 *
 * `actor: 'bot'` requires the plugin to have READ markers in this row's body
 * and said yes. No markers, or never asked, means a person, because that is
 * the answer whose mistake is survivable.
 */
function verdictFor(row: ReviewRow): ReviewVerdict {
  const marker = row.marker;
  if (!marker?.arbiter) return { actor: 'human' };
  // A bot review whose severity could not be established is not a nit. The
  // state machine treats anything but `major` as recordable-and-ignorable, so
  // an unknown severity has to arrive as major or a missing count becomes a
  // pass by the back door.
  const severity = marker.highest === 'nit' || marker.highest === 'minor' ? 'nit' : 'major';
  return { actor: 'bot', severity };
}

export interface ReviewInputs {
  rows: readonly ReviewRow[];
  /** Who may decide. Everyone else is noise — see byApprovers. */
  approvers: readonly string[];
}

/**
 * What the PR's reviews currently say.
 *
 * A block outranks an approval, and that is the recorded hazard rather than a
 * preference: two approvers are two opinions, and an approval standing beside
 * somebody else's unresolved changes-requested is not agreement.
 */
export function readReviews({ rows, approvers }: ReviewInputs): ReviewReading {
  if (approvers.length === 0) {
    // Nobody is empowered to decide, so every review is noise and the run
    // would wait forever on an answer that cannot arrive. Say so.
    return {
      status: 'undriveable',
      reason: 'no approvers recorded for this run, so no review can decide anything',
    };
  }

  const positions = currentPositions(byApprovers(rows, approvers));
  if (positions.length === 0) {
    return { status: 'waiting', reason: 'no approver has reviewed yet' };
  }

  const unreadable = positions.find((row) => row.marker?.code === 2);
  if (unreadable) {
    // Markers present and unreadable. Not a person's review, and not a
    // verdict either — the one case where reading on would be a guess.
    return {
      status: 'undriveable',
      reason: `${unreadable.author}'s review carries arbiter markers that could not be read, `
        + 'so what it decided is unknown',
    };
  }

  const blocked = positions.find((row) => row.state === 'CHANGES_REQUESTED');
  if (blocked) {
    return { status: 'changesRequested', by: blocked.author, verdict: verdictFor(blocked) };
  }

  const approved = positions.find((row) => row.state === 'APPROVED');
  if (approved) return { status: 'approved', by: approved.author };

  return { status: 'waiting', reason: 'no approver has reviewed yet' };
}

/**
 * The reading as the event the state machine consumes, or null while nothing
 * has changed.
 *
 * `waiting` produces nothing, for the same reason the check evaluator's does:
 * a run that is still waiting has nothing to record, and an event per poll
 * would bury the ones that matter.
 */
export function reviewEvent(reading: ReviewReading): RunEvent | null {
  switch (reading.status) {
    case 'approved':
      return { kind: 'reviewApproved' };
    case 'changesRequested':
      return { kind: 'reviewChangesRequested', verdict: reading.verdict };
    case 'undriveable':
      return { kind: 'reviewUndriveable', reason: reading.reason };
    default:
      return null;
  }
}
