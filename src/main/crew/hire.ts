/**
 * Hiring from this machine: a role, a name, repos and a signed-in account,
 * checked here as the Hub checks them, then sent as a hire create. The Hub
 * homes the hire on this machine and it syncs back in `provisioning`.
 */
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import log from 'electron-log';
import type { ClaudeAccount, CrewHireResult } from '../../shared/types';
import type { ClaudeAccountRef } from './account-ref';
import type { EditResultFrame } from './protocol';
import type { EditInput } from './sync';

export const MAX_HIRE_NAME = 64;
export const MAX_HIRE_REPOS = 50;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const PRINTABLE = /^[^\p{Cc}\p{Cf}]+$/u;

export interface HireInput {
  name: unknown;
  roleId: unknown;
  repos: unknown;
  accountId: unknown;
}

export interface HireDeps {
  db: Database.Database;
  online(): boolean;
  accounts(): ClaudeAccount[];
  refFor(account: ClaudeAccount): ClaudeAccountRef;
  sendEdit(input: EditInput): string;
  editResult(id: string): Promise<EditResultFrame | null>;
  newId?(): string;
}

export type HireResult = CrewHireResult;

export const HIRE_ANSWER_MS = 30_000;

const refuse = (error: string): HireResult => ({ ok: false, error });

function knownRole(db: Database.Database, roleId: string): boolean {
  const row = db.prepare(`SELECT data FROM crew_role_cache WHERE role_id = ?`).get(roleId) as { data: string } | undefined;
  if (!row) return false;
  try {
    return !(JSON.parse(row.data) as { deleted?: boolean }).deleted;
  } catch {
    return false;
  }
}

/** The fields the Hub's hire create takes, or why this input cannot be one. */
export function hireFields(deps: Pick<HireDeps, 'db' | 'accounts' | 'refFor'>, input: HireInput): { fields: Record<string, unknown> } | { error: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MAX_HIRE_NAME || !PRINTABLE.test(name)) return { error: `A name is 1 to ${MAX_HIRE_NAME} printable characters.` };
  if (typeof input.roleId !== 'string' || !knownRole(deps.db, input.roleId)) return { error: 'Pick a role.' };
  const repos = Array.isArray(input.repos) ? [...new Set(input.repos.map((r) => (typeof r === 'string' ? r.trim() : '')))] : null;
  if (!repos || repos.length > MAX_HIRE_REPOS || !repos.every((r) => REPO.test(r))) return { error: `Repos are up to ${MAX_HIRE_REPOS} owner/name repositories.` };
  const account = deps.accounts().find((a) => a.id === input.accountId);
  if (!account) return { error: 'Pick the Claude account this hire runs on.' };
  const ref = deps.refFor(account);
  if (!ref.accountUuid || !ref.email) return { error: `${account.label} hasn't signed in on this machine, so Crew can't name it. Sign in first.` };
  return { fields: { name, roleId: input.roleId, repos, accountRef: { accountUuid: ref.accountUuid, email: ref.email, label: ref.label } } };
}

export async function createHire(deps: HireDeps, input: HireInput): Promise<HireResult> {
  if (!deps.online()) return refuse("Crew Hub isn't connected, so the hire can't be made now.");
  const checked = hireFields(deps, input);
  if ('error' in checked) return refuse(checked.error);
  const hireId = (deps.newId ?? randomUUID)();
  let id: string;
  try {
    id = deps.sendEdit({ op: 'create', kind: 'hire', objectId: hireId, fields: checked.fields });
  } catch (err) {
    log.warn('[Crew] could not queue a hire', err);
    return refuse("The hire couldn't be queued.");
  }
  const answer = await deps.editResult(id);
  if (!answer) return { ok: false, hireId, error: "Crew Hub hasn't answered yet. If it makes the hire, it shows up here as provisioning." };
  if (answer.result !== 'applied') return refuse(answer.why ?? 'Crew Hub refused the hire.');
  return { ok: true, hireId };
}
