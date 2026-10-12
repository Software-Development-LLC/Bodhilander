/**
 * Read a posted review body's arbiter markers (CO-722, Phase 3 — dropping Python).
 *
 * The TS port of the harness's `read_review.py` (+ the `review_gate` regexes it
 * delegated to). It answers the two questions an orchestrator has about a review
 * already posted to a PR: **is this an arbiter review at all, and does it block?**
 *
 * Pure and total. The exit-code contract is `read_review.py`'s, unchanged:
 *   0  an arbiter review that does not block
 *   1  an arbiter review that blocks (request-changes, or blocking >= 1)
 *   2  markers present but unreadable — a verdict was owed and did not arrive
 *   3  no markers at all: not an arbiter review, so nothing was owed here
 *
 * What it CANNOT tell you is whether the body is really the arbiter's — anyone
 * who can comment can type the markers. A 0/1 means "the markers say so", never
 * "an approver said so"; the caller must fetch the body from a known approver's
 * review (`reconcile.ts` filters to approvers before calling this).
 */

/** The verdict marker: `<!-- arbiter:verdict=approve|comment|request-changes -->`. */
const VERDICT_RE = /<!--\s*arbiter:verdict=(approve|comment|request-changes)\s*-->/i;
/** The findings marker: `<!-- arbiter:findings={...json...} -->`. */
const FINDINGS_RE = /<!--\s*arbiter:findings=(\{[^}]*\})\s*-->/i;

/** Highest first: a review with one major and four nits is a major. */
export const SEVERITIES = ['blocking', 'major', 'minor', 'nit'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface MarkerPayload {
  arbiter: boolean;
  verdict: string | null;
  counts: Record<Severity, number> | null;
  blocks: boolean | null;
  /** The severity re-entry gates on (highest present), or null. */
  highest: Severity | null;
}

export interface MarkerReading {
  code: 0 | 1 | 2 | 3;
  payload: MarkerPayload;
}

/**
 * The findings counts, or null when the marker is missing or unreadable.
 *
 * A count that is missing or not a non-negative integer makes the WHOLE marker
 * unreadable rather than zero: `{"blocking": "2"}` read as 0 is a blocking
 * finding silently forgiven. (In JS a boolean is not a number, so `true` is
 * already excluded — the Python guard against `bool` is implicit here.)
 */
function countsFrom(body: string): Record<Severity, number> | null {
  const m = FINDINGS_RE.exec(body);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const out = {} as Record<Severity, number>;
  for (const key of SEVERITIES) {
    const value = rec[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    out[key] = value;
  }
  return out;
}

/**
 * (exit code, payload) for one review body — the decision a caller acts on and
 * the detail it can log. Both signals (verdict + counts) are required to agree:
 * a verdict with no readable counts, or counts with no verdict, is half a review
 * and unreadable, not a lenient pass.
 */
export function readReviewMarkers(body: string): MarkerReading {
  const verdictMatch = VERDICT_RE.exec(body);
  const counts = countsFrom(body);

  if (verdictMatch === null && counts === null) {
    // Nothing of the arbiter's is in this body. Not unreadable — unrelated.
    return { code: 3, payload: { arbiter: false, verdict: null, counts: null, blocks: null, highest: null } };
  }
  if (verdictMatch === null) {
    return { code: 2, payload: { arbiter: true, verdict: null, counts, blocks: null, highest: null } };
  }
  if (counts === null) {
    return { code: 2, payload: { arbiter: true, verdict: verdictMatch[1].toLowerCase(), counts: null, blocks: null, highest: null } };
  }

  const verdict = verdictMatch[1].toLowerCase();
  // Either signal alone blocks; they must agree, so a disagreement means one is
  // wrong and neither may be trusted to be the lenient one.
  const blocks = verdict === 'request-changes' || counts.blocking > 0;
  const highest = SEVERITIES.find((name) => counts[name] > 0) ?? null;
  return { code: blocks ? 1 : 0, payload: { arbiter: true, verdict, counts, blocks, highest } };
}
