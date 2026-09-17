/**
 * Provisioning tests (CO-722, Phase 3 — the TS replacement for provision.py).
 *
 * The policy that matters: a config `provision` command runs in the owner's
 * worktree; no command owed is provisioned (not a fault); a non-zero exit is a
 * failed install; a missing worktree is undriveable — the 0/1/2 the executor
 * maps through provisionEvent. The owners, the per-repo command and the shell
 * runner are injected, so no real install runs.
 *
 * Run with: bun test src/main/run-engine/__tests__/provision.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { provisionRun, type ProvisionDeps, type ProvisionOwner } from '../provision';
import type { CommandResult } from '../reconcile';

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

function deps(over: Partial<ProvisionDeps> & { owners?: ProvisionOwner[]; commands?: Record<string, string> } = {}) {
  const ran: { command: string; cwd: string }[] = [];
  const commands = over.commands ?? {};
  const d: ProvisionDeps = {
    owners: () => over.owners ?? [{ repo: 'bodhi-code', worktree: 'C:/root/_wt-co-130-code' }],
    commandFor: over.commandFor ?? ((repo) => commands[repo] ?? null),
    run: over.run ?? (async (command, cwd) => { ran.push({ command, cwd }); return ok(); }),
    log: over.log ?? (() => {}),
  };
  return { deps: d, ran };
}

describe('provisionRun', () => {
  test('runs the config command in the owner worktree and reports provisioned', async () => {
    const { deps: d, ran } = deps({ commands: { 'bodhi-code': 'bun install' } });
    const r = await provisionRun(d);
    expect(r.code).toBe(0);
    expect(ran).toEqual([{ command: 'bun install', cwd: 'C:/root/_wt-co-130-code' }]);
  });

  test('a repo that declares no command owes nothing (provisioned, no run)', async () => {
    const { deps: d, ran } = deps({ commands: {} });
    const r = await provisionRun(d);
    expect(r.code).toBe(0);
    expect(ran).toEqual([]);
    expect(r.log).toContain('nothing to provision');
  });

  test('a non-zero exit is a failed install carrying its first line', async () => {
    const { deps: d } = deps({
      commands: { 'bodhi-code': 'bun install' },
      run: async () => ({ code: 1, stdout: '', stderr: 'error: lockfile out of date\ntrace' }),
    });
    const r = await provisionRun(d);
    expect(r.code).toBe(1);
    expect(r.log).toContain('lockfile out of date');
    expect(r.log).not.toContain('trace');
  });

  test('a missing worktree is undriveable, not a failed install', async () => {
    const { deps: d } = deps({ owners: [{ repo: 'bodhi-code', worktree: '' }], commands: { 'bodhi-code': 'bun install' } });
    const r = await provisionRun(d);
    expect(r.code).toBe(2);
    expect(r.log).toContain('no worktree');
  });

  test('provisions every owner, stopping at the first failure', async () => {
    let calls = 0;
    const { deps: d } = deps({
      owners: [
        { repo: 'bodhi-code', worktree: 'C:/wt-a' },
        { repo: 'bodhi-service-ml', worktree: 'C:/wt-b' },
        { repo: 'bodhi-service-api', worktree: 'C:/wt-c' },
      ],
      commands: { 'bodhi-code': 'bun install', 'bodhi-service-ml': 'poetry install', 'bodhi-service-api': 'bun install' },
      run: async () => { calls += 1; return calls === 2 ? { code: 1, stdout: '', stderr: 'boom' } : ok(); },
    });
    const r = await provisionRun(d);
    expect(r.code).toBe(1);
    expect(calls).toBe(2); // stopped at the second owner, never ran the third
    expect(r.log).toContain('bodhi-service-ml');
  });

  test('a run with no owners is provisioned (nothing owed)', async () => {
    const { deps: d, ran } = deps({ owners: [] });
    const r = await provisionRun(d);
    expect(r.code).toBe(0);
    expect(ran).toEqual([]);
  });
});
