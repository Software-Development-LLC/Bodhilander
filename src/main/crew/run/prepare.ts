/**
 * Everything a run needs before it starts: the hire's account resolved
 * directly, the sign-in checked, the steering paths regenerated, the settings
 * written, and the session chosen. Any failure here means the run does not start.
 */
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import type { ClaudeAccount } from '../../../shared/types';
import { resolveAccountRef, type ClaudeAccountRef } from '../account-ref';
import type { CrewSignIn } from '../crew-token';
import { consumeTaint, isTainted } from '../taint';
import { runArgs, runEnv } from './env';
import type { CrewJob, Prepared } from './loop';
import { runSettingsJson, type SandboxInput } from './sandbox-settings';
import { cwdFor, hirePaths, settingsPathFor, underTempDir, type HirePaths } from './scope';
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
  /** The role's handbook for CLAUDE.md; skills are restored by the caller's bundle step. */
  handbook(hireId: string): string;
  restoreSkills?(paths: HirePaths): void;
  mcpServers(paths: HirePaths, job: CrewJob): Record<string, unknown>;
  sandbox(paths: HirePaths, job: CrewJob, configDir: string): Omit<SandboxInput, 'paths' | 'scope' | 'configDir' | 'userData' | 'home'>;
  model?(hireId: string): string | undefined;
  now?(): number;
  underTemp?(dir: string): boolean;
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
function regenerate(paths: HirePaths, cwd: string, handbook: string, restoreSkills?: (p: HirePaths) => void): void {
  for (const dir of [paths.owner, paths.circle, paths.run, paths.ghConfig, paths.shell]) fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(cwd, '.claude'), { recursive: true, force: true });
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), handbook);
  restoreSkills?.(paths);
}

export async function prepareRun(deps: PrepareDeps, job: CrewJob, threadKey: string): Promise<Prepared> {
  const now = deps.now?.() ?? Date.now();
  const ref = hireAccountRef(deps.db, job.hireId);
  const account = ref ? resolveAccountRef(ref, deps.accounts()) : null;
  if (!account) return { hold: HOLD_MISSING };
  if (!deps.signIn.signedIn(account.id, deps.loggedIn(account.configDir), now)) return { hold: HOLD_SIGNED_OUT };

  const paths = hirePaths(deps.userData, job.hireId);
  const underTemp = deps.underTemp ?? ((dir: string) => underTempDir(dir, deps.env.TMPDIR));
  if (underTemp(deps.userData) || underTemp(paths.root)) return { hold: HOLD_SETUP };

  const cwd = cwdFor(paths, job.scope);
  regenerate(paths, cwd, deps.handbook(job.hireId), deps.restoreSkills);
  const settingsPath = settingsPathFor(paths, job.scope);
  const sandbox: SandboxInput = { ...deps.sandbox(paths, job, account.configDir), paths, scope: job.scope, configDir: account.configDir, userData: deps.userData, home: deps.home };
  fs.writeFileSync(settingsPath, runSettingsJson(sandbox), { mode: 0o600 });
  const mcpConfigPath = path.join(paths.run, `mcp-${job.scope}.json`);
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: deps.mcpServers(paths, job) }), { mode: 0o600 });

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
    if (reason === 'tainted') consumeTaint(deps.db, job.hireId, threadKey);
    input = freshSessionInput(reason, lastTurns(deps.db, job.hireId, threadKey), job.text);
    sessionId = null;
  }

  const token = deps.signIn.mode() === 'token' ? deps.signIn.tokenFor(account.id, now) : null;
  if (deps.signIn.mode() === 'token' && token === null) return { hold: HOLD_SIGNED_OUT };
  return {
    command: deps.claudePath,
    args: runArgs({ sessionId, settingsPath, mcpConfigPath, model: deps.model?.(job.hireId) }),
    cwd,
    env: runEnv(deps.env, { configDir: account.configDir, ghConfigDir: paths.ghConfig, shellDir: paths.shell, tokenOnFd: token !== null }),
    input,
    accountId: account.id,
    sessionId,
    token,
  };
}
