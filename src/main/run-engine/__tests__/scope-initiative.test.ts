/**
 * Mechanical gate 0 for a cross-repo run (CO-722).
 *
 * The properties that matter: it writes an owners.yaml the harness accepts (no
 * stamped keys, a brief per pick), calls file_scope.py with the run's own issue
 * and initiatives root, resumes cleanly when team.yaml already exists, and turns
 * a script failure into a one-line reason rather than a throw.
 *
 * Run with: bun test src/main/run-engine/__tests__/scope-initiative.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import type { RunRow } from '../../repositories/runs';
import { ownersYaml, scopeInitiative, type ScopeIo } from '../scope-initiative';
import type { CommandOutput } from '../prepare-initiative';

function multiRun(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 'r1', initiativeKey: 'BWA-4764', initiativeDir: path.join('C:/root/initiatives', 'BWA-4764-thing'),
    harnessPath: 'C:/h', bodhiRoot: 'C:/root', pythonPath: 'py', state: 'preparing',
    permissionPosture: 'manual', budgetUsd: null, groupId: null, blockedReason: null,
    kind: 'multi', bootstrapState: 'scoping', scopeRepos: ['bodhi-service-api', 'bodhi-web-apps'],
    createdAt: new Date(), updatedAt: new Date(), ...over,
  } as RunRow;
}

interface Rec { runArgs: { exe: string; argv: readonly string[] }[]; writes: Record<string, string>; }

function io(over: {
  code?: number; stderr?: string; stdout?: string; existing?: Record<string, string>;
} = {}): { io: ScopeIo; rec: Rec } {
  const rec: Rec = { runArgs: [], writes: {} };
  const existing = over.existing ?? {};
  const ioObj: ScopeIo = {
    run: async (exe, argv): Promise<CommandOutput> => {
      rec.runArgs.push({ exe, argv });
      return { code: over.code ?? 0, stdout: over.stdout ?? '', stderr: over.stderr ?? '' };
    },
    readFile: (p) => (p in existing ? existing[p] : rec.writes[p] ?? (existing[p] ?? null)),
    writeFile: (p, text) => { rec.writes[p] = text; },
  };
  return { io: ioObj, rec };
}

describe('ownersYaml', () => {
  test('a brief per repo, none of the keys spawn.py stamps', () => {
    const text = ownersYaml(['a', 'b'], 'BDH-9');
    expect(text).toContain('a:');
    expect(text).toContain('b:');
    expect(text).toContain('what_to_do:');
    expect(text).toContain('BDH-9');
    for (const stamped of ['worktree:', 'branch:', 'base:', 'scratch:']) {
      expect(text).not.toContain(stamped);
    }
  });
});

describe('scopeInitiative', () => {
  test('writes owners.yaml beside the initiative and runs file_scope with --dir', async () => {
    const { io: i, rec } = io();
    const result = await scopeInitiative(multiRun(), i);
    expect(result.status).toBe('scoped');

    const ownersPath = path.join('C:/root/initiatives', 'BWA-4764-thing.owners.yaml');
    expect(rec.writes[ownersPath]).toContain('bodhi-service-api:');
    expect(rec.runArgs).toHaveLength(1);
    const { exe, argv } = rec.runArgs[0];
    expect(exe).toBe('py');
    expect(argv[0]).toBe(path.join('C:/h', 'scripts', 'lib', 'file_scope.py'));
    expect(argv).toContain('BWA-4764-thing'); // the issue id (folder name), not the key
    expect(argv).toContain(ownersPath);
    expect(argv).toContain('--dir');
    expect(argv).toContain('C:/root/initiatives'.replace(/\//g, path.sep));
  });

  test('resumes without re-running file_scope when team.yaml already exists', async () => {
    const teamPath = path.join('C:/root/initiatives', 'BWA-4764-thing', 'team.yaml');
    const { io: i, rec } = io({ existing: { [teamPath]: 'initiative: BWA-4764\n' } });
    const result = await scopeInitiative(multiRun(), i);
    expect(result.status).toBe('scoped');
    // file_scope refuses to overwrite; a resume must not call it.
    expect(rec.runArgs).toHaveLength(0);
  });

  test('turns a file_scope failure into a one-line reason', async () => {
    const { io: i } = io({ code: 1, stderr: 'file-scope: bodhi-foo is not in registry.yaml\ntraceback...' });
    const result = await scopeInitiative(multiRun(), i);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.reason).toBe('file-scope: bodhi-foo is not in registry.yaml');
  });

  test('refuses a run with no recorded repos rather than writing an empty scope', async () => {
    const { io: i, rec } = io();
    const result = await scopeInitiative(multiRun({ scopeRepos: [] }), i);
    expect(result.status).toBe('refused');
    expect(rec.runArgs).toHaveLength(0);
  });
});
