import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import { prepareInitiative, reposFromRegistry, type CommandOutput, type PrepareConfig } from '../prepare-initiative';

const ok = (stdout = ''): CommandOutput => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, stdout = ''): CommandOutput => ({ code: 1, stdout, stderr });

const config = (over: Partial<PrepareConfig> = {}): PrepareConfig => ({
  pythonPath: 'python',
  harnessPath: 'C:/harness',
  bodhiRoot: 'C:/work/repos',
  initiativesRoot: 'C:/work/initiatives',
  ...over,
});

describe('reading the repo names from a registry.yaml', () => {
  const text = [
    '# repos: 3',
    'version: 1',
    'repos:',
    '  Bodhilander:',
    '    path: ${BODHI_ROOT}/Bodhilander',
    '  bodhi-code:',
    '    path: ${BODHI_ROOT}/bodhi-code',
    '  MQTTnet:',
    '    path: ${BODHI_ROOT}/MQTTnet',
    'other:',
    '  ignored:',
  ].join('\n');

  test('returns the keys under repos:, in file order', () => {
    expect(reposFromRegistry(text)).toEqual(['Bodhilander', 'bodhi-code', 'MQTTnet']);
  });

  test('does not mistake the nested path: lines or a later top-level map for repos', () => {
    const repos = reposFromRegistry(text);
    expect(repos).not.toContain('path');
    expect(repos).not.toContain('ignored');
  });

  test('a file with no repos block is empty, not a throw', () => {
    expect(reposFromRegistry('version: 1\n')).toEqual([]);
  });
});

describe('preparing an initiative', () => {
  test('refuses, running nothing, when the machine config is not set', async () => {
    let ran = false;
    const io = { run: async () => { ran = true; return ok(); } };
    const result = await prepareInitiative({ issueId: 'BDH-1', repo: 'Bodhilander' }, io, config({
      harnessPath: null, bodhiRoot: null, initiativesRoot: null,
    }));
    expect(ran).toBe(false);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    const whats = result.refusals.map((r) => r.what).join(' | ');
    expect(whats).toContain('harness');
    expect(whats).toContain('workspace root');
    expect(whats).toContain('initiatives');
  });

  test('refuses a bad issue id before running anything', async () => {
    let ran = false;
    const io = { run: async () => { ran = true; return ok(); } };
    const result = await prepareInitiative({ issueId: 'has space', repo: 'Bodhilander' }, io, config());
    expect(ran).toBe(false);
    expect(result.status).toBe('refused');
  });

  test('runs init_task then spawn with the right argv and BODHI_ROOT, and returns the armable dir', async () => {
    const calls: Array<{ exe: string; argv: readonly string[]; env?: Record<string, string> }> = [];
    const io = {
      run: async (exe: string, argv: readonly string[], opts: { env?: Record<string, string> }) => {
        calls.push({ exe, argv, env: opts.env });
        return ok(argv[0].includes('init_task') ? 'wrote team.yaml' : 'worktree created');
      },
    };
    const result = await prepareInitiative({ issueId: 'BDH-239', repo: 'Bodhilander', budgetUsd: 500 }, io, config());

    expect(result.status).toBe('prepared');
    if (result.status !== 'prepared') throw new Error('unreachable');
    expect(result.initiativeDir).toBe(path.join('C:/work/initiatives', 'BDH-239'));
    expect(result.log).toContain('wrote team.yaml');
    expect(result.log).toContain('worktree created');

    expect(calls).toHaveLength(2);
    expect(calls[0].exe).toBe('python');
    expect(calls[0].argv).toEqual([
      'C:/harness/scripts/lib/init_task.py', 'BDH-239', 'Bodhilander', '--dir', 'C:/work/initiatives', '--budget', '500',
    ]);
    expect(calls[1].argv).toEqual([
      'C:/harness/scripts/lib/spawn.py', path.join('C:/work/initiatives', 'BDH-239'),
    ]);
    // spawn.py reads the workspace from BODHI_ROOT.
    expect(calls[1].env).toEqual({ BODHI_ROOT: 'C:/work/repos' });
  });

  test('omits --budget when none is given', async () => {
    const calls: Array<readonly string[]> = [];
    const io = { run: async (_e: string, argv: readonly string[]) => { calls.push(argv); return ok(); } };
    await prepareInitiative({ issueId: 'BDH-1', repo: 'Bodhilander' }, io, config());
    expect(calls[0]).not.toContain('--budget');
  });

  test('a failed init_task refuses with the script message and never spawns', async () => {
    let spawned = false;
    const io = {
      run: async (_e: string, argv: readonly string[]) => {
        if (argv[0].includes('spawn')) { spawned = true; return ok(); }
        return fail('init-task: Bodhilanderr is not in registry.yaml');
      },
    };
    const result = await prepareInitiative({ issueId: 'BDH-1', repo: 'Bodhilanderr' }, io, config());
    expect(spawned).toBe(false);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals[0].fix).toContain('not in registry.yaml');
  });

  test('a failed spawn refuses and keeps both scripts\u2019 output in the log', async () => {
    const io = {
      run: async (_e: string, argv: readonly string[]) =>
        argv[0].includes('spawn')
          ? fail('FAIL Bodhilander clone not present in BODHI_ROOT', 'checking worktrees')
          : ok('wrote team.yaml'),
    };
    const result = await prepareInitiative({ issueId: 'BDH-1', repo: 'Bodhilander' }, io, config());
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals[0].fix).toContain('clone not present');
    expect(result.log).toContain('wrote team.yaml');
    expect(result.log).toContain('clone not present');
  });
});
