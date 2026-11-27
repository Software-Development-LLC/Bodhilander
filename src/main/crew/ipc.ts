/**
 * Crew's channels to the renderer. Reads come from the local store; the one
 * Hub read, the hire's 7-day tokens, goes through the main process, and a
 * read that fails is reported as such, never as zero.
 */
import type Database from 'better-sqlite3';
import log from 'electron-log';
import type {
  ClaudeAccount,
  CrewCardList,
  CrewEditResult,
  CrewHireActivity,
  CrewHireAccount,
  CrewHireDetail,
  CrewHireInput,
  CrewHireResult,
  CrewHireSummary,
  CrewHireUsage,
  CrewLinkView,
  CrewRole,
  CrewRoutine,
  CrewStatus,
} from '../../shared/types';
import type { ClaudeAccountRef } from './account-ref';
import type { HubStatus } from './hub-client';
import type { LinkResult, LinkView } from './hub-link';
import type { UsageFrame } from './protocol';

export const USAGE_WINDOW_MS = 7 * 24 * 3_600_000;

/** A client that never started because this machine holds no machine id sits at `idle`; that is unlinked. */
export function crewStatusFrom(status: HubStatus | null, owner: CrewStatus['owner'], linked = true): CrewStatus {
  if (status === null || !linked) return { availability: 'unlinked', owner: null };
  if (status === 'idle') return { availability: 'connecting', owner };
  return { availability: status, owner };
}

function linkStopMessage(result: LinkResult): string {
  switch (result.kind) {
    case 'rate-limited':
      return result.retryAfterSeconds ? `Too many tries. Try again in ${result.retryAfterSeconds} seconds.` : 'Too many tries. Try again shortly.';
    case 'cannot-link':
      return `Crew couldn't link this machine (${result.error}).`;
    case 'unreachable':
    case 'failed':
    case 'unreadable':
      return "Crew isn't available right now. Try linking again later.";
    default:
      return "Crew couldn't link this machine.";
  }
}

export function linkViewFrom(view: LinkView): CrewLinkView {
  return view.step === 'stopped' ? { step: 'stopped', message: linkStopMessage(view.result) } : view;
}

export const KEYCHAIN_NEEDED: CrewLinkView = { step: 'stopped', message: 'Crew needs the system keychain.' };

const afterColon = (state: string): string | null => {
  const i = state.indexOf(':');
  return i < 0 ? null : state.slice(i + 1);
};

export function activityFor(
  state: string,
  homeMachineId: string | null,
  machineId: string | null,
  running: boolean,
): { activity: CrewHireActivity; cause: string | null } {
  if (state === 'let_go') return { activity: 'let-go', cause: null };
  if (state.startsWith('provisioning')) return { activity: 'provisioning', cause: afterColon(state) };
  if (state.startsWith('paused:')) return { activity: 'paused', cause: afterColon(state) };
  if (state.startsWith('held:')) return { activity: 'held', cause: afterColon(state) };
  if (running) return { activity: 'running', cause: null };
  if (homeMachineId && homeMachineId !== machineId) return { activity: 'elsewhere', cause: null };
  return { activity: 'idle', cause: null };
}

type ResolveAccount = (ref: ClaudeAccountRef) => ClaudeAccount | null;

interface HireRow {
  hire_id: string;
  home_machine_id: string | null;
  data: string;
}

type Body = Record<string, unknown>;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

function parse(data: string): Body | null {
  try {
    const body = JSON.parse(data) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Body) : null;
  } catch {
    return null;
  }
}

function accountRefOf(body: Body): ClaudeAccountRef | null {
  const ref = body.accountRef as Partial<ClaudeAccountRef> | undefined;
  if (!ref || typeof ref.label !== 'string') return null;
  return { accountUuid: ref.accountUuid ?? null, email: ref.email ?? null, label: ref.label };
}

function runningHires(db: Database.Database): Set<string> {
  const rows = db.prepare(`SELECT DISTINCT hire_id FROM crew_job WHERE state = 'running'`).all() as { hire_id: string }[];
  return new Set(rows.map((r) => r.hire_id));
}

function summaryOf(
  row: HireRow,
  body: Body,
  machineId: string | null,
  running: Set<string>,
  resolveAccount: ResolveAccount,
): { summary: CrewHireSummary; account: ClaudeAccount | null; ref: ClaudeAccountRef | null } {
  const state = str(body.state, 'active');
  const home = typeof body.homeMachineId === 'string' ? body.homeMachineId : row.home_machine_id;
  const ref = accountRefOf(body);
  const account = ref ? resolveAccount(ref) : null;
  const summary: CrewHireSummary = {
    hireId: row.hire_id,
    name: str(body.name, row.hire_id),
    roleId: str(body.roleId),
    state,
    ...activityFor(state, home, machineId, running.has(row.hire_id)),
    accountLabel: account?.label ?? ref?.label ?? null,
  };
  return { summary, account, ref };
}

/** Rows with rev 0 hold only the epoch fence; the Hub has not sent the hire yet. */
function hireRows(db: Database.Database, hireId?: string): HireRow[] {
  const sql = `SELECT hire_id, home_machine_id, data FROM crew_hire_cache WHERE rev > 0${hireId === undefined ? '' : ' AND hire_id = ?'}`;
  const stmt = db.prepare(sql);
  return (hireId === undefined ? stmt.all() : stmt.all(hireId)) as HireRow[];
}

export function readHires(db: Database.Database, machineId: string | null, resolveAccount: ResolveAccount): CrewHireSummary[] {
  const running = runningHires(db);
  const hires: CrewHireSummary[] = [];
  for (const row of hireRows(db)) {
    const body = parse(row.data);
    if (!body) continue;
    hires.push(summaryOf(row, body, machineId, running, resolveAccount).summary);
  }
  return hires.sort((a, b) => a.name.localeCompare(b.name));
}

function routinesOf(db: Database.Database, hireId: string): CrewRoutine[] {
  const rows = db.prepare(`SELECT routine_id, data FROM crew_routine_cache WHERE hire_id = ? ORDER BY routine_id`).all(hireId) as {
    routine_id: string;
    data: string;
  }[];
  return rows.flatMap((row) => {
    const body = parse(row.data);
    if (!body) return [];
    return [
      {
        routineId: row.routine_id,
        cron: str(body.cron),
        timezone: str(body.timezone),
        prompt: str(body.prompt),
        lastFired: typeof body.lastFired === 'number' ? body.lastFired : null,
      },
    ];
  });
}

export function readHire(db: Database.Database, hireId: string, machineId: string | null, resolveAccount: ResolveAccount): CrewHireDetail | null {
  const row = hireRows(db, hireId)[0];
  const body = row ? parse(row.data) : null;
  if (!row || !body) return null;
  const { summary, account, ref } = summaryOf(row, body, machineId, runningHires(db), resolveAccount);
  const repos = Array.isArray(body.repos) ? body.repos.filter((r): r is string => typeof r === 'string') : [];
  return {
    ...summary,
    repos,
    routines: routinesOf(db, hireId),
    dailyTokenCap: typeof body.dailyTokenCap === 'number' ? body.dailyTokenCap : null,
    skillBundleId: str(body.skillBundleId),
    skillBundleHash: str(body.skillBundleHash),
    accountId: account?.id ?? null,
    accountEmail: ref?.email ?? null,
  };
}

export function readRoles(db: Database.Database): CrewRole[] {
  const rows = db.prepare(`SELECT role_id, data FROM crew_role_cache`).all() as { role_id: string; data: string }[];
  return rows
    .flatMap((row) => {
      const body = parse(row.data);
      if (!body || body.deleted) return [];
      return [{ roleId: row.role_id, name: str(body.role, row.role_id) }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface UsageReadPort {
  online(): boolean;
  epochOf(hireId: string): number | null;
  /** Resolves with the Hub's `usage` answer, or null when none came. */
  usageRead(hireId: string, epoch: number, since: number): Promise<UsageFrame | null>;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export async function readHireUsage(port: UsageReadPort, hireId: string, now: number): Promise<CrewHireUsage> {
  if (!port.online()) return { available: false, reason: 'offline' };
  const epoch = port.epochOf(hireId);
  if (epoch === null) return { available: false, reason: 'failed' };
  let frame: UsageFrame | null;
  try {
    frame = await port.usageRead(hireId, epoch, now - USAGE_WINDOW_MS);
  } catch (err) {
    log.warn('[Crew] the usage read failed', err);
    return { available: false, reason: 'failed' };
  }
  if (frame === null) return { available: false, reason: 'unreachable' };
  const counts = [frame.inputTokens, frame.outputTokens, frame.cacheCreationTokens, frame.records];
  if (frame.hireId !== hireId || !isCount(frame.since) || !counts.every(isCount)) return { available: false, reason: 'failed' };
  return {
    available: true,
    since: frame.since,
    inputTokens: frame.inputTokens,
    outputTokens: frame.outputTokens,
    cacheCreationTokens: frame.cacheCreationTokens,
    records: frame.records,
  };
}

export interface CrewIpcDeps extends UsageReadPort {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
  db(): Database.Database;
  machineId(): string | null;
  resolveAccount: ResolveAccount;
  accounts(): ClaudeAccount[];
  status(): CrewStatus;
  /** Queue an edit of the hire's own fields against its cached rev. False when it could not be queued. */
  sendHireEdit(hireId: string, fields: Record<string, unknown>): boolean;
  changeAccount(hireId: string, accountId: string): CrewEditResult;
  cards(): CrewCardList;
  openCard(raiseId: string): boolean;
  letGo(hireId: string): Promise<CrewEditResult>;
  createHire(input: CrewHireInput): Promise<CrewHireResult>;
  hireAccounts(): CrewHireAccount[];
  beginLink(): Promise<CrewLinkView>;
  confirmLinkOwner(isMe: boolean): boolean;
  now(): number;
}

const refuse = (error: string): CrewEditResult => ({ ok: false, error });

export function registerCrewIpc(deps: CrewIpcDeps): void {
  const known = (hireId: unknown): hireId is string => typeof hireId === 'string' && hireRows(deps.db(), hireId).length > 0;
  const edit = (hireId: string, fields: Record<string, unknown>): CrewEditResult =>
    deps.sendHireEdit(hireId, fields) ? { ok: true } : refuse("The change couldn't be queued.");

  deps.handle('crew:getStatus', () => deps.status());
  deps.handle('crew:listHires', () => readHires(deps.db(), deps.machineId(), deps.resolveAccount));
  deps.handle('crew:getHire', (hireId) => (typeof hireId === 'string' ? readHire(deps.db(), hireId, deps.machineId(), deps.resolveAccount) : null));
  deps.handle('crew:getHireUsage', (hireId) =>
    typeof hireId === 'string' ? readHireUsage(deps, hireId, deps.now()) : Promise.resolve({ available: false, reason: 'failed' }),
  );

  deps.handle('crew:setDailyCap', (hireId, cap) => {
    if (!known(hireId)) return refuse('This hire has not synced to this machine yet.');
    if (cap !== null && !(typeof cap === 'number' && Number.isInteger(cap) && cap > 0)) return refuse('A daily cap is a whole number of tokens above 0.');
    return edit(hireId, { dailyTokenCap: cap });
  });

  deps.handle('crew:setRepos', (hireId, repos) => {
    if (!known(hireId)) return refuse('This hire has not synced to this machine yet.');
    if (!Array.isArray(repos) || !repos.every((r) => typeof r === 'string' && r.trim() !== '')) return refuse('Each repo needs a name.');
    const synced = parse(hireRows(deps.db(), hireId)[0].data)?.repos;
    const current = new Set((Array.isArray(synced) ? synced : []).filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase()));
    const seen = new Set<string>();
    const wanted = repos.map((r: string) => r.trim()).filter((r) => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
    if (wanted.some((r) => !current.has(r.toLowerCase()))) return refuse('Adding a repo needs a grant card, which comes in a later phase. You can remove repos now.');
    return edit(hireId, { repos: wanted });
  });

  deps.handle('crew:changeAccount', (hireId, accountId) => {
    if (!known(hireId)) return refuse('This hire has not synced to this machine yet.');
    if (typeof accountId !== 'string' || !deps.accounts().some((a) => a.id === accountId)) return refuse('That account is not on this machine.');
    return deps.changeAccount(hireId, accountId);
  });

  deps.handle('crew:letGo', (hireId) => (known(hireId) ? deps.letGo(hireId) : Promise.resolve(refuse('This hire has not synced to this machine yet.'))));
  deps.handle('crew:listRoles', () => readRoles(deps.db()));
  deps.handle('crew:hireAccounts', () => deps.hireAccounts());
  deps.handle('crew:createHire', (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return Promise.resolve(refuse('The hire form sent nothing.'));
    const { name, roleId, repos, accountId } = input as CrewHireInput;
    return deps.createHire({ name, roleId, repos, accountId });
  });
  deps.handle('crew:listCards', () => deps.cards());
  deps.handle('crew:openCard', (raiseId) => typeof raiseId === 'string' && deps.openCard(raiseId));
  deps.handle('crew:beginLink', () => deps.beginLink());
  deps.handle('crew:confirmLinkOwner', (isMe) => deps.confirmLinkOwner(isMe === true));
}
