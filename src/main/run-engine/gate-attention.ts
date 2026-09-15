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
 * - **the session's status**, from `claude agents`. A gate that is gone or
 *   idle without a receipt established nothing: it crashed, was killed, ran
 *   out of something, or finished and never signed off -- and none of those
 *   is a verdict.
 *
 * | receipt | status    | decision                                                   |
 * |---------|-----------|------------------------------------------------------------|
 * | yes     | any       | `gateFinished` with the receipt's verdict                  |
 * | no      | `busy`    | nothing -- the gate is thinking                            |
 * | no      | `waiting` | `permissionRequested` -- blocked on a prompt nobody can    |
 * |         |           | answer; a person's problem, named with the id to attach to |
 * | no      | `idle`    | `gateFinished` inconclusive -- finished its turn, no receipt |
 * | no      | `gone`    | `gateFinished` inconclusive -- crashed or killed, no receipt |
 * | no      | unknown   | nothing -- "gone" must not be reached by failing to look   |
 *
 * The status is the daemon's own, from `claude agents --json`, measured:
 * `waiting` for a session wedged on a permission prompt, `busy` while it
 * works, `idle` once its turn is done, and not listed at all once stopped.
 * That is what makes a deadline on ELAPSED time unnecessary for every case
 * but one -- `busy` that never ends -- and #292's point was exactly that
 * such a deadline could not tell a thinking gate from a stuck one. Now the
 * daemon tells us, and the only clock left to run is on silence in `busy`.
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
 * ## The one clock, and what it does
 *
 * `busy` with no receipt, forever. A gate genuinely thinking and a gate
 * looping look the same from outside until something bounds how long `busy`
 * may last without a word. The ceiling itself is a policy and lives beside
 * the other cadences in `reconcile-loop.ts`; this module only applies what
 * it is handed, and applies it as a question to a person -- `inconclusive`,
 * with the id to attach to -- never as a kill. The reviewer that #292 is
 * named for was killed mid-mutation-test by a clock that could not tell it
 * was working. This one cannot tell either, and says so.
 */
import type { ReceiptReading } from './gate-receipt';
import type { Gate, RunEvent } from './transitions';

/**
 * What the daemon says a session is doing. The four words are its, not ours.
 * `gone` is "not listed". Null means it could not be asked or the session was
 * never recorded -- and null is NOT gone.
 */
export type SessionStatus = 'busy' | 'waiting' | 'idle' | 'gone';

export interface GateFacts {
  gate: Gate;
  agent: string;
  /** What the receipt said, or null when there is no receipt file. */
  receipt: ReceiptReading | null;
  /**
   * When this gate's row was opened, ISO 8601, or null if unknown.
   *
   * A receipt written before it is a previous attempt's, sitting at the
   * same path, and is not evidence about this one. Measured: `watch` on a
   * fresh run found this morning's `3-reviewer.json` and launched gate 4 on
   * it.
   */
  startedAt?: string | null;
  /** The session's status, or null when it cannot be known. */
  status: SessionStatus | null;
  /** What `claude attach` takes, for the note when a person must step in. */
  backgroundId: string | null;
  /**
   * How long the gate has been running, and how long `busy` with no word may
   * last before a person is asked to look. Both optional and both needed for
   * the ceiling to apply: a caller that cannot say how long the gate has run
   * gets no verdict from a clock it did not wind.
   */
  busyForMs?: number | null;
  busyCeilingMs?: number | null;
}

export interface Attention {
  /** The event to apply, or null to leave the run where it is. */
  event: RunEvent | null;
  /** For the person reading the log. Present whenever `event` is. */
  note: string | null;
}

/**
 * A receipt older than the gate it would be evidence for, or null.
 *
 * Both timestamps are required: a receipt with no written_at, or a row with
 * no started_at, cannot be called stale and is taken at face value -- the
 * harness has always written written_at, so a receipt without one is
 * already something to look at rather than something to discard. Compared
 * as instants, not strings: SQLite's `YYYY-MM-DD HH:MM:SS` and the
 * receipt's ISO 8601 do not sort against each other as text.
 */
function staleReceipt(facts: GateFacts): { writtenAt: string; startedAt: string } | null {
  const writtenAt = facts.receipt?.writtenAt ?? null;
  const startedAt = facts.startedAt ?? null;
  if (!writtenAt || !startedAt) return null;
  const written = Date.parse(writtenAt);
  const started = Date.parse(startedAt);
  if (Number.isNaN(written) || Number.isNaN(started)) return null;
  return written < started ? { writtenAt, startedAt } : null;
}

/** What to do about a launched gate, given what can be seen of it. */
export function attend(facts: GateFacts): Attention {
  const who = `gate ${facts.gate} (${facts.agent})`;

  const stale = staleReceipt(facts);
  if (stale) {
    // Not this gate's. Decided from the status as though there were no
    // receipt, and said out loud, because a person looking at the directory
    // will see a receipt and wonder why the run did not move.
    const rest = attend({ ...facts, receipt: null });
    const note = `${who}: a receipt at this path was written ${stale.writtenAt}, before this attempt started ${stale.startedAt}; it is a previous attempt's and was not used`;
    return { event: rest.event, note: rest.note ? `${note}. ${rest.note}` : note };
  }

  if (facts.receipt) {
    const { verdict, reason } = facts.receipt;
    const why = reason ? `: ${reason}` : '';
    const still = facts.status === 'busy' ? '; the gate was still working when its receipt was read' : '';
    return {
      event: { kind: 'gateFinished', gate: facts.gate, verdict },
      note: `${who} wrote a receipt with verdict ${verdict}${why}${still}`,
    };
  }

  switch (facts.status) {
    case 'gone':
      // Not a fail -- the branch was never judged -- and not a pass, because
      // nothing said so. The one word that is true.
      return {
        event: { kind: 'gateFinished', gate: facts.gate, verdict: 'inconclusive' },
        note: `${who} is no longer running and wrote no receipt, so it established nothing`,
      };
    case 'idle':
      // Its turn ended and it never signed off. Distinct from gone in the
      // note, because the fix is different: a crash is the machine's, a
      // missing sign-off is the role's.
      return {
        event: { kind: 'gateFinished', gate: facts.gate, verdict: 'inconclusive' },
        note: `${who} finished its turn without writing a receipt, so it established nothing`,
      };
    case 'waiting': {
      // Blocked on a prompt nobody is attached to. With the hook channel a
      // background gate should never show this, so it also means something
      // bypassed the channel -- worth saying, and worth a person.
      const attach = facts.backgroundId ? ` -- \`claude attach ${facts.backgroundId}\` to see it` : '';
      return {
        event: { kind: 'permissionRequested' },
        note: `${who} is waiting on a prompt nobody is attached to${attach}`,
      };
    }
    case 'busy': {
      // Thinking, as far as can be told -- unless it has been thinking with
      // no word for longer than a thorough gate needs. That is the one clock
      // left, and it does not kill: the run goes to a person with the id to
      // attach to, and the gate keeps running for them to judge.
      const { busyForMs, busyCeilingMs } = facts;
      if (busyForMs != null && busyCeilingMs != null && busyForMs > busyCeilingMs) {
        const attach = facts.backgroundId ? ` -- \`claude attach ${facts.backgroundId}\` to see it` : '';
        return {
          event: { kind: 'gateFinished', gate: facts.gate, verdict: 'inconclusive' },
          note:
            `${who} has been busy for ${Math.round(busyForMs / 60_000)} minutes with no receipt, ` +
            `past the ${Math.round(busyCeilingMs / 60_000)}-minute ceiling; it is still running, and ` +
            `whether that is thought or a loop is a person's call${attach}`,
        };
      }
      return { event: null, note: null };
    }
    default:
      // Unknown. "Gone" must never be reached by failing to look.
      return { event: null, note: null };
  }
}
