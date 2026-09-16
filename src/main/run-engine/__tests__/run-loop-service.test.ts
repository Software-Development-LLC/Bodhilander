/**
 * Service-layer tests for the permission inbox (CO-722 multi-owner, #288).
 *
 * The property that matters: answering ONE owner's permission reaches only that
 * owner's gate and drives only that owner's track. Two repos can be blocked at
 * gate 4 at once (both run the verifier), so a reply that went to the wrong one
 * would unblock a repo nobody looked at.
 *
 * A real in-memory database (so activeGate/ownerState are the shipped queries),
 * with the disk channel and the driver faked -- the wiring under test is which
 * repo those are called with, not the fs or the state machine.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';

let db: Database;
const advanceCalls: { runId: string; repo: string; kind: string }[] = [];
let pending: (gate: unknown) => { toolUseId: string; toolName: string; input: unknown; askedAt: string }[];
let wrote = true;

mock.module('electron', () => ({ app: { getPath: () => '/nonexistent-userdata', isPackaged: false, getAppPath: () => '/app' } }));
mock.module('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));
mock.module('../../database', () => ({ getDatabase: () => db }));
mock.module('../driver', () => ({
  advance: async (runId: string, repo: string, event: { kind: string }) => {
    advanceCalls.push({ runId, repo, kind: event.kind });
    return { state: 'running', applied: [event], problems: [], notifications: [], released: false, runaway: null };
  },
  // Imported by run-loop-service for the loop's startOwner dep; not exercised
  // by these permission tests, but the export must resolve.
  startOwnerGate: async () => ({ state: 'running', applied: [], problems: [], notifications: [], released: false, runaway: null }),
}));
mock.module('../gate-spawner', () => ({
  agentsForOwner: async () => ({ agents: {}, notes: [] }),
  targetFor: () => ({}),
  spawnGateFor: () => async () => ({ status: 'launched', backgroundId: '1', sessionId: 's', durationMs: 1 }),
  // Imported (transitively, via bootstrap-arch) by run-loop-service; the export
  // must resolve even though these permission tests never launch a gate.
  channelKeyFor: (runId: string, repo: string, gate: number, agent: string, attempt: number) =>
    `${runId}-${repo}-g${gate}-${agent}-a${attempt}`,
}));
mock.module('../permission-inbox', () => ({
  pendingRequests: (_root: string, _runId: string, gate: unknown) => (gate ? pending(gate) : []),
  writeDecision: () => wrote,
}));

const runs = await import('../../repositories/runs');
const { RUN_TABLES_SQL } = await import('../../run-tables-sql');
const { SCOPE_REPO } = await import('../bootstrap');
const service = await import('../run-loop-service');

function seedTwoBlockedOwners(): void {
  db = new Database(':memory:');
  db.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);');
  db.exec(RUN_TABLES_SQL);
  runs.createRun({
    id: 'run-1', initiativeKey: 'BDH-239', initiativeDir: 'C:/i',
    harnessPath: 'C:/h', bodhiRoot: 'C:/r', pythonPath: null, permissionPosture: 'manual',
  });
  for (const repo of ['repo-a', 'repo-b']) {
    runs.upsertOwner({
      runId: 'run-1', repo, worktree: `C:/wt-${repo}`, branch: 'b', base: 'origin/development',
      scratch: null, agent: 'verifier', status: 'pending', prNumber: null, prUrl: null,
    });
    db.prepare('UPDATE run_owners SET state = ? WHERE run_id = ? AND repo = ?').run('waitingPermission', 'run-1', repo);
    // Each owner has its own gate 4 in flight (both the verifier).
    runs.startGate({ id: `g4-${repo}`, runId: 'run-1', repo, gate: 4, agent: 'verifier', posture: 'manual' });
  }
}

beforeEach(() => {
  advanceCalls.length = 0;
  wrote = true;
  pending = () => [{ toolUseId: 't1', toolName: 'Bash', input: { command: 'x' }, askedAt: '2026-09-15T00:00:00Z' }];
  seedTwoBlockedOwners();
});

describe('listing every owner\u2019s pending permission', () => {
  test('tags each request with the repo it belongs to', () => {
    const list = service.listRunPermissions('C:/ud', 'run-1');
    expect(list.map((r) => r.repo).sort()).toEqual(['repo-a', 'repo-b']);
  });
});

describe('a cross-repo run driving arch surfaces its gate-1 permission', () => {
  function seedArchitecting(): void {
    db = new Database(':memory:');
    db.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);');
    db.exec(RUN_TABLES_SQL);
    runs.createRun({
      id: 'run-2', initiativeKey: 'BWA-1', initiativeDir: 'C:/i',
      harnessPath: 'C:/h', bodhiRoot: 'C:/r', pythonPath: null, permissionPosture: 'manual',
      kind: 'multi', bootstrapState: 'architecting', scopeRepos: ['a', 'b'],
    });
    // The arch gate row: no owner, keyed on the scope sentinel.
    runs.startGate({ id: 'g1', runId: 'run-2', repo: SCOPE_REPO, gate: 1, agent: 'arch', posture: 'manual' });
  }

  test('lists the arch request tagged with the scope sentinel', () => {
    seedArchitecting();
    const list = service.listRunPermissions('C:/ud', 'run-2');
    // No owners yet, so the arch channel is the only source -- and if it were
    // not read here, a person would have no way to unblock the blocked lane.
    expect(list.map((r) => r.repo)).toEqual([SCOPE_REPO]);
  });

  test('answering it writes the reply and advances no owner (arch is not per-owner-driven)', async () => {
    seedArchitecting();
    const ok = await service.answerRunPermission('C:/ud', 'run-2', SCOPE_REPO, 't1', 'allow', '');
    expect(ok).toBe(true);
    expect(advanceCalls).toEqual([]);
  });
});

describe('answering one owner\u2019s permission', () => {
  test('advances only that owner\u2019s track, not the other', async () => {
    const ok = await service.answerRunPermission('C:/ud', 'run-1', 'repo-a', 't1', 'allow', '');
    expect(ok).toBe(true);
    // The whole point: repo-a advanced, repo-b untouched.
    expect(advanceCalls).toEqual([{ runId: 'run-1', repo: 'repo-a', kind: 'permissionAnswered' }]);
  });

  test('a request that was not there to answer advances nobody', async () => {
    wrote = false;
    const ok = await service.answerRunPermission('C:/ud', 'run-1', 'repo-a', 'gone', 'allow', '');
    expect(ok).toBe(false);
    expect(advanceCalls).toEqual([]);
  });

  test('an owner not waiting on permission is not advanced, even if the reply is written', async () => {
    db.prepare('UPDATE run_owners SET state = ? WHERE run_id = ? AND repo = ?').run('running', 'run-1', 'repo-a');
    await service.answerRunPermission('C:/ud', 'run-1', 'repo-a', 't1', 'allow', '');
    expect(advanceCalls).toEqual([]);
  });
});
