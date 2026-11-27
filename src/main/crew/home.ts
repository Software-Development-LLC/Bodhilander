/**
 * Unlink this machine, and Make this machine home for a hire with none. The
 * Hub moves the lease on approval and refuses a move from anyone but the owner.
 */
import type Database from 'better-sqlite3';
import type { ClaudeAccount, CrewEditResult } from '../../shared/types';
import type { ClaudeAccountRef } from './account-ref';
import { writeAudit } from './audit';
import type { CardDecisionFrame, MovePayload } from './protocol';

export interface HomeDeps {
  db: Database.Database;
  machineId(): string | null;
  online(): boolean;
  resolve(ref: ClaudeAccountRef): ClaudeAccount | null;
  signedIn(account: ClaudeAccount): boolean;
  /** The raise id, or null when it could not be queued. */
  raiseMove(hireId: string, payload: MovePayload): string | null;
  sendUnlink(machineId: string): boolean;
  tellOwner(text: string): void;
}

const refuse = (error: string): CrewEditResult => ({ ok: false, error });

function hireBody(db: Database.Database, hireId: string): Record<string, unknown> | null {
  const row = db.prepare(`SELECT data FROM crew_hire_cache WHERE hire_id = ?`).get(hireId) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function refOf(body: Record<string, unknown>): ClaudeAccountRef | null {
  const ref = body.accountRef as Partial<ClaudeAccountRef> | undefined;
  if (!ref || typeof ref.label !== 'string') return null;
  return { accountUuid: ref.accountUuid ?? null, email: ref.email ?? null, label: ref.label };
}

export function movePayload(deps: HomeDeps, ref: ClaudeAccountRef): MovePayload {
  const account = deps.resolve(ref);
  if (!account) return { account: 'missing', accountLabel: ref.label };
  return { account: deps.signedIn(account) ? 'signed-in' : 'signed-out', accountLabel: account.label };
}

export function makeHomeHere(deps: HomeDeps, hireId: string): CrewEditResult {
  const mine = deps.machineId();
  if (!mine) return refuse("This machine isn't linked to Crew.");
  if (!deps.online()) return refuse('Crew is offline; try again once it reconnects.');
  const body = hireBody(deps.db, hireId);
  if (!body) return refuse('This hire has not synced to this machine yet.');
  if (typeof body.state !== 'string' || !body.state.startsWith('held:no-home')) return refuse('This hire already has a home machine.');
  if (body.homeMachineId === mine) return refuse('This machine is already its home.');
  const ref = refOf(body);
  if (!ref) return refuse("This hire's account can't be read.");
  const payload = movePayload(deps, ref);
  const raiseId = deps.raiseMove(hireId, payload);
  if (!raiseId) return refuse("The move couldn't be queued.");
  writeAudit(deps.db, hireId, 'move-raised', { raiseId, account: payload.account });
  return { ok: true };
}

export function isMoveRaisedHere(db: Database.Database, frame: CardDecisionFrame): boolean {
  return !!db
    .prepare(`SELECT 1 FROM crew_audit WHERE event = 'move-raised' AND hire_id = ? AND json_extract(detail, '$.raiseId') = ?`)
    .get(frame.hireId, frame.raiseId);
}

/** A move card raised here was decided. The lease and the queued messages follow from the Hub. */
export function moveDecided(deps: HomeDeps, frame: CardDecisionFrame): void {
  const body = hireBody(deps.db, frame.hireId) ?? {};
  const name = typeof body.name === 'string' ? body.name : 'This hire';
  if (frame.decision !== 'approved') {
    deps.tellOwner(`${name} stays without a home machine.`);
    return;
  }
  const ref = refOf(body);
  const found = ref ? movePayload(deps, ref) : null;
  if (found && found.account !== 'signed-in') {
    deps.tellOwner(`${name} is moving to this machine. Its Claude account ${found.accountLabel} isn't signed in here, so it will hold until it is.`);
    return;
  }
  deps.tellOwner(`${name} is moving to this machine. Its queued messages run here once the old machine has stopped.`);
}

export function unlinkHere(deps: HomeDeps): CrewEditResult {
  const mine = deps.machineId();
  if (!mine) return refuse("This machine isn't linked to Crew.");
  if (!deps.online()) return refuse('Crew is offline; unlinking needs the Hub.');
  if (!deps.sendUnlink(mine)) return refuse("The unlink couldn't be queued.");
  writeAudit(deps.db, null, 'unlink-requested', {});
  return { ok: true };
}
