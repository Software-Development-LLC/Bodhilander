/**
 * The first candidate with something in it, or null.
 *
 * Extracted because this exact mistake has now been made twice in this engine
 * and caught twice in review, which is the point at which a shared function
 * beats a shared intention.
 *
 * Neither operator is right on its own, and the two are wrong in opposite
 * directions:
 *
 * - `??` passes an empty string through. `.trim()` returns `''` rather than
 *   null, so a fallback written after one is unreachable and the field ships
 *   blank — which is how a refusal that promises to say what to do about a
 *   problem says nothing at all.
 * - `||` behaves correctly and reads as a defect to any linter that sees a
 *   nullable left operand (Sonar S6606), so it invites being "fixed" into the
 *   first case by somebody who was not here.
 *
 * A function says the intent once and cannot be talked out of it: **emptiness
 * disqualifies a candidate, not nullness.**
 */
export function firstText(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text) return text;
  }
  return null;
}
