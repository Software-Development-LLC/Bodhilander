/**
 * The shape of a gate's answer, and how to read one (CO-722).
 *
 * This is the one piece of domain the engine is allowed to own, and the
 * design says why: the shape of a verdict IS the transition contract, and
 * nothing else consumes it. The judgment stays in the plugin's agents, the
 * deterministic checks stay in its Python; what comes back has to be a shape
 * this side can act on.
 *
 * The reading rule is one sentence and it is the whole module: **a missing or
 * malformed verdict is inconclusive, never a pass.** Everything below is that
 * rule applied to the ways a verdict can be absent while looking present.
 *
 * `gate-process` already refuses to call a run successful without
 * `structured_output` — measured, because `--agent` and `--json-schema`
 * together return `subtype: success` with no structured output at all. This
 * is the layer after: the object exists, and the question is whether it says
 * anything.
 */
import type { GateVerdict } from './transitions';

/**
 * The JSON Schema a reading gate is given.
 *
 * Deliberately small. Every field here is one the state machine acts on, and
 * a field nothing acts on is a field an agent spends tokens filling in.
 *
 * `verdict` is an enum rather than a boolean because `inconclusive` has to be
 * sayable BY the agent. A reviewer that cannot establish something needs a
 * way to say so that is not "fail" — otherwise the only honest answer
 * available to it is the one that sends an owner back to fix working code.
 */
export const GATE_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'fail', 'inconclusive'],
      description:
        'pass: the work meets the bar. fail: it does not, and the owner must change it. '
        + 'inconclusive: you could not establish an answer — say this rather than guessing.',
    },
    summary: {
      type: 'string',
      maxLength: 2000,
      description: 'One paragraph a person can act on without opening anything else.',
    },
    blocking: {
      type: 'array',
      maxItems: 50,
      description: 'Findings that must be fixed before this can proceed. Empty for a pass.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what'],
        properties: {
          what: { type: 'string', maxLength: 500 },
          where: { type: 'string', maxLength: 300 },
        },
      },
    },
  },
} as const;

export interface GateReading {
  verdict: GateVerdict;
  summary: string;
  blocking: { what: string; where?: string }[];
  /** Why it was read as inconclusive, when it was not the agent's own word. */
  reason?: string;
}

const VERDICTS = new Set(['pass', 'fail', 'inconclusive']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readBlocking(value: unknown): { what: string; where?: string }[] {
  if (!Array.isArray(value)) return [];
  const findings: { what: string; where?: string }[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const what = typeof record?.what === 'string' ? record.what.trim() : '';
    if (!what) continue;
    const where = typeof record?.where === 'string' ? record.where.trim() : '';
    findings.push(where ? { what, where } : { what });
  }
  return findings;
}

function inconclusive(reason: string): GateReading {
  return { verdict: 'inconclusive', summary: '', blocking: [], reason };
}

/**
 * What a gate's structured output says.
 *
 * Never throws and never returns `pass` on anything it had to guess about.
 * The three ways a verdict can be absent while looking present each get their
 * own answer here, because each has been seen somewhere:
 *
 * - **nothing at all** — the schema run that succeeded and returned no object;
 * - **a verdict outside the enum** — a model writing `approved` or
 *   `changes_requested`, the words it uses everywhere else;
 * - **`pass` beside blocking findings** — the answer that contradicts itself,
 *   and the one where believing the convenient half is most tempting.
 */
export function readGateVerdict(structuredOutput: unknown): GateReading {
  const output = asRecord(structuredOutput);
  if (!output) {
    return inconclusive('the gate returned no verdict object');
  }

  const raw = typeof output.verdict === 'string' ? output.verdict.trim().toLowerCase() : '';
  if (!VERDICTS.has(raw)) {
    // Not coerced. `approved` is a word a model reaches for naturally, and
    // mapping it to `pass` here would mean accepting a verdict the schema
    // rejected — the schema's job is to make this case impossible, and its
    // presence means something upstream did not hold.
    return inconclusive(
      raw
        ? `the gate answered "${raw}", which is not one of pass, fail or inconclusive`
        : 'the gate returned no verdict field',
    );
  }

  const summary = typeof output.summary === 'string' ? output.summary.trim() : '';
  const blocking = readBlocking(output.blocking);

  if (raw === 'pass' && blocking.length > 0) {
    // A pass carrying blocking findings is two answers, and they disagree.
    // Reading the verdict alone advances past findings the gate itself called
    // blocking; reading the findings alone calls it a failure the gate did
    // not declare. Neither half can be trusted to be the honest one.
    return {
      verdict: 'inconclusive',
      summary,
      blocking,
      reason: `the gate passed while reporting ${blocking.length} blocking finding(s), so it `
        + 'contradicted itself',
    };
  }

  if (raw === 'fail' && blocking.length === 0) {
    // The mirror case, and it stays a FAIL rather than becoming inconclusive:
    // the gate said the work does not meet the bar, which is an answer. What
    // is missing is the detail, and an owner sent back with a summary and no
    // list is worse served than one not sent back at all — so it is recorded,
    // not upgraded.
    return {
      verdict: 'fail',
      summary,
      blocking,
      reason: 'the gate failed without listing a blocking finding',
    };
  }

  return { verdict: raw as GateVerdict, summary, blocking };
}
