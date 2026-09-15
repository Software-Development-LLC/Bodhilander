/**
 * Reading what a background gate concluded (CO-722, #287).
 *
 * A print gate hands its verdict back as structured output; a `--bg` gate
 * cannot -- `--bg` and `--print` conflict -- so its verdict is a FILE the
 * harness's `gate-receipt.sh` writes at the end of the gate's work:
 *
 *   <initiative>/gates/<gate>-<agent>.json
 *
 * Until this module, nothing read it. A background gate that finished left
 * the engine saying `gate 2 running` indefinitely, which is the pain this
 * engine exists to remove, reproduced by the thing built to remove it.
 *
 * ## Two vocabularies, mapped and never coerced
 *
 * The receipt schema (`gate_receipt.schema.json`, additionalProperties false)
 * says `verdict` is one of `pass | fail | undriveable | skip` -- the plugin's
 * exit-code vocabulary. The machine's is `pass | fail | inconclusive`. They
 * agree on the two that move a run and differ on the rest, and the rest all
 * mean the same thing to the machine: nothing was established. So
 * `undriveable` and `skip` become `inconclusive`, each with a reason naming
 * the word the receipt used, because whoever reads the note should know
 * whether the gate could not run or had nothing to do.
 *
 * ## The same strictness as a structured verdict
 *
 * A malformed receipt is inconclusive, never a pass. A pass carrying blocking
 * findings is two answers that disagree, and neither half is trusted. A fail
 * without findings stays a fail: the gate said no, and the absence of a list
 * is a gap in the report, not a reversal of the verdict. These are the rules
 * `gate-verdict.ts` applies to structured output, held here for the same
 * reasons -- a receipt is the same claim arriving by a different door.
 *
 * ## No receipt is not a bad receipt
 *
 * `readReceipt(null)` is `null`: the gate has not written one yet, which is
 * the normal state of a gate that is still working. It is distinct from a
 * file that exists and cannot be read, which is a gate that tried to answer
 * and failed to. The caller decides what silence means -- see
 * `gate-attention.ts` -- and this module must not decide it for them by
 * returning a verdict for a file that is not there.
 */
import type { Gate, GateVerdict } from './transitions';

export interface ReceiptReading {
  verdict: GateVerdict;
  /** The receipt's own blocking findings, by summary. Empty on a pass. */
  blocking: string[];
  /** Why the verdict is what it is, when it is not simply what the gate said. */
  reason?: string;
  /**
   * When the receipt says it was written, ISO 8601, or null if it does not.
   *
   * Load-bearing, not decorative: the receipt path is per initiative and per
   * role, with no run or attempt in it, so a receipt from an earlier attempt
   * sits exactly where this attempt's would. The caller compares this to
   * when the gate row was opened -- see `gate-attention.ts`.
   */
  writtenAt: string | null;
}

/** The receipt vocabulary, as the schema spells it. */
const RECEIPT_VERDICTS = new Set(['pass', 'fail', 'undriveable', 'skip']);

/**
 * Where a gate's receipt lives. The harness decides this; we only agree.
 *
 * `gate-receipt.sh` writes `gates/<gate>-<agent>.json` under the initiative
 * directory, keyed by gate AND agent because gate 4 is two agents and each
 * writes its own.
 */
export function receiptPathFor(initiativePath: string, gate: Gate, agent: string): string {
  return `${initiativePath}/gates/${gate}-${agent}.json`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function inconclusive(reason: string, writtenAt: string | null = null): ReceiptReading {
  return { verdict: 'inconclusive', blocking: [], reason, writtenAt };
}

/** Summaries of the blocking findings, tolerating a list that is not one. */
function blockingSummaries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const summary = record && typeof record.summary === 'string' ? record.summary.trim() : '';
    if (summary) out.push(summary);
  }
  return out;
}

/**
 * What a receipt file says, or null when there is no file.
 *
 * Takes the text rather than the path, so every case below is an assertion
 * rather than a fixture on disk.
 */
export function readReceipt(text: string | null): ReceiptReading | null {
  if (text === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return inconclusive('the gate receipt is not JSON');
  }
  const receipt = asRecord(parsed);
  if (!receipt) return inconclusive('the gate receipt is not an object');

  const present = 'verdict' in receipt && receipt.verdict !== null && receipt.verdict !== undefined;
  const raw = typeof receipt.verdict === 'string' ? receipt.verdict.trim().toLowerCase() : '';
  if (!RECEIPT_VERDICTS.has(raw)) {
    if (raw) return inconclusive(`the receipt says "${raw}", which is not one of pass, fail, undriveable or skip`);
    if (!present) return inconclusive('the receipt carries no verdict');
    return inconclusive(
      typeof receipt.verdict === 'string'
        ? 'the receipt carries an empty verdict'
        : `the receipt's verdict was ${typeof receipt.verdict}, not a word`,
    );
  }

  const blocking = blockingSummaries(receipt.blocking_findings);
  const writtenAt = typeof receipt.written_at === 'string' && receipt.written_at.trim() ? receipt.written_at.trim() : null;

  if (raw === 'undriveable') {
    return inconclusive('the gate reported it could not be driven here -- nothing was established', writtenAt);
  }
  if (raw === 'skip') {
    return inconclusive('the gate reported nothing was owed -- nothing was established', writtenAt);
  }
  if (raw === 'pass' && blocking.length > 0) {
    return {
      verdict: 'inconclusive',
      blocking,
      reason:
        `the gate passed while reporting ${blocking.length} blocking finding(s), so it ` +
        'gave two answers that disagree',
      writtenAt,
    };
  }
  if (raw === 'fail') {
    return blocking.length > 0
      ? { verdict: 'fail', blocking, writtenAt }
      : { verdict: 'fail', blocking, reason: 'the gate failed without listing a blocking finding', writtenAt };
  }
  return { verdict: 'pass', blocking: [], writtenAt };
}
