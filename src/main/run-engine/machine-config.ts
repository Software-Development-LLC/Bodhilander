/**
 * Where the run engine's machine settings come from (CO-722).
 *
 * The console read every setting from a `BODHI_*` variable. The app keeps that
 * working -- a machine with the env already exported behaves exactly as before
 * -- but adds a friendlier source in front of it: a preference a person sets in
 * Settings. The order is preference -> env -> built-in default, so a value set
 * in the UI wins, an env var is the fallback for a headless or scripted setup,
 * and the default is what an untouched machine gets.
 *
 * All of it lives here rather than at the call sites so "where does the claude
 * path come from" has one answer, and so the Settings form and the engine name
 * the same preference keys (from `RUN_ENGINE_PREF_KEYS`) and cannot drift.
 */
import { getPreference } from '../repositories/preferences';
import { RUN_ENGINE_PREF_KEYS as K } from '../../shared/types';
import type { PermissionPosture } from '../repositories/runs';

/**
 * A preference's trimmed value, or null when it is unset, blank, or the store
 * is not open yet.
 *
 * The try/catch is deliberate: this is read from the run loop, which can tick
 * before the database is ready in some startup orderings, and a missing
 * preference must read as "fall back to env", never as a crash that stops the
 * engine.
 */
function pref(key: string): string | null {
  try {
    const value = getPreference(key);
    return value && value.trim().length > 0 ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * An environment override, or the default when it is unset OR empty.
 *
 * `BODHI_CLAUDE=` (set but blank) means "no override", not "the path is the
 * empty string" -- so a bare `??` would be wrong (it keeps the blank) and a
 * bare `||` reads as a mistake.
 */
function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

/** preference -> env -> default, the whole resolution order in one place. */
function resolved(prefKey: string, envName: string, fallback: string): string {
  return pref(prefKey) ?? envOr(envName, fallback);
}

/** The `claude` binary the loop launches gates with. */
export function claudePath(): string {
  return resolved(K.claudePath, 'BODHI_CLAUDE', 'claude');
}

/** The `gh` binary every check and review reads through. */
export function ghPath(): string {
  return resolved(K.ghPath, 'BODHI_GH', 'gh');
}

/**
 * The `git` binary worktree cutting shells out to (Phase 3). No preference —
 * git is universally on PATH — just an env override and the bare default, which
 * Node resolves on PATH like `spawn.py`'s bare `git` calls did.
 */
export function gitPath(): string {
  const env = process.env.BODHI_GIT?.trim();
  return env && env.length > 0 ? env : 'git';
}

/** The python interpreter the harness scripts run under. */
export function pythonPath(): string {
  return resolved(K.pythonPath, 'BODHI_PYTHON', 'python');
}

/** Approvers a review request goes to. Empty until configured; the engine refuses clearly then. */
export function approvers(): readonly string[] {
  const raw = pref(K.approvers) ?? envOr('BODHI_APPROVERS', '');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The three paths preparing an initiative needs, each null when unset.
 *
 * These have no built-in default -- there is no sensible guess for where a
 * person keeps the harness clone or their repos -- so prepare refuses with a
 * "set this in Settings" message rather than inventing one. `bodhiRoot` still
 * accepts the `BODHI_ROOT` env the harness itself honours.
 */
export function harnessPath(): string | null {
  return pref(K.harnessPath);
}

export function bodhiRoot(): string | null {
  const fromEnv = process.env.BODHI_ROOT?.trim();
  return pref(K.bodhiRoot) ?? (fromEnv && fromEnv.length > 0 ? fromEnv : null);
}

export function initiativesRoot(): string | null {
  return pref(K.initiativesRoot);
}

/**
 * Board-driven orchestration settings (Phase 1).
 *
 * The GitHub org whose Projects v2 boards we read, the default project number to
 * show, and the Status value that marks an initiative eligible to start. Same
 * preference -> env -> default resolution as everything else.
 */
export function githubOrg(): string | null {
  const env = process.env.BODHI_GITHUB_ORG?.trim();
  return pref(K.githubOrg) ?? (env && env.length > 0 ? env : null);
}

/** The default project number to show, or null when unset. */
export function projectNumber(): number | null {
  const env = process.env.BODHI_PROJECT_NUMBER?.trim();
  const raw = pref(K.projectNumber) ?? (env && env.length > 0 ? env : null);
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The Issue Field whose value gates eligibility; defaults to the team's approval column. */
export function approvalField(): string {
  return resolved(K.approvalField, 'BODHI_APPROVAL_FIELD', 'Approved for Development');
}

/**
 * The approval-field values that mark an initiative eligible to start, as the
 * global default (a per-project override can live in the central config).
 * Stored comma-separated; defaults to just the approved value.
 */
export function eligibleApprovalValues(): string[] {
  const raw = resolved(K.eligibleApprovalValues, 'BODHI_ELIGIBLE_APPROVAL', 'Approved');
  const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return list.length > 0 ? list : ['Approved'];
}

/** The central config repo as `owner/repo`, or null when unset. */
export function configRepo(): string | null {
  const env = process.env.BODHI_CONFIG_REPO?.trim();
  return pref(K.configRepo) ?? (env && env.length > 0 ? env : null);
}

/**
 * How a run answers gate permission prompts. Defaults to `manual` (a person
 * answers each) — the safe default; `bypass` auto-approves for trusted
 * autonomous runs, `denyOnPrompt` fails closed. An unrecognized value falls
 * back to manual rather than guessing at a looser posture.
 */
export function permissionPosture(): PermissionPosture {
  const value = resolved(K.permissionPosture, 'BODHI_PERMISSION_POSTURE', 'manual');
  return value === 'bypass' || value === 'denyOnPrompt' ? value : 'manual';
}

/** The path to the config JSON within the config repo; defaults to orchestration.json. */
export function configPath(): string {
  return resolved(K.configPath, 'BODHI_CONFIG_PATH', 'orchestration.json');
}
