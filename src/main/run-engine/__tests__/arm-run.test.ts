import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import type { IgnitionRequest, IgnitionResult } from '../ignition';
import { armInitiative, harnessFromTeamYaml, mergeOrderFromSeams } from '../arm-run';

describe('the harness a team.yaml pins the run to', () => {
  test('is read from a flat harness: line', () => {
    expect(harnessFromTeamYaml('initiative: BDH-239\nharness: C:\\work\\repos\\claude-team-workflow\n')).toBe(
      'C:\\work\\repos\\claude-team-workflow',
    );
  });

  test('a quoted path is unquoted, because the raw value is what --plugin-dir takes', () => {
    expect(harnessFromTeamYaml('harness: "C:/a b/harness"')).toBe('C:/a b/harness');
  });

  test('a mismatched quote pair is left intact rather than trimmed to nonsense', () => {
    // A leading " with a trailing ' is not a quoted string; stripping both
    // would silently corrupt the path, so neither is removed.
    expect(harnessFromTeamYaml("harness: \"C:/weird'")).toBe("\"C:/weird'");
  });

  test('no harness line is null, not an empty string', () => {
    expect(harnessFromTeamYaml('initiative: X\nowners: {}')).toBeNull();
    expect(harnessFromTeamYaml('harness:   ')).toBeNull();
  });
});

describe('the merge order a seams.yaml declares', () => {
  test('reads the block form init-task writes', () => {
    const seams = 'initiative: X\nmerge_order:\n  - repo-a\n  - repo-b\n  - repo-c\nseams: []\n';
    expect(mergeOrderFromSeams(seams)).toEqual(['repo-a', 'repo-b', 'repo-c']);
  });

  test('reads the flow form', () => {
    expect(mergeOrderFromSeams('merge_order: [a, b, c]\n')).toEqual(['a', 'b', 'c']);
  });

  test('stops the block list at the next key, and is empty when there is no merge_order', () => {
    const seams = 'merge_order:\n  - only-repo\nseams: []\nowners: {}\n';
    expect(mergeOrderFromSeams(seams)).toEqual(['only-repo']);
    expect(mergeOrderFromSeams('initiative: X\nseams: []\n')).toEqual([]);
  });
});

describe('arming an initiative directory', () => {
  const okArm = async (req: IgnitionRequest): Promise<IgnitionResult> => ({
    status: 'armed', runId: 'r1', initiativeKey: 'BDH-239', owners: { Bodhilander: 'bodhilander-lead' },
    mergeOrder: [...(req.mergeOrder ?? [])],
  });

  test('hands armRun the harness from team.yaml and the repo root beside it', async () => {
    let seen: IgnitionRequest | null = null;
    const readPaths: string[] = [];
    const io = {
      readFile: (p: string) => {
        readPaths.push(p);
        return 'initiative: BDH-239\nharness: C:/work/repos/claude-team-workflow\n';
      },
    };
    const result = await armInitiative('C:/init/BDH-239', io, async (req) => { seen = req; return okArm(req); }, {
      pythonPath: 'python',
      ghPath: 'gh',
    });
    // It reads the initiative's OWN team.yaml (and its seams.yaml for the merge
    // order), not app settings.
    expect(readPaths).toContain(path.join('C:/init/BDH-239', 'team.yaml'));
    expect(readPaths).toContain(path.join('C:/init/BDH-239', 'seams.yaml'));
    expect(result.status).toBe('armed');
    expect(seen).toMatchObject({
      initiativePath: 'C:/init/BDH-239',
      harnessPath: 'C:/work/repos/claude-team-workflow',
      // The harness clone sits beside the other repos.
      bodhiRoot: 'C:/work/repos',
      posture: 'manual',
      owners: {},
    });
  });

  test('carries the merge order from seams.yaml into the arm request', async () => {
    let seen: IgnitionRequest | null = null;
    const io = {
      readFile: (p: string) =>
        p.endsWith('team.yaml')
          ? 'initiative: BDH-239\nharness: C:/h\n'
          : 'merge_order:\n  - repo-a\n  - repo-b\nseams: []\n',
    };
    await armInitiative('C:/init', io, async (req) => { seen = req; return okArm(req); }, {
      pythonPath: 'python', ghPath: 'gh',
    });
    expect(seen?.mergeOrder).toEqual(['repo-a', 'repo-b']);
  });

  test('a directory with no team.yaml is refused with a fixable reason, not a throw', async () => {
    const io = { readFile: () => null };
    const result = await armInitiative('C:/not/an/initiative', io, async () => okArm({} as IgnitionRequest), {
      pythonPath: 'python',
      ghPath: 'gh',
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals[0].what).toContain('no team.yaml');
    expect(result.refusals[0].fix).toContain('spawn.sh');
  });

  test('a team.yaml with no harness is refused, naming the file', async () => {
    const io = { readFile: () => 'initiative: BDH-239\nowners: {}\n' };
    const result = await armInitiative('C:/init/BDH-239', io, async () => okArm({} as IgnitionRequest), {
      pythonPath: 'python',
      ghPath: 'gh',
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals[0].what).toContain('declares no harness');
  });

  test("armRun's own refusal is passed straight through", async () => {
    // A prepared directory whose machine armRun does not like: the person
    // sees the full list, not a wrapper's summary of it.
    const io = { readFile: () => 'harness: C:/h\n' };
    const result = await armInitiative('C:/init', io, async () => ({
      status: 'refused', refusals: [{ what: 'python did not run', fix: 'Install Python' }],
    }), { pythonPath: 'python', ghPath: 'gh' });
    expect(result).toEqual({ status: 'refused', refusals: [{ what: 'python did not run', fix: 'Install Python' }] });
  });
});
