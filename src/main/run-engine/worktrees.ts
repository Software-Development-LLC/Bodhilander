/**
 * Cut a run's git worktrees in TypeScript (CO-722, Phase 3 — dropping Python).
 *
 * The TS port of the harness's `spawn.py` worktree core: for each in-scope repo,
 * cut a worktree from `origin/<integration_branch>` into a sibling inside
 * `BODHI_ROOT`. Everything the registry model added (retired flags, lang/pkg
 * detection, team.yaml authoring) is gone — the base branch is now *data* from
 * the central config, and the owner rows are written by `materializeOwners` from
 * the descriptors this returns.
 *
 * Pure argv-builders + a `cutWorktrees(deps, plan)` with an injected `git`
 * runner, filesystem probes and clock-free logic, so the whole thing is testable
 * dry (same shape as `board-service` / `orchestration-config`). Idempotent: an
 * existing worktree is a resume, never a re-cut — every initiative iterates, and
 * re-entering must not redo work.
 */
import * as path from 'path';
import type { CommandResult } from './reconcile';

export interface WorktreeDeps {
  /** Runs `git <argv>` (a bare `git` is fine; it resolves on PATH like the harness). */
  git(argv: readonly string[]): Promise<CommandResult>;
  dirExists(p: string): boolean;
  mkdirp(p: string): void;
  /** The workspace root holding the repo clones (BODHI_ROOT). */
  bodhiRoot: string;
  /**
   * The org the clones should belong to; when set, a clone whose `origin` names
   * a different repo is refused (an owner there would edit the wrong repo while
   * every report names this one). Null skips the check.
   */
  org: string | null;
}

/** One repo to cut, with its base branch already resolved (from the central config). */
export interface RepoPlan {
  repo: string;
  /** The branch to cut from; the caller defaults it to `development`. */
  integrationBranch: string;
}

export interface WorktreePlan {
  /** The initiative tracking key (e.g. `CO-130`) — names the worktree + branch. */
  initiative: string;
  repos: readonly RepoPlan[];
}

/** A cut (or resumed) worktree, shaped for `materializeOwners` to write as an owner row. */
export interface OwnerWorktree {
  worktree: string;
  branch: string;
  base: string;
  scratch: string;
}

export type WorktreeResult =
  | { status: 'ok'; owners: Record<string, OwnerWorktree> }
  | { status: 'refused'; reason: string };

/** `bodhi-code` → `code`; the worktree/branch names drop the `bodhi-` prefix like the harness. */
const shortRepo = (repo: string): string => repo.replace(/^bodhi-/, '');
const slugify = (initiative: string): string => initiative.toLowerCase().replace(/ /g, '-');

/** The worktree dir: a sibling inside BODHI_ROOT (a repo may pin its package manager one dir up). */
export function worktreePath(bodhiRoot: string, initiative: string, repo: string): string {
  return path.join(bodhiRoot, `_wt-${slugify(initiative)}-${shortRepo(repo)}`);
}

/** The feature branch cut for a repo's owner. */
export function branchName(initiative: string, repo: string): string {
  return `feat/${initiative}-${shortRepo(repo)}`;
}

/** The last path segment of a clone's `origin` URL, minus `.git` — for the origin check. */
function originRepo(url: string): string {
  return url.trim().replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() ?? '';
}

/**
 * Cut (or resume) one repo's worktree, or say why an owner cannot start there.
 * A refusal is decisive — the caller parks the run inconclusive with the reason,
 * because everything downstream reports on what an owner did.
 */
async function ensureWorktree(
  deps: WorktreeDeps,
  initiative: string,
  plan: RepoPlan,
): Promise<{ owner: OwnerWorktree } | { refused: string }> {
  const { repo, integrationBranch: base } = plan;
  const src = path.join(deps.bodhiRoot, repo);
  if (!deps.dirExists(src)) {
    return { refused: `${repo}: clone not present in BODHI_ROOT (${src})` };
  }

  if (deps.org) {
    const url = await deps.git(['-C', src, 'remote', 'get-url', 'origin']);
    const named = originRepo(url.stdout);
    if (url.code === 0 && named && named !== repo) {
      return { refused: `${repo}: the clone at ${src} has origin '${named}', not '${repo}' — an owner there would edit the wrong repo` };
    }
  }

  const dest = worktreePath(deps.bodhiRoot, initiative, repo);
  const branch = branchName(initiative, repo);
  const scratch = `${dest}-scratch`;

  if (deps.dirExists(dest)) {
    // Resume, not a re-cut: reuse the branch already checked out there.
    const cur = (await deps.git(['-C', dest, 'branch', '--show-current'])).stdout.trim();
    return { owner: { worktree: dest, branch: cur.length > 0 ? cur : branch, base, scratch } };
  }

  // Always cut from the freshly fetched integration branch, never from whatever
  // the shared clone happens to be sitting on. Widen a single-branch clone first
  // so `origin/<base>` is even visible.
  await widenIfSingleBranch(deps, src);
  await deps.git(['-C', src, 'fetch', 'origin', '--quiet']);
  const add = await deps.git(['-C', src, 'worktree', 'add', dest, '-b', branch, `origin/${base}`]);
  if (add.code !== 0) {
    const text = add.stderr.trim().length > 0 ? add.stderr.trim() : add.stdout.trim();
    const firstLine = text.split(/\r?\n/)[0];
    const why = firstLine.length > 0 ? firstLine : `exit ${add.code}`;
    return { refused: `${repo}: worktree add failed: ${why}` };
  }
  deps.mkdirp(scratch);
  return { owner: { worktree: dest, branch, base, scratch } };
}

/** `git remote set-branches origin '*'` when the clone was cloned `--single-branch`. */
async function widenIfSingleBranch(deps: WorktreeDeps, src: string): Promise<void> {
  const cfg = await deps.git(['-C', src, 'config', '--get', 'remote.origin.fetch']);
  const spec = cfg.stdout.trim();
  // A `--single-branch` clone's refspec names one branch and has no `*`.
  if (spec && !spec.includes('*')) {
    await deps.git(['-C', src, 'remote', 'set-branches', 'origin', '*']);
  }
}

/**
 * Cut every repo's worktree, or return the first refusal. The result's `owners`
 * map is exactly what `materializeOwners` writes as the run's owner rows.
 */
export async function cutWorktrees(deps: WorktreeDeps, plan: WorktreePlan): Promise<WorktreeResult> {
  if (plan.repos.length === 0) {
    return { status: 'refused', reason: 'no repos in scope to cut worktrees for' };
  }
  const owners: Record<string, OwnerWorktree> = {};
  for (const repo of plan.repos) {
    const one = await ensureWorktree(deps, plan.initiative, repo);
    if ('refused' in one) return { status: 'refused', reason: one.refused };
    owners[repo.repo] = one.owner;
  }
  return { status: 'ok', owners };
}
