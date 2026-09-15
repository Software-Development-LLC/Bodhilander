/**
 * Finding the PR a run's scribe opened (CO-722).
 *
 * The scribe opens the PR, and nothing tells the engine which one. The
 * console learned it from an environment variable typed by a person, which
 * is the dispatcher problem in miniature. The run does know the BRANCH --
 * `run_owners.branch`, mirrored from team.yaml -- and `gh pr list --head`
 * run inside the worktree finds the PR for it without anyone naming the
 * repository: gh reads the remote.
 *
 * Pure here: the argv to run and the readings of what came back. The loop
 * runs it and records the answer on the owner row, once.
 */

export interface DiscoveredPr {
  number: number;
  url: string;
}

/**
 * `gh pr list` for the branch, to be run with the worktree as cwd.
 *
 * `--state all` and the state in the output, rather than `--state open`:
 * a merged PR is still the run's PR, and a run reconciling after a merge
 * must find it rather than conclude one was never opened.
 */
export function discoverPrArgv(branch: string): string[] {
  return ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,url,state', '--limit', '10'];
}

/**
 * The PR to attach to, from `gh pr list` output.
 *
 * An open PR first; otherwise the most recently numbered. Two open PRs for
 * one branch is a situation gh itself does not allow. Malformed output is
 * null, never a guess: a run attached to the wrong PR reconciles someone
 * else's checks.
 */
export function readDiscoveredPr(stdout: string): DiscoveredPr | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows = parsed
    .map((row) => (typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : null))
    .filter((row): row is Record<string, unknown> => row !== null)
    .filter((row) => typeof row.number === 'number' && typeof row.url === 'string' && row.url.length > 0);
  if (rows.length === 0) return null;
  const open = rows.find((row) => row.state === 'OPEN');
  const chosen = open ?? [...rows].sort((a, b) => (b.number as number) - (a.number as number))[0];
  return { number: chosen.number as number, url: chosen.url as string };
}

/**
 * `owner/name` from a GitHub PR URL, or null.
 *
 * The registry knows repositories by path, not by slug, and `gh --repo`
 * wants the slug. The PR's own URL is the one place both halves appear
 * together, written by GitHub rather than by anyone here.
 */
export function repoSlugFromUrl(url: string): string | null {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}
