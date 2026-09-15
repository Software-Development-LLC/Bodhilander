/**
 * Gathering what `attend` decides from (CO-722, #287).
 *
 * `gate-attention.ts` is pure: it is handed a receipt reading, a session
 * status and a clock, and answers. This is the thin layer that fetches
 * those three things for a real gate -- the receipt file at the harness's
 * path, the daemon's word for the session, the time since the row opened --
 * and it exists as a module because the console's `watch` and the app's loop
 * must gather them identically or disagree about the same gate.
 *
 * Everything that touches the world is a dependency, so the gathering can be
 * asserted against a fake file and a fake daemon rather than a live one.
 */
import type { RunGateRow, RunRow } from '../repositories/runs';
import { attend, type Attention, type SessionStatus } from './gate-attention';
import { readReceipt, receiptPathFor } from './gate-receipt';
import type { CommandResult } from './reconcile';
import type { Gate } from './transitions';

export interface AttentionDeps {
  /** The file's text, or null when there is no file. */
  readFile(path: string): string | null;
  /** Run a command; `claude agents --json` is the only one asked for. */
  run(executable: string, argv: readonly string[]): Promise<CommandResult>;
  claudePath: string;
  now(): number;
  /** How long `busy` with no word may last before a person is asked. */
  busyCeilingMs: number;
}

/** What was seen, and what to do about it. */
export interface GateLook {
  gate: Gate;
  agent: string;
  attempt: number;
  receiptPath: string;
  receiptVerdict: string | null;
  status: SessionStatus | null;
  /** Why the status is unknown, when it is. */
  statusNote: string | null;
  /** Time since the row opened, or null when its start time does not parse. */
  runningForMs: number | null;
  attention: Attention;
}

/** SQLite's CURRENT_TIMESTAMP is UTC without a zone marker. Said so, once. */
export function startedAtIso(startedAt: string): string {
  return `${startedAt.replace(' ', 'T')}Z`;
}

/**
 * What the daemon says a background session is doing.
 *
 * Measured vocabulary: `busy` while working, `waiting` when wedged on a
 * prompt, `idle` once its turn is done; a stopped session is not listed and
 * reads as `gone`. Null when it cannot be known -- no id recorded, or the
 * CLI could not be asked -- and null is not gone: that is a verdict about
 * the gate, and must not be reached by failing to look.
 */
export async function sessionStatus(
  bgSessionId: string | null,
  deps: Pick<AttentionDeps, 'run' | 'claudePath'>,
): Promise<{ status: SessionStatus | null; note: string | null }> {
  if (!bgSessionId) return { status: null, note: null };
  const result = await deps.run(deps.claudePath, ['agents', '--json']);
  if (result.code !== 0) return { status: null, note: `claude agents exited ${result.code}; status unknown` };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const rows = Array.isArray(parsed) ? parsed : ((parsed as { agents?: unknown[] }).agents ?? []);
    const row = rows.find((r) => (r as { id?: string }).id === bgSessionId) as { status?: string } | undefined;
    if (!row) return { status: 'gone', note: null };
    const status = row.status;
    if (status === 'busy' || status === 'waiting' || status === 'idle') return { status, note: null };
    return { status: null, note: `the daemon reports status ${JSON.stringify(status)}, which this engine does not know` };
  } catch {
    return { status: null, note: 'claude agents returned something that is not JSON; status unknown' };
  }
}

/** Look at one gate in flight and decide what, if anything, its run should do. */
export async function lookAtGate(run: RunRow, gate: RunGateRow, deps: AttentionDeps): Promise<GateLook> {
  if (gate.gate !== 2 && gate.gate !== 3 && gate.gate !== 4) {
    throw new Error(`the open row is for gate ${gate.gate}, which this engine does not know`);
  }
  // run.initiativeDir is NOT NULL (schema) and a non-optional string (RunRow),
  // so it needs no fallback here; the console's old `?? ''` guarded a null
  // that cannot occur.
  const receiptPath = receiptPathFor(run.initiativeDir, gate.gate, gate.agent);
  const receipt = readReceipt(deps.readFile(receiptPath));
  const seen = await sessionStatus(gate.bgSessionId, deps);
  const startedMs = Date.parse(startedAtIso(gate.startedAt));
  // Half a clock is not a clock: an unreadable start time means the ceiling
  // cannot apply, and that is said rather than left as a NaN that quietly
  // never trips it.
  const runningForMs = Number.isNaN(startedMs) ? null : deps.now() - startedMs;
  const attention = attend({
    gate: gate.gate,
    agent: gate.agent,
    receipt,
    status: seen.status,
    backgroundId: gate.bgSessionId,
    startedAt: Number.isNaN(startedMs) ? null : startedAtIso(gate.startedAt),
    busyForMs: runningForMs,
    busyCeilingMs: deps.busyCeilingMs,
  });
  return {
    gate: gate.gate,
    agent: gate.agent,
    attempt: gate.attempt,
    receiptPath,
    receiptVerdict: receipt?.verdict ?? null,
    status: seen.status,
    statusNote: runningForMs === null
      ? [seen.note, `started_at is ${JSON.stringify(gate.startedAt)}, which does not parse; the busy ceiling cannot apply`].filter(Boolean).join('; ')
      : seen.note,
    runningForMs,
    attention,
  };
}
