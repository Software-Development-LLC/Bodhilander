import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import type { IgnitionRequest, IgnitionResult } from '../ignition';
import { armInitiative, harnessFromTeamYaml } from '../arm-run';

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

describe('arming an initiative directory', () => {
  const okArm = async (req: IgnitionRequest): Promise<IgnitionResult> => ({
    status: 'armed', runId: 'r1', initiativeKey: 'BDH-239', owners: { Bodhilander: 'bodhilander-lead' },
  });

  test('hands armRun the harness from team.yaml and the repo root beside it', async () => {
    let seen: IgnitionRequest | null = null;
    let readPath: string | null = null;
    const io = {
      readFile: (p: string) => {
        readPath = p;
        return 'initiative: BDH-239\nharness: C:/work/repos/claude-team-workflow\n';
      },
    };
    const result = await armInitiative('C:/init/BDH-239', io, async (req) => { seen = req; return okArm(req); }, {
      pythonPath: 'python',
      ghPath: 'gh',
    });
    // It reads the initiative's OWN team.yaml, not app settings.
    expect(readPath).toBe(path.join('C:/init/BDH-239', 'team.yaml'));
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
