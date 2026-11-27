/** Letting a hire go: the Hub applies it first, then this machine stops the hire and sets its folder aside. */
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log';
import type { CrewEditResult } from '../../shared/types';
import type { EditResultFrame } from './protocol';

export const LET_GO_KEEP_MS = 30 * 24 * 60 * 60_000;
export const LET_GO_ANSWER_MS = 30_000;
const STAMP = '.let-go-at';

export interface LetGoDeps {
  online(): boolean;
  sendDelete(hireId: string): string;
  editResult(id: string): Promise<EditResultFrame | null>;
  interrupt(hireId: string): void;
  moveAside(hireId: string): void;
}

export async function letGoHire(deps: LetGoDeps, hireId: string): Promise<CrewEditResult> {
  if (!deps.online()) return { ok: false, error: "Crew Hub isn't connected, so the hire can't be let go now." };
  let id: string;
  try {
    id = deps.sendDelete(hireId);
  } catch (err) {
    log.warn('[Crew] could not queue a let go', err);
    return { ok: false, error: "The let go couldn't be queued." };
  }
  const answer = await deps.editResult(id);
  if (!answer) return { ok: false, error: "Crew Hub didn't answer. Try again." };
  if (answer.result !== 'applied') return { ok: false, error: answer.why ?? 'Crew Hub refused the let go.' };
  deps.interrupt(hireId);
  try {
    deps.moveAside(hireId);
  } catch (err) {
    log.warn('[Crew] could not move a let-go hire folder aside', err);
  }
  return { ok: true };
}

const letGoRoot = (userData: string) => path.join(userData, 'crew', '.let-go');

export function moveHireAside(userData: string, hireId: string, now: number): void {
  const from = path.join(userData, 'crew', hireId);
  if (!fs.existsSync(from)) return;
  const to = path.join(letGoRoot(userData), hireId);
  fs.mkdirSync(letGoRoot(userData), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
  fs.writeFileSync(path.join(to, STAMP), String(now));
}

function stampOf(dir: string): number | null {
  try {
    const at = Number(fs.readFileSync(path.join(dir, STAMP), 'utf8'));
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

export function sweepLetGo(userData: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(letGoRoot(userData));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(letGoRoot(userData), name);
    try {
      const since = stampOf(dir) ?? fs.statSync(dir).ctimeMs;
      if (now - since >= LET_GO_KEEP_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn('[Crew] could not sweep a let-go folder', err);
    }
  }
}
