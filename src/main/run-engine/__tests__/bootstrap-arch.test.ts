/**
 * The arch gate for a cross-repo run (CO-722).
 *
 * The properties that matter, because arch's verdict authorises spawning a whole
 * initiative's worktrees:
 *  - it opens the gate row keyed on the scope sentinel and launches print mode
 *    in the workspace root (no worktree exists yet), on a channel a person can
 *    find;
 *  - the verdict is the FILE plus the harness verifier -- a pass with no
 *    seams.yaml, or one verify_seams rejects, is inconclusive, never a park;
 *  - it resumes without re-running the gate when the manifest already exists.
 *
 * Run with: bun test src/main/run-engine/__tests__/bootstrap-arch.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import type { RunGateRow, RunRow, StartGateInput } from '../../repositories/runs';
import type { GateLaunch } from '../gate-launcher';
import type { GateOutcome } from '../gate-process';
import type { CommandOutput } from '../prepare-initiative';
import { runArchGate, type ArchDeps } from '../bootstrap-arch';
import { SCOPE_REPO } from '../bootstrap';
import { channelKeyFor } from '../gate-spawner';

function run(): RunRow {
  return {
    id: 'r1', initiativeKey: 'BWA-4764', initiativeDir: path.join('C:/root/initiatives', 'BWA-4764'),
    harnessPath: 'C:/h', bodhiRoot: 'C:/root', pythonPath: 'py', state: 'preparing',
    permissionPosture: 'manual', budgetUsd: null, groupId: null, blockedReason: null,
    kind: 'multi', bootstrapState: 'architecting', scopeRepos: ['a', 'b'],
    createdAt: new Date(), updatedAt: new Date(),
  } as RunRow;
}

const pass: GateOutcome = { status: 'completed', structuredOutput: { verdict: 'pass', summary: 'ok', blocking: [] }, sessionId: 's', costUsd: null, durationMs: 1 };
const fail: GateOutcome = { status: 'completed', structuredOutput: { verdict: 'fail', summary: 'no producer dto', blocking: [{ what: 'seam scan-nameplate has no producer' }] }, sessionId: 's', costUsd: null, durationMs: 1 };
const undriveable: GateOutcome = { status: 'undriveable', reason: 'timed out', detail: null, durationMs: 1 };

interface Rec {
  started: StartGateInput[];
  finished: { id: string; status: string; verdict?: unknown }[];
  launched: GateLaunch[];
  verifyRuns: { exe: string; argv: readonly string[] }[];
}

interface Opts {
  outcome?: GateOutcome;
  /** Whether launching arch causes seams.yaml to appear (arch wrote it). */
  writesSeams?: boolean;
  /** seams.yaml already on disk before the gate runs (a resume). */
  seamsPresent?: boolean;
  verifyCode?: number;
  verifyStderr?: string;
}

function harness(opts: Opts = {}): { deps: ArchDeps; rec: Rec } {
  const rec: Rec = { started: [], finished: [], launched: [], verifyRuns: [] };
  let seams = opts.seamsPresent ?? false;
  const gateRow = (): RunGateRow => ({
    id: 'gate-1', runId: 'r1', repo: SCOPE_REPO, gate: 1, agent: 'arch', attempt: 1,
    bgSessionId: null, claudeSessionId: null, status: 'running', verdictJson: null,
    posture: 'manual', startedAt: '2026-09-16 00:00:00',
  } as RunGateRow);
  const deps: ArchDeps = {
    startGate: (input) => { rec.started.push(input); },
    activeGate: () => (rec.started.length > 0 ? gateRow() : null),
    finishGate: (id, status, verdict) => { rec.finished.push({ id, status, verdict }); },
    launch: async (launch) => {
      rec.launched.push(launch);
      if (opts.writesSeams) seams = true;
      return opts.outcome ?? pass;
    },
    run: async (exe, argv): Promise<CommandOutput> => {
      rec.verifyRuns.push({ exe, argv });
      return { code: opts.verifyCode ?? 0, stdout: '', stderr: opts.verifyStderr ?? '' };
    },
    readFile: () => (seams ? 'initiative: BWA-4764\nseams: []\n' : null),
    config: { claudePath: 'claude', promptFileDir: 'C:/pf', permissionsRoot: 'C:/perm', brokerPath: 'C:/b/broker.js', gateTimeoutMs: 1800000 },
    newId: () => 'new-id',
    log: () => {},
  };
  return { deps, rec };
}

describe('the happy path', () => {
  test('launches print in the workspace root and parks when it verifies', async () => {
    const { deps, rec } = harness({ outcome: pass, writesSeams: true, verifyCode: 0 });
    const result = await runArchGate(run(), deps);
    expect(result).toEqual({ status: 'parked' });

    // Opened the gate row on the scope sentinel, before the launch.
    expect(rec.started).toHaveLength(1);
    expect(rec.started[0]).toMatchObject({ runId: 'r1', gate: 1, repo: SCOPE_REPO, agent: 'arch' });

    const launch = rec.launched[0];
    expect(launch.mode).toBe('print');
    expect(launch.gate).toBe(1);
    expect(launch.context.cwd).toBe('C:/root'); // no worktree yet
    expect(launch.permissions?.channelKey).toBe(channelKeyFor('r1', SCOPE_REPO, 1, 'arch', 1));

    // Verdict recorded, then the harness verifier run against seams.yaml.
    expect(rec.finished[0].status).toBe('done');
    expect(rec.verifyRuns).toHaveLength(1);
    expect(rec.verifyRuns[0].argv[0]).toBe(path.join('C:/h', 'scripts', 'lib', 'verify_seams.py'));
    expect(rec.verifyRuns[0].argv[1]).toBe(path.join('C:/root/initiatives', 'BWA-4764', 'seams.yaml'));
  });
});

describe('a verdict from nobody never parks', () => {
  test('undriveable is inconclusive, and the gate row is closed as undriveable', async () => {
    const { deps, rec } = harness({ outcome: undriveable });
    const result = await runArchGate(run(), deps);
    expect(result).toEqual({ status: 'inconclusive', reason: 'arch could not run: timed out' });
    expect(rec.finished[0].status).toBe('undriveable');
    expect(rec.verifyRuns).toHaveLength(0); // never verified a manifest that may not exist
  });

  test('a fail verdict is inconclusive, with the reason, and does not verify', async () => {
    const { deps, rec } = harness({ outcome: fail, writesSeams: true });
    const result = await runArchGate(run(), deps);
    expect(result.status).toBe('inconclusive');
    if (result.status !== 'inconclusive') throw new Error('unreachable');
    expect(result.reason).toContain('no producer dto');
    expect(rec.finished[0].status).toBe('done');
    expect(rec.verifyRuns).toHaveLength(0);
  });

  test('a pass with no seams.yaml is inconclusive, not a park', async () => {
    const { deps, rec } = harness({ outcome: pass, writesSeams: false });
    const result = await runArchGate(run(), deps);
    expect(result).toEqual({ status: 'inconclusive', reason: 'arch reported pass but wrote no seams.yaml' });
    expect(rec.verifyRuns).toHaveLength(0);
  });

  test('a manifest the verifier rejects is inconclusive, with its first line', async () => {
    const { deps } = harness({ outcome: pass, writesSeams: true, verifyCode: 1, verifyStderr: 'verify-seams: FAIL scan-nameplate producer dto missing imageRef\ntrace...' });
    const result = await runArchGate(run(), deps);
    expect(result.status).toBe('inconclusive');
    if (result.status !== 'inconclusive') throw new Error('unreachable');
    expect(result.reason).toBe('verify-seams: FAIL scan-nameplate producer dto missing imageRef');
  });
});

describe('resume', () => {
  test('an existing seams.yaml re-verifies without re-running the gate', async () => {
    const { deps, rec } = harness({ seamsPresent: true, verifyCode: 0 });
    const result = await runArchGate(run(), deps);
    expect(result).toEqual({ status: 'parked' });
    // The gate was not re-opened or re-launched; only re-verified.
    expect(rec.started).toHaveLength(0);
    expect(rec.launched).toHaveLength(0);
    expect(rec.verifyRuns).toHaveLength(1);
  });
});
