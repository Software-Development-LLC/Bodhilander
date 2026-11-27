/**
 * Sessions per thread, ported from Office: when a thread starts fresh, and the
 * input that carries its last turns into the new session.
 */
import { capDay } from '../holds';

export const CONTEXT_LIMIT_TOKENS = 120_000;

const LOST = /No conversation found/i;
const CLIP = 600;
const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP - 1)}…` : s);

export interface Turn {
  input: string | null;
  reply: string | null;
}

export interface ThreadState {
  sessionId: string | null;
  contextTokens: number | null;
  /** Epoch ms of the thread's last run, or null. */
  lastRunAt: number | null;
  tainted: boolean;
  /** The session was made on another machine. */
  moved: boolean;
}

export type FreshReason = 'size' | 'new-day' | 'moved' | 'tainted';

/** `--resume` failed because the session is not in this account. */
export function sessionLost(stderr: string): boolean {
  return LOST.test(stderr);
}

export function freshReason(thread: ThreadState, now: number, timeZone: string | null): FreshReason | null {
  if (!thread.sessionId) return null;
  if (thread.tainted) return 'tainted';
  if (thread.moved) return 'moved';
  if ((thread.contextTokens ?? 0) > CONTEXT_LIMIT_TOKENS) return 'size';
  if (thread.lastRunAt !== null && capDay(thread.lastRunAt, timeZone) !== capDay(now, timeZone)) return 'new-day';
  return null;
}

const turnLines = (turns: Turn[]) =>
  turns.slice(-4).flatMap((t) => [...(t.input ? [`Message: ${clip(t.input)}`] : []), ...(t.reply ? [`You replied: ${clip(t.reply)}`] : [])]);

const WHY: Record<FreshReason, string> = {
  size: 'This thread grew long, so this is a fresh session on it.',
  'new-day': 'A new day, so this is a fresh session on this thread.',
  moved: 'This assistant moved to another machine, so this is a fresh session on this thread.',
  tainted: 'The last run read untrusted content, so this is a fresh session on this thread.',
};

export function freshSessionInput(reason: FreshReason, turns: Turn[], input: string): string {
  const lines = turnLines(turns);
  return [
    WHY[reason],
    'Your notes and skills are current. Anything you believed earlier in this thread may be stale: re-check a fact before repeating it.',
    ...(lines.length ? ['', 'The last turns were:', '', ...lines] : []),
    '',
    'The new message:',
    '',
    input,
  ].join('\n');
}

export function lostSessionInput(turns: Turn[], input: string): string {
  const lines = turnLines(turns);
  if (lines.length === 0) return input;
  return ['Your earlier session on this thread could not be found, so this is a fresh one. The last turns were:', '', ...lines, '', 'The new message:', '', input].join('\n');
}
