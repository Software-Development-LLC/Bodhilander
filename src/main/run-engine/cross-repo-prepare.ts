/**
 * Planning a cross-repo run before any side effect (CO-722).
 *
 * The loop-driven bootstrap means "prepare" does almost nothing eagerly: it
 * validates the machine config and the picks, then creates ONE run row in
 * `bootstrap_state: 'scoping'` and returns. The run shows in the Runs view
 * immediately and the loop scopes it, drives `arch`, parks for approval and
 * spawns -- all durably, on its own timer. Nothing here runs a script or cuts a
 * worktree, so the call returns instantly and a closed app resumes mid-flight.
 *
 * This module is the pure half: given the request and the resolved config it
 * returns either a fixable refusal list or the exact `CreateRunInput` the
 * service writes. Kept DB-free so the validation is testable without electron.
 */
import * as path from 'path';
import type { CreateRunInput } from '../repositories/runs';

export interface CrossRepoConfig {
  pythonPath: string;
  harnessPath: string | null;
  bodhiRoot: string | null;
  initiativesRoot: string | null;
}

export interface CrossRepoRequest {
  issueId: string;
  repos: string[];
  /** The initiative's dollar budget; the per-gate ceiling. Optional. */
  budgetUsd?: number;
}

export type CrossRepoPlan =
  | { status: 'create'; input: CreateRunInput }
  | { status: 'refused'; refusals: { what: string; fix: string }[] };

/** The issue id must be usable as a directory name -- the harness enforces the same shape. */
const ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The leading `KEY-N` of an issue id, uppercased, or the id unchanged.
 *
 * Mirrors the harness's `tracking_id` (init_task.py / file_scope.py): the
 * merge-order check searches PR titles for this key with `in:title`, not for the
 * folder's descriptive suffix, so the app and the harness must strip it the same
 * way or a run's PRs cannot be found.
 */
export function trackingId(issueId: string): string {
  const match = /^([A-Za-z]{2,6}-\d+)(?:-|$)/.exec(issueId);
  return match ? match[1].toUpperCase() : issueId;
}

/**
 * Validate a cross-repo prepare and produce the run row to write, or the list to
 * fix. Every missing machine setting is collected first so a person fixes
 * Settings once; the run is `kind: 'multi'`, entering at `scoping`, with the
 * tester's picks recorded for gate 0 to write team.yaml from.
 */
export function planCrossRepoRun(
  request: CrossRepoRequest,
  config: CrossRepoConfig,
  newId: () => string,
): CrossRepoPlan {
  const refusals: { what: string; fix: string }[] = [];
  if (!config.harnessPath) {
    refusals.push({ what: 'no harness is configured', fix: 'Set the harness path in Settings → Run engine.' });
  }
  if (!config.bodhiRoot) {
    refusals.push({ what: 'no workspace root is configured', fix: 'Set BODHI_ROOT (the folder holding the repo clones) in Settings → Run engine.' });
  }
  if (!config.initiativesRoot) {
    refusals.push({ what: 'no initiatives folder is configured', fix: 'Set where initiatives are written in Settings → Run engine.' });
  }
  if (!ISSUE_ID.test(request.issueId)) {
    refusals.push({ what: `${request.issueId || '(empty)'} is not usable as an initiative name`, fix: 'Use letters, digits, dot, dash or underscore, starting with a letter or digit.' });
  }
  const repos = dedupe(request.repos.map((r) => r.trim()).filter(Boolean));
  if (repos.length === 0) {
    refusals.push({ what: 'no repos were chosen', fix: 'Pick the repos this initiative changes (two or more, for a cross-repo run).' });
  }
  if (refusals.length > 0) return { status: 'refused', refusals };

  // Narrowed by the guards above.
  const harnessPath = config.harnessPath as string;
  const bodhiRoot = config.bodhiRoot as string;
  const initiativesRoot = config.initiativesRoot as string;

  return {
    status: 'create',
    input: {
      id: newId(),
      initiativeKey: trackingId(request.issueId),
      initiativeDir: path.join(initiativesRoot, request.issueId),
      harnessPath,
      bodhiRoot,
      pythonPath: config.pythonPath,
      permissionPosture: 'manual',
      budgetUsd: request.budgetUsd ?? null,
      kind: 'multi',
      bootstrapState: 'scoping',
      scopeRepos: repos,
    },
  };
}

/** Keep first occurrence; a repo picked twice is one owner, not two. */
function dedupe(repos: string[]): string[] {
  return [...new Set(repos)];
}
