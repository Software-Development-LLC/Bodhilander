/**
 * Provision a run's worktrees in TypeScript (CO-722, Phase 3 — dropping Python).
 *
 * The TS replacement for the harness's `provision.py`: for each owner, run the
 * repo's **`provision` command from the central config** in its worktree. The
 * registry's pkg/lang detection is gone — provisioning "stays data" (a command
 * string the config author writes), so this just runs it. A repo that declares
 * no command owes nothing; a non-zero exit is a failed install; a missing
 * worktree is undriveable. The three map onto the existing `provisionEvent`
 * vocabulary (`executor.ts`): 0 provisioned, 1 failed, 2 undriveable.
 *
 * Pure over injected deps (owners, the per-repo command, a shell runner), so the
 * install policy is a value a test asserts on rather than something only a real
 * install reveals — the same discipline as `provision.py`'s `plan()`.
 */
import type { CommandResult } from './reconcile';

export interface ProvisionOwner {
  repo: string;
  worktree: string;
}

export interface ProvisionDeps {
  /** The run's owners (repo + worktree), from `run_owners`. */
  owners(): readonly ProvisionOwner[];
  /** The repo's `provision` command from the central config, or null when it declares none. */
  commandFor(repo: string): string | null;
  /** Run a shell command in a worktree; the wiring picks the platform shell + install ceiling. */
  run(command: string, cwd: string): Promise<CommandResult>;
  log(line: string): void;
}

/** What provisioning established, shaped so `executor.ts` maps `code` through `provisionEvent`. */
export interface ProvisionSummary {
  /** 0 provisioned (installed or nothing owed), 1 an install failed, 2 nothing could be run here. */
  code: 0 | 1 | 2;
  log: string;
}

/** The first non-empty line across the given texts, for a one-line reason. */
function firstLine(...texts: string[]): string | null {
  for (const text of texts) {
    const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (line) return line;
  }
  return null;
}

/**
 * Provision every owner, stopping at the first failure/undriveable. A run with
 * no owners, or whose repos declare no `provision`, is provisioned (nothing
 * owed) — not a fault, exactly as a repo recording neither pkg nor lang was.
 */
export async function provisionRun(deps: ProvisionDeps): Promise<ProvisionSummary> {
  const lines: string[] = [];
  for (const { repo, worktree } of deps.owners()) {
    const command = deps.commandFor(repo);
    if (!command) {
      lines.push(`${repo}: nothing to provision`);
      continue;
    }
    if (!worktree) {
      const line = `${repo}: no worktree to provision in`;
      deps.log(line);
      return { code: 2, log: line };
    }
    deps.log(`${repo}: ${command}`);
    const res = await deps.run(command, worktree);
    if (res.code !== 0) {
      const why = firstLine(res.stderr, res.stdout) ?? `exit ${res.code}`;
      return { code: 1, log: `${repo}: ${command} failed: ${why}` };
    }
    lines.push(`${repo}: ${command} ok`);
  }
  return { code: 0, log: lines.join('\n') };
}
