import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RunGateRow, RunOwnerRow, RunRow } from '../../repositories/runs';
import { agentsForOwner, channelKeyFor, defaultModeFor, spawnGateFor, targetFor } from '../gate-spawner';

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function harness(agents: Record<string, { gate?: string; gateOrder?: string; staff?: boolean }>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'spawner-harness-'));
  made.push(root);
  await fs.mkdir(path.join(root, 'agents', 'staff'), { recursive: true });
  for (const [name, a] of Object.entries(agents)) {
    const front = ['---', `name: ${name}`, ...(a.gate ? [`gate: ${a.gate}`] : []), ...(a.gateOrder ? [`gate_order: ${a.gateOrder}`] : []), 'tools: Read', '---', '', '# Purpose', ''].join('\n');
    await fs.writeFile(path.join(root, 'agents', a.staff ? 'staff' : '', `${name}.md`), front);
  }
  return root;
}

const run = (harnessPath: string): RunRow =>
  ({
    id: 'run-1', initiativeKey: 'BDH-239', initiativeDir: 'C:/init', harnessPath, bodhiRoot: 'C:/r', pythonPath: null,
    state: 'running', permissionPosture: 'manual', budgetUsd: null, groupId: null, blockedReason: null, createdAt: new Date(),
  }) as RunRow;

const OWNER: RunOwnerRow = {
  runId: 'run-1', repo: 'Bodhilander', worktree: 'C:/wt', branch: 'feat/x', base: 'origin/development', scratch: null,
  agent: 'bodhilander-lead', status: 'pending', prNumber: null, prUrl: null,
};

describe('which role serves which gate of a run', () => {
  test('gate 2 is the owner’s; 3 and 4 are read from the harness, 4 in run order', async () => {
    const root = await harness({
      reviewer: { gate: '3' }, verifier: { gate: '4', gateOrder: '1' }, scribe: { gate: '0,4', gateOrder: '2' },
      'bodhilander-lead': { staff: true },
    });
    const { agents, notes } = await agentsForOwner(run(root), OWNER);
    expect(agents).toEqual({ 2: ['bodhilander-lead'], 3: ['reviewer'], 4: ['verifier', 'scribe'] });
    expect(notes).toEqual(['gate 4 runs verifier then scribe']);
  });

  test('what the harness does not declare is a note, not a silence', async () => {
    const root = await harness({ reviewer: { gate: '3' } });
    const { agents, notes } = await agentsForOwner(run(root), OWNER);
    expect(agents[4]).toBeUndefined();
    expect(notes).toContain('no agent in this harness declares gate 4');
  });
});

describe('the run as the executor’s target', () => {
  test('the PR and its repository come from the owner’s recorded URL', () => {
    const t = targetFor(run('C:/h'), { ...OWNER, prNumber: 299, prUrl: 'https://github.com/Software-Development-LLC/Bodhilander/pull/299' }, {}, ['brannon-bowden']);
    expect(t.repo).toBe('Software-Development-LLC/Bodhilander');
    expect(t.prNumber).toBe(299);
    expect(t.approvers).toEqual(['brannon-bowden']);
  });

  test('before a PR exists, the target says so with nulls rather than empty strings', () => {
    // The console used '' and 0, and the executor's guard reads null. An
    // empty string is not "no PR"; it is a repo named "".
    const t = targetFor(run('C:/h'), OWNER, {}, []);
    expect(t.repo).toBeNull();
    expect(t.prNumber).toBeNull();
  });
});

describe('the spawner’s one refusal', () => {
  test('a spawn whose open row is not the one the driver opened is refused, naming both', async () => {
    const other: RunGateRow = {
      id: 'x', runId: 'run-1', repo: 'Bodhilander', gate: 3, agent: 'reviewer', attempt: 1, bgSessionId: null, claudeSessionId: null,
      status: 'running', verdictJson: null, posture: 'manual', startedAt: '2026-09-15 00:00:00',
    };
    const spawn = spawnGateFor(run('C:/h'), OWNER, {
      claudePath: 'claude', promptFileDir: 'C:/p', permissionsRoot: 'C:/perm', brokerPath: 'C:/b.js', gateTimeoutMs: 1000,
    }, () => other);
    await expect(spawn(2, 'bodhilander-lead')).rejects.toThrow('gate 2 (bodhilander-lead) for Bodhilander was asked to launch but the open run_gates row is gate 3 (reviewer) for Bodhilander');
  });

  test('a missing row is refused too, because a default attempt is a shared channel', async () => {
    const spawn = spawnGateFor(run('C:/h'), OWNER, {
      claudePath: 'claude', promptFileDir: 'C:/p', permissionsRoot: 'C:/perm', brokerPath: 'C:/b.js', gateTimeoutMs: 1000,
    }, () => null);
    await expect(spawn(2, 'bodhilander-lead')).rejects.toThrow('is missing');
  });
});

describe('defaults the console used to read from the environment', () => {
  test('gate 2 is background; the reading gates are print', () => {
    expect(defaultModeFor(2)).toBe('background');
    expect(defaultModeFor(3)).toBe('print');
    expect(defaultModeFor(4)).toBe('print');
  });

  test('a channel key names run, repo, gate, role and attempt', () => {
    // The verifier and the scribe are both gate 4; a retry must not inherit
    // its predecessor's requests.
    expect(channelKeyFor('run-1', 'Bodhilander', 4, 'scribe', 2)).toBe('run-1-Bodhilander-g4-scribe-a2');
    expect(channelKeyFor('run-1', 'Bodhilander', 4, 'verifier', 2)).not.toBe(channelKeyFor('run-1', 'Bodhilander', 4, 'scribe', 2));
    // Two owners at the same gate/role do not share a channel.
    expect(channelKeyFor('run-1', 'repo-a', 4, 'verifier', 1)).not.toBe(channelKeyFor('run-1', 'repo-b', 4, 'verifier', 1));
  });
});
