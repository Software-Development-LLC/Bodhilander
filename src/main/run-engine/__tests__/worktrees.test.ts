/**
 * Worktree-cutting tests (CO-722, Phase 3 — the TS port of spawn.py's core).
 *
 * The riskiest bits are the git command sequence (widen → fetch → add), the
 * resume-vs-cut branch, and the refusals (clone absent, origin mismatch, add
 * fails). `git`, the filesystem probes and the clock are injected, so no real
 * git or disk is in the room.
 *
 * Run with: bun test src/main/run-engine/__tests__/worktrees.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import { cutWorktrees, worktreePath, branchName, type WorktreeDeps } from '../worktrees';
import type { CommandResult } from '../reconcile';

const ROOT = path.join('C:', 'work', 'repos');
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

/** A git fake: records every argv, answers by matching the subcommand. */
function gitFake(answers: (argv: readonly string[]) => CommandResult = () => ok()) {
  const calls: string[][] = [];
  const git = async (argv: readonly string[]): Promise<CommandResult> => {
    calls.push([...argv]);
    return answers(argv);
  };
  return { git, calls };
}

function deps(over: Partial<WorktreeDeps> = {}): WorktreeDeps {
  const made: string[] = [];
  return {
    git: gitFake().git,
    dirExists: (p) => p.endsWith(path.join('repos', 'bodhi-code')) || p.endsWith(path.join('repos', 'bodhi-service-ml')),
    mkdirp: (p) => { made.push(p); },
    bodhiRoot: ROOT,
    org: 'Software-Development-LLC',
    ...over,
  };
}

describe('naming', () => {
  test('worktree dir is a bodhi-stripped, slugified sibling in BODHI_ROOT', () => {
    expect(worktreePath(ROOT, 'CO-130', 'bodhi-code')).toBe(path.join(ROOT, '_wt-co-130-code'));
  });
  test('branch keeps the raw initiative, drops the bodhi- prefix', () => {
    expect(branchName('CO-130', 'bodhi-service-ml')).toBe('feat/CO-130-service-ml');
  });
});

describe('cutWorktrees', () => {
  test('cuts a fresh worktree: widen (single-branch) → fetch → add', async () => {
    const { git, calls } = gitFake((argv) =>
      argv.includes('remote.origin.fetch') ? ok('+refs/heads/development:refs/remotes/origin/development')
      : argv.includes('get-url') ? ok('git@github.com:Software-Development-LLC/bodhi-code.git')
      : ok());
    const d = deps({ git, dirExists: (p) => p.endsWith(path.join('repos', 'bodhi-code')) });
    const r = await cutWorktrees(d, { initiative: 'CO-130', repos: [{ repo: 'bodhi-code', integrationBranch: 'development' }] });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    const w = r.owners['bodhi-code'];
    expect(w.worktree).toBe(path.join(ROOT, '_wt-co-130-code'));
    expect(w.branch).toBe('feat/CO-130-code');
    expect(w.base).toBe('development');
    // The single-branch clone was widened, then fetched, then the worktree added.
    const subcmds = calls.map((c) => c.join(' '));
    expect(subcmds.some((c) => c.includes('set-branches origin *'))).toBe(true);
    expect(subcmds.some((c) => c.includes('fetch origin --quiet'))).toBe(true);
    expect(subcmds.some((c) => c.includes(`worktree add ${path.join(ROOT, '_wt-co-130-code')} -b feat/CO-130-code origin/development`))).toBe(true);
  });

  test('does not widen a clone that already fetches all heads', async () => {
    const { git, calls } = gitFake((argv) =>
      argv.includes('remote.origin.fetch') ? ok('+refs/heads/*:refs/remotes/origin/*')
      : argv.includes('get-url') ? ok('git@github.com:Software-Development-LLC/bodhi-code.git') : ok());
    await cutWorktrees(deps({ git, dirExists: (p) => p.endsWith('bodhi-code') }),
      { initiative: 'CO-130', repos: [{ repo: 'bodhi-code', integrationBranch: 'development' }] });
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('set-branches'))).toBe(false);
  });

  test('an existing worktree is a resume, reusing its branch and cutting nothing', async () => {
    const { git, calls } = gitFake((argv) => argv.includes('--show-current') ? ok('feat/CO-130-code') : ok());
    const dest = path.join(ROOT, '_wt-co-130-code');
    const d = deps({ git, dirExists: (p) => p.endsWith('bodhi-code') || p === dest });
    const r = await cutWorktrees(d, { initiative: 'CO-130', repos: [{ repo: 'bodhi-code', integrationBranch: 'main' }] });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(r.owners['bodhi-code'].branch).toBe('feat/CO-130-code');
    expect(r.owners['bodhi-code'].base).toBe('main');
    expect(calls.map((c) => c.join(' ')).some((c) => c.includes('worktree add'))).toBe(false);
  });

  test('a missing clone is refused', async () => {
    const r = await cutWorktrees(deps({ dirExists: () => false }),
      { initiative: 'CO-130', repos: [{ repo: 'bodhi-code', integrationBranch: 'development' }] });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') throw new Error('unreachable');
    expect(r.reason).toContain('clone not present');
  });

  test('a clone whose origin names a different repo is refused', async () => {
    const { git } = gitFake((argv) => argv.includes('get-url')
      ? ok('git@github.com:Software-Development-LLC/some-other-repo.git') : ok());
    const r = await cutWorktrees(deps({ git, dirExists: (p) => p.endsWith('bodhi-code') }),
      { initiative: 'CO-130', repos: [{ repo: 'bodhi-code', integrationBranch: 'development' }] });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') throw new Error('unreachable');
    expect(r.reason).toContain("origin 'some-other-repo'");
  });

  test('the origin check is skipped when no org is configured', async () => {
    const { git } = gitFake((argv) => argv.includes('get-url') ? ok('whatever') : ok());
    const r = await cutWorktrees(deps({ git, org: null, dirExists: (p) => p.endsWith('bodhi-code') }),
      { initiative: 'CO-130', repos: [{ repo: 'bodhi-code', integrationBranch: 'development' }] });
    expect(r.status).toBe('ok');
  });

  test('a failed worktree add is refused with its first stderr line', async () => {
    const { git } = gitFake((argv) => argv.includes('add')
      ? { code: 128, stdout: '', stderr: "fatal: 'origin/development' is not a commit\nmore noise" } : ok());
    const r = await cutWorktrees(deps({ git, dirExists: (p) => p.endsWith('bodhi-code') }),
      { initiative: 'CO-130', repos: [{ repo: 'bodhi-code', integrationBranch: 'development' }] });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') throw new Error('unreachable');
    expect(r.reason).toContain('worktree add failed');
    expect(r.reason).toContain('not a commit');
    expect(r.reason).not.toContain('more noise');
  });

  test('accumulates owners across repos; the first refusal stops it', async () => {
    const { git } = gitFake((argv) => argv.includes('get-url')
      ? ok('git@github.com:Software-Development-LLC/' + (argv[2] as string).split(/[/\\]/).pop() + '.git') : ok());
    const d = deps({ git, org: null });
    const r = await cutWorktrees(d, { initiative: 'CO-130', repos: [
      { repo: 'bodhi-code', integrationBranch: 'development' },
      { repo: 'bodhi-service-ml', integrationBranch: 'main' },
    ] });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') throw new Error('unreachable');
    expect(Object.keys(r.owners).sort()).toEqual(['bodhi-code', 'bodhi-service-ml']);
    expect(r.owners['bodhi-service-ml'].base).toBe('main');
  });

  test('an empty repo set is refused rather than a silent no-op', async () => {
    const r = await cutWorktrees(deps(), { initiative: 'CO-130', repos: [] });
    expect(r.status).toBe('refused');
  });
});
