/**
 * The owner's routine edits: create, update and delete, each sent as an edit
 * at the routine's cached rev and answered by the Hub. Only the owner's own
 * machine sends them; a run never does.
 */
import type { CrewEditResult, CrewRoutineInput } from '../../shared/types';
import { parseCron } from './schedule/cron';
import { isZone } from './schedule/zoned';
import type { EditInput } from './sync';

export const ROUTINE_PROMPT_MAX = 20_000;

export type RoutineEditOutcome = { ok: true; objectId?: string } | { ok: false; why: string };

export interface RoutineEditDeps {
  online(): boolean;
  /** The hire a cached routine belongs to, or null when it is not cached. */
  routineHire(routineId: string): string | null;
  edit(input: Omit<EditInput, 'id'>): Promise<RoutineEditOutcome>;
}

export type RoutineRequest = { op: 'create'; hireId: string; input: unknown } | { op: 'update'; hireId: string; routineId: string; input: unknown } | { op: 'delete'; hireId: string; routineId: string };

/** The fields as the Hub takes them, or what is wrong with them. */
export function routineFields(input: unknown): CrewRoutineInput | string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const cron = typeof o.cron === 'string' ? o.cron.trim().replace(/\s+/g, ' ') : '';
  const timezone = typeof o.timezone === 'string' ? o.timezone.trim() : '';
  const prompt = typeof o.prompt === 'string' ? o.prompt : '';
  try {
    if (cron.split(' ').length !== 5) throw new Error('fields');
    parseCron(cron);
  } catch {
    return 'The schedule is five cron fields, for example 0 8 * * 1-5 for 8:00 on weekdays.';
  }
  if (!timezone || !isZone(timezone)) return 'Choose a time zone, for example America/Chicago.';
  if (!prompt.trim() || prompt.length > ROUTINE_PROMPT_MAX) return `The prompt is 1 to ${ROUTINE_PROMPT_MAX} characters.`;
  return { cron, timezone, prompt };
}

function answerText(why: string): string {
  if (why.startsWith('conflict')) return 'This routine changed somewhere else since it was shown. It has been refreshed; make the change again.';
  if (why === 'no answer from Crew') return "Crew didn't answer. The change may still apply; check again shortly.";
  return `Crew refused the routine (${why}).`;
}

export async function editRoutine(deps: RoutineEditDeps, req: RoutineRequest): Promise<CrewEditResult> {
  if (!deps.online()) return { ok: false, error: 'Crew is offline; try again once it reconnects.' };
  if (req.op !== 'create' && deps.routineHire(req.routineId) !== req.hireId) return { ok: false, error: 'That routine is not on this machine.' };
  let edit: Omit<EditInput, 'id'>;
  if (req.op === 'delete') {
    edit = { op: 'delete', kind: 'routine', objectId: req.routineId, hireId: req.hireId, fields: {} };
  } else {
    const fields = routineFields(req.input);
    if (typeof fields === 'string') return { ok: false, error: fields };
    const sent: Record<string, unknown> = { ...fields };
    edit = req.op === 'create' ? { op: 'create', kind: 'routine', hireId: req.hireId, fields: sent } : { op: 'update', kind: 'routine', objectId: req.routineId, hireId: req.hireId, fields: sent };
  }
  const outcome = await deps.edit(edit);
  return outcome.ok ? { ok: true } : { ok: false, error: answerText(outcome.why) };
}
