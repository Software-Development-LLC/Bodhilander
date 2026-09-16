/**
 * Gate 0 for a cross-repo run, done mechanically (CO-722).
 *
 * A single-repo run's scope is trivial, so `init_task.py` writes team.yaml and
 * seams.yaml in one shot. A cross-repo run's scope -- which repos, and each
 * one's brief -- is a real decision, but the tester makes it by PICKING the
 * repos, so there is still no LLM to run: this writes an `owners.yaml` from the
 * picks and hands it to the harness's own `file_scope.py`, which authors
 * team.yaml exactly as it does for a product owner's `file` job. Gate 1 (`arch`)
 * still runs later to write seams.yaml -- the seam contracts a person cannot
 * pick.
 *
 * Invoked like every other harness script: the python interpreter against the
 * library file, never the `.sh` wrapper (Windows cannot spawn those without a
 * shell). Idempotent on resume: if team.yaml already exists (a crash after the
 * write) it reports scoped rather than re-running file_scope, which refuses to
 * overwrite.
 */
import * as path from 'path';
import type { RunRow } from '../repositories/runs';
import type { CommandOutput } from './prepare-initiative';

/** The side effects scoping needs, injected so the path is testable dry. */
export interface ScopeIo {
  run(
    executable: string,
    argv: readonly string[],
    opts: { env?: Record<string, string> },
  ): Promise<CommandOutput>;
  readFile(p: string): string | null;
  writeFile(p: string, content: string): void;
}

export type ScopeResult =
  | { status: 'scoped' }
  | { status: 'refused'; reason: string; log?: string };

/**
 * Write team.yaml for a cross-repo run from its repo picks, or report why not.
 *
 * The issue id and initiatives root are the run's own -- `initiativeDir` is
 * `<root>/<issue>`, so both are read back off it, the same convention
 * `prepareInitiative` uses. The owners.yaml sits beside the initiative folder;
 * it is a small input artifact, left in place (like a leftover worktree) rather
 * than raced against a later reader by deleting it.
 */
export async function scopeInitiative(run: RunRow, io: ScopeIo): Promise<ScopeResult> {
  const issueId = path.basename(run.initiativeDir);
  const initiativesRoot = path.dirname(run.initiativeDir);
  const repos = run.scopeRepos ?? [];
  if (repos.length === 0) {
    return { status: 'refused', reason: 'no repos were recorded for this cross-repo run' };
  }

  // Resume: file_scope refuses to overwrite an existing team.yaml (it may hold a
  // scope record this run does not have), so a re-entry after the write already
  // landed reads as already-scoped rather than a failure.
  if (io.readFile(path.join(run.initiativeDir, 'team.yaml')) !== null) {
    return { status: 'scoped' };
  }

  const ownersPath = path.join(initiativesRoot, `${issueId}.owners.yaml`);
  io.writeFile(ownersPath, ownersYaml(repos, run.initiativeKey));

  const argv = [
    path.join(run.harnessPath, 'scripts', 'lib', 'file_scope.py'),
    issueId,
    ownersPath,
    '--dir',
    initiativesRoot,
  ];
  const scoped = await io.run(run.pythonPath ?? 'python', argv, {});
  if (scoped.code !== 0) {
    return {
      status: 'refused',
      reason: firstLine(scoped.stderr, scoped.stdout) ?? 'file_scope could not write team.yaml',
      log: join(scoped.stdout, scoped.stderr),
    };
  }
  return { status: 'scoped' };
}

/**
 * An `owners.yaml` mapping each picked repo to a brief.
 *
 * The brief is generic on purpose: the tester picked the repos but wrote no
 * per-repo slice, so each owner is pointed at the tracking issue and the seam
 * manifest `arch` will write. A later slice can collect a real brief per repo.
 * `file_scope.py` refuses the four keys `spawn.py` stamps (worktree/branch/
 * base/scratch); `what_to_do` is not one of them, so this is always accepted.
 */
export function ownersYaml(repos: readonly string[], initiativeKey: string): string {
  const brief = `Implement initiative ${initiativeKey} in this repo. See the tracking issue and seams.yaml for scope and contracts.`;
  // repo names are registry slugs (validated by the picker and re-checked by
  // file_scope), and the brief is a fixed sentence with a slug in it, so a
  // double-quoted scalar needs no further escaping.
  return repos.map((repo) => `${repo}:\n  what_to_do: "${brief}"`).join('\n') + '\n';
}

/** The first non-empty line across the given texts, for a one-line reason. */
function firstLine(...texts: string[]): string | null {
  for (const text of texts) {
    const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (line) return line;
  }
  return null;
}

/** Join the non-empty pieces with blank lines, for the shown log. */
function join(...pieces: string[]): string {
  return pieces.map((p) => p.trim()).filter(Boolean).join('\n\n');
}
