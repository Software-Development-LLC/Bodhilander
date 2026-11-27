/**
 * Everything a run needs before it starts: the hire's account resolved
 * directly, the sign-in checked, the steering paths regenerated, the settings
 * written, and the session chosen. Any failure here means the run does not start.
 */
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import type { AccountUsage, ClaudeAccount } from '../../../shared/types';
import type { CrewAccountCap } from '../../repositories/preferences';
import { resolveAccountRef, type ClaudeAccountRef } from '../account-ref';
import type { CrewSignIn } from '../crew-token';
import { holdState, type Holds } from '../holds';
import { SteeringUnavailable } from '../handbook';
import { consumeTaint, isTainted } from '../taint';
import { runArgs, runEnv } from './env';
import type { CrewJob, Prepared } from './loop';
import { buildRunSettings, type SandboxInput } from './sandbox-settings';
import { ServicesNotReady, type RunServices } from './services';
import { SocketRootError } from './sockets';
import { cwdFor, hirePaths, settingsPathFor, underTempDir, type HirePaths } from './scope';
import type { HireDayUsage } from './hire-usage';
import { freshReason, freshSessionInput, type Turn } from './sessions';

export const HOLD_MISSING = 'held:missing';
export const HOLD_SIGNED_OUT = 'held:signed-out';
export const HOLD_SETUP = 'held:setup';

export interface PrepareDeps {
  db: Database.Database;
  signIn: CrewSignIn;
  accounts(): ClaudeAccount[];
  loggedIn(configDir: string): boolean | undefined;
  userData: string;
  home: string;
  claudePath: string;
  env: Record<string, string | undefined>;
  timeZone(): string | null;
  /** The role's handbook for CLAUDE.md; throws SteeringUnavailable when the role has not synced. */
  handbook(hireId: string): string;
  holds: Holds;
  usage(accountId: string): AccountUsage | null;
  accountCap(accountId: string): CrewAccountCap;
  hireUsage: HireDayUsage;
  /** Writes the hire's pinned bundle into skills/; throws SteeringUnavailable when it cannot be pinned. */
  restoreSkills?(paths: HirePaths, hireId: string): void;
  /** The run's MCP servers, gateway sockets and shim env; throws when they cannot be set up. */
  services(job: CrewJob, threadKey: string, runId: string): Promise<RunServices>;
  sandbox(paths: HirePaths, job: CrewJob, configDir: string): Omit<SandboxInput, 'paths' | 'scope' | 'configDir' | 'userData' | 'home'>;
  model?(hireId: string): string | undefined;
  now?(): number;
  underTemp?(dir: string): boolean;
  platform?: NodeJS.Platform;
}

function hireAccountRef(db: Database.Database, hireId: string): ClaudeAccountRef | null {
  const row = db.prepare(`SELECT data FROM crew_hire_cache WHERE hire_id = ?`).get(hireId) as { data: string } | undefined;
  try {
    const ref = (JSON.parse(row?.data ?? '{}') as { accountRef?: Partial<ClaudeAccountRef> }).accountRef;
    if (!ref || typeof ref.label !== 'string') return null;
    return { accountUuid: ref.accountUuid ?? null, email: ref.email ?? null, label: ref.label };
  } catch {
    return null;
  }
}

function hireDailyCap(db: Database.Database, hireId: string): number | null {
  const row = db.prepare(`SELECT data FROM crew_hire_cache WHERE hire_id = ?`).get(hireId) as { data: string } | undefined;
  try {
    const cap = (JSON.parse(row?.data ?? '{}') as { dailyTokenCap?: unknown }).dailyTokenCap;
    return typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? cap : null;
  } catch {
    return null;
  }
}

/** Rate limit, the account's Crew cap, then the hire's own daily cap; the hire cap needs today's total only when it is set. */
async function usageHold(deps: PrepareDeps, job: CrewJob, accountId: string, now: number): Promise<string | null> {
  const dailyTokens = hireDailyCap(deps.db, job.hireId);
  const usedToday = dailyTokens === null ? 0 : await deps.hireUsage.usedToday(job.hireId, job.epoch, now, deps.timeZone());
  const cause = deps.holds.evaluate({
    accountId,
    signedIn: true,
    usage: deps.usage(accountId),
    cap: deps.accountCap(accountId),
    hireCap: { dailyTokens, usedToday },
    now,
  });
  return cause === null ? null : holdState(cause);
}

function lastTurns(db: Database.Database, hireId: string, threadKey: string): Turn[] {
  const rows = db
    .prepare(
      `SELECT j.text AS input, r.reply_text AS reply FROM crew_run r JOIN crew_job j ON j.id = r.job_id
       WHERE r.hire_id = ? AND r.thread_key = ? AND r.outcome = 'done' ORDER BY r.rowid DESC LIMIT 4`,
    )
    .all(hireId, threadKey) as Turn[];
  return rows.reverse();
}

/** The cwd's steering paths come from the role and the bundle on every run, so nothing a run left there survives. */
const HIRE_GITCONFIG = '[core]\n\texcludesFile = /dev/null\n\tattributesFile = /dev/null\n';
const gitConfigPath = (paths: HirePaths): string => path.join(paths.git, 'gitconfig');

function regenerate(paths: HirePaths, cwd: string, readHandbook: () => string, restoreSkills?: (p: HirePaths) => void): void {
  const handbook = readHandbook();
  for (const dir of [paths.owner, paths.circle, paths.run, paths.ghConfig, paths.shell, paths.git]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(gitConfigPath(paths), HIRE_GITCONFIG);
  fs.rmSync(path.join(cwd, '.claude'), { recursive: true, force: true });
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), handbook);
  restoreSkills?.(paths);
}

/** False when the Hub's steering for the hire has not synced; any other failure throws. */
function steer(deps: PrepareDeps, hireId: string, paths: HirePaths, cwd: string): boolean {
  const restore = deps.restoreSkills;
  try {
    regenerate(paths, cwd, () => deps.handbook(hireId), restore && ((p) => restore(p, hireId)));
    return true;
  } catch (err) {
    if (err instanceof SteeringUnavailable) return false;
    throw err;
  }
}

/** The tainted session is dropped with its mark, so no later run can resume it. */
function forgetTaintedSession(db: Database.Database, hireId: string, threadKey: string): void {
  db.transaction(() => {
    db.prepare(`UPDATE crew_thread SET session_id = NULL WHERE hire_id = ? AND thread_key = ?`).run(hireId, threadKey);
    consumeTaint(db, hireId, threadKey);
  })();
}

export async function prepareRun(deps: PrepareDeps, job: CrewJob, threadKey: string, runId: string): Promise<Prepared> {
  // A Windows run belongs inside WSL2; until that setup exists, nothing runs natively.
  if ((deps.platform ?? process.platform) === 'win32') return { hold: HOLD_SETUP };
  const now = deps.now?.() ?? Date.now();
  const ref = hireAccountRef(deps.db, job.hireId);
  const account = ref ? resolveAccountRef(ref, deps.accounts()) : null;
  if (!account) return { hold: HOLD_MISSING };
  if (!deps.signIn.signedIn(account.id, deps.loggedIn(account.configDir), now)) return { hold: HOLD_SIGNED_OUT };

  const token = deps.signIn.mode() === 'token' ? deps.signIn.tokenFor(account.id, now) : null;
  if (deps.signIn.mode() === 'token' && token === null) return { hold: HOLD_SIGNED_OUT };
  const held = await usageHold(deps, job, account.id, now);
  if (held) return { hold: held };

  const paths = hirePaths(deps.userData, job.hireId);
  const underTemp = deps.underTemp ?? ((dir: string) => underTempDir(dir, deps.env.TMPDIR));
  if (underTemp(deps.userData) || underTemp(paths.root)) return { hold: HOLD_SETUP };

  let services: RunServices;
  try {
    services = await deps.services(job, threadKey, runId);
  } catch (err) {
    if (err instanceof SocketRootError || err instanceof ServicesNotReady) return { hold: HOLD_SETUP };
    throw err;
  }
  const cwd = cwdFor(paths, job.scope);
  if (!steer(deps, job.hireId, paths, cwd)) return { hold: HOLD_SETUP };
  const settingsPath = settingsPathFor(paths, job.scope);
  const base = deps.sandbox(paths, job, account.configDir);
  const sandbox: SandboxInput = { ...base, sockets: [...base.sockets, ...services.sockets], paths, scope: job.scope, configDir: account.configDir, userData: deps.userData, home: deps.home };
  const settings = buildRunSettings(sandbox);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  const mcpConfigPath = path.join(paths.run, `mcp-${job.scope}.json`);
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: services.mcpServers }), { mode: 0o600 });

  const thread = deps.db.prepare(`SELECT session_id, account_id, updated_at FROM crew_thread WHERE hire_id = ? AND thread_key = ?`).get(job.hireId, threadKey) as
    | { session_id: string | null; account_id: string | null; updated_at: string | null }
    | undefined;
  const lastRunAt = thread?.updated_at ? Date.parse(`${thread.updated_at.replace(' ', 'T')}Z`) : null;
  const reason = freshReason(
    {
      sessionId: thread?.session_id ?? null,
      contextTokens: null,
      lastRunAt: Number.isNaN(lastRunAt) ? null : lastRunAt,
      tainted: isTainted(deps.db, job.hireId, threadKey),
      moved: false,
    },
    now,
    deps.timeZone(),
  );
  let sessionId = thread?.session_id ?? null;
  let input = job.text;
  if (reason) {
    if (reason === 'tainted') forgetTaintedSession(deps.db, job.hireId, threadKey);
    input = freshSessionInput(reason, lastTurns(deps.db, job.hireId, threadKey), job.text);
    sessionId = null;
  }

  return {
    command: deps.claudePath,
    args: runArgs({ sessionId, settingsPath, mcpConfigPath, model: deps.model?.(job.hireId) }),
    cwd,
    env: runEnv(deps.env, { configDir: account.configDir, ghConfigDir: paths.ghConfig, shellDir: paths.shell, tokenOnFd: token !== null, pathFirst: services.pathFirst, extra: services.env, home: deps.home, reopened: settings.sandbox.filesystem.allowRead, gitConfig: gitConfigPath(paths) }),
    input,
    accountId: account.id,
    sessionId,
    token,
  };
}
