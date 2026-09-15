/**
 * Looking at a launched gate again (CO-722, #287).
 *
 * `launched` was designed as an outcome distinct from `completed`, and that
 * was right: a `--bg` gate reports later, by receipt. What was missing was
 * the other half -- something that asks, later, what became of it. Without
 * this, the first real run's gate finished, its process exited, and the
 * engine said `gate 2 running` for as long as anyone cared to look.
 *
 * ## What this decides, and from what
 *
 * Two facts, both gathered by the caller because gathering is plumbing:
 *
 * - **the receipt**, read by `gate-receipt.ts`. Present means the gate
 *   concluded something; its verdict is the gate's.
 * - **whether the session is still alive**, from `claude agents`. A gate
 *   that is gone without a receipt established nothing: it crashed, was
 *   killed, or ran out of something, and none of those is a verdict.
 *
 * | receipt | alive | decision                                              |
 * |---------|-------|-------------------------------------------------------|
 * | yes     | any   | `gateFinished` with the receipt's verdict             |
 * | no      | yes   | nothing -- the gate is working                        |
 * | no      | no    | `gateFinished` inconclusive -- gone without a receipt |
 *
 * ## A receipt is taken even while the gate is alive
 *
 * The harness says a gate writes its receipt at the end of its work, and the
 * verdict in it is the gate's considered answer. A gate still alive after
 * writing one is finishing up -- today's scribe made one more read after its
 * receipt -- and holding the run for that would be the engine deciding the
 * gate had not really meant it. The note says the gate was still alive, so
 * anyone reading the log knows the run moved before the process ended.
 *
 * ## What this does NOT decide yet
 *
 * A gate that is alive and silent -- no receipt, no progress -- is
 * indistinguishable from one that is thinking, by these two facts alone.
 * Telling them apart needs a progress signal and a deadline on SILENCE rather
 * than on elapsed time (#292). That is the next slice; this one ends the
 * case where the answer is already on disk and nobody is reading it.
 */
import type { ReceiptReading } from './gate-receipt';
import type { Gate, RunEvent } from './transitions';

export interface GateFacts {
  gate: Gate;
  agent: string;
  /** What the receipt said, or null when there is no receipt file. */
  receipt: ReceiptReading | null;
  /** Whether the gate's session is still running. */
  alive: boolean;
}

export interface Attention {
  /** The event to apply, or null to leave the run where it is. */
  event: RunEvent | null;
  /** For the person reading the log. Present whenever `event` is. */
  note: string | null;
}

/** What to do about a launched gate, given what can be seen of it. */
export function attend(facts: GateFacts): Attention {
  const who = `gate ${facts.gate} (${facts.agent})`;

  if (facts.receipt) {
    const { verdict, reason } = facts.receipt;
    const why = reason ? `: ${reason}` : '';
    const still = facts.alive ? '; the gate was still running when its receipt was read' : '';
    return {
      event: { kind: 'gateFinished', gate: facts.gate, verdict },
      note: `${who} wrote a receipt with verdict ${verdict}${why}${still}`,
    };
  }

  if (!facts.alive) {
    // Gone without a receipt. Not a fail -- the branch was never judged --
    // and not a pass, because nothing said so. The one word that is true.
    return {
      event: { kind: 'gateFinished', gate: facts.gate, verdict: 'inconclusive' },
      note: `${who} is no longer running and wrote no receipt, so it established nothing`,
    };
  }

  return { event: null, note: null };
}
