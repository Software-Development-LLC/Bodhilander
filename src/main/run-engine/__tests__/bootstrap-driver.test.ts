/**
 * The cross-repo bootstrap sub-driver (CO-722).
 *
 * It drives one durable step per pass and advances `bootstrap_state`, staying
 * out of the pure per-owner machine. This slice implements `scoping`; the later
 * states are benign holds. The properties that matter: scoping advances to
 * `architecting` and records the event, a scope refusal parks the run
 * inconclusive (never a silent failure), and an unimplemented state does nothing
 * rather than back off.
 *
 * Run with: bun test src/main/run-engine/__tests__/bootstrap-driver.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { RunRow } from '../../repositories/runs';
import type { BootstrapState } from '../bootstrap';
import type { RunState } from '../transitions';
import { driveBootstrap, type BootstrapDeps, type BootstrapStore } from '../bootstrap-driver';
import type { ScopeIo } from '../scope-initiative';
import type { ArchResult } from '../bootstrap-arch';
import type { SpawnResult } from '../bootstrap-spawn';

function multiRun(bootstrapState: BootstrapState | null): RunRow {
  return {
    id: 'r1', initiativeKey: 'BWA-4764', initiativeDir: 'C:/root/initiatives/BWA-4764',
    harnessPath: 'C:/h', bodhiRoot: 'C:/root', pythonPath: 'py', state: 'preparing',
    permissionPosture: 'manual', budgetUsd: null, groupId: null, blockedReason: null,
    kind: 'multi', bootstrapState, scopeRepos: ['a', 'b'], createdAt: new Date(), updatedAt: new Date(),
  } as RunRow;
}

interface StoreRec {
  bootstrap: (BootstrapState | null)[];
  runState: { state: RunState; reason?: string | null }[];
  inconclusive: { reason: string; gate: number }[];
  events: { kind: string; gate?: number }[];
}

function store(): { store: BootstrapStore; rec: StoreRec } {
  const rec: StoreRec = { bootstrap: [], runState: [], inconclusive: [], events: [] };
  return {
    rec,
    store: {
      setBootstrapState: (_id, s) => rec.bootstrap.push(s),
      setRunState: (_id, state, reason) => rec.runState.push({ state, reason }),
      recordInconclusive: (_id, reason, gate) => rec.inconclusive.push({ reason, gate }),
      appendEvent: (_id, kind, gate) => rec.events.push({ kind, gate }),
    },
  };
}

/** A ScopeIo that reports the given file_scope exit; readFile always null (no team.yaml yet). */
function scopeIo(code: number, stderr = ''): ScopeIo {
  return {
    run: async () => ({ code, stdout: '', stderr }),
    readFile: () => null,
    writeFile: () => {},
  };
}

const parked = async (): Promise<ArchResult> => ({ status: 'parked' });
const spawned = async (): Promise<SpawnResult> => ({ status: 'spawned', owners: { a: 'lead' } });

function deps(
  io: ScopeIo,
  s: BootstrapStore,
  arch: (run: RunRow) => Promise<ArchResult> = parked,
  spawn: (run: RunRow) => Promise<SpawnResult> = spawned,
): BootstrapDeps {
  return { io, store: s, arch, spawn, log: () => {} };
}

describe('scoping', () => {
  test('writes the scope, records the event and advances to architecting', async () => {
    const { store: s, rec } = store();
    const result = await driveBootstrap(multiRun('scoping'), deps(scopeIo(0), s));
    expect(result).toEqual({ drove: true, problems: [] });
    expect(rec.events).toEqual([{ kind: 'scoped', gate: 0 }]);
    expect(rec.bootstrap).toEqual(['architecting']);
    expect(rec.inconclusive).toEqual([]);
  });

  test('a scope failure parks the run inconclusive and does not advance', async () => {
    const { store: s, rec } = store();
    const result = await driveBootstrap(
      multiRun('scoping'),
      deps(scopeIo(1, 'file-scope: bodhi-foo is not in registry.yaml'), s),
    );
    expect(result.drove).toBe(true);
    expect(result.problems).toHaveLength(1);
    expect(rec.inconclusive).toEqual([{ reason: 'file-scope: bodhi-foo is not in registry.yaml', gate: 0 }]);
    expect(rec.bootstrap).toEqual([]); // never advanced past scoping
  });
});

describe('architecting drives the arch gate', () => {
  test('a parked manifest advances to awaitingManifest and parks for a person', async () => {
    const { store: s, rec } = store();
    const result = await driveBootstrap(multiRun('architecting'), deps(scopeIo(0), s, async () => ({ status: 'parked' })));
    expect(result).toEqual({ drove: true, problems: [] });
    expect(rec.events).toEqual([{ kind: 'archManifest', gate: 1 }]);
    expect(rec.bootstrap).toEqual(['awaitingManifest']);
    // Parked for approval: waitingHumanGate is not movable, so the loop stops.
    expect(rec.runState).toEqual([{ state: 'waitingHumanGate', reason: undefined }]);
    expect(rec.inconclusive).toEqual([]);
  });

  test('an inconclusive arch parks the run inconclusive and does not advance', async () => {
    const { store: s, rec } = store();
    const result = await driveBootstrap(
      multiRun('architecting'),
      deps(scopeIo(0), s, async () => ({ status: 'inconclusive', reason: 'arch reported pass but wrote no seams.yaml' })),
    );
    expect(result.drove).toBe(true);
    expect(result.problems).toHaveLength(1);
    expect(rec.inconclusive).toEqual([{ reason: 'arch reported pass but wrote no seams.yaml', gate: 1 }]);
    expect(rec.bootstrap).toEqual([]); // never advanced past architecting
    expect(rec.runState).toEqual([]);
  });
});

describe('spawning cuts worktrees and hands off', () => {
  test('a spawned run clears bootstrap_state and drops to preparing', async () => {
    const { store: s, rec } = store();
    const result = await driveBootstrap(
      multiRun('spawning'),
      deps(scopeIo(0), s, parked, async () => ({ status: 'spawned', owners: { a: 'lead', b: 'lead2' } })),
    );
    expect(result).toEqual({ drove: true, problems: [] });
    expect(rec.events).toEqual([{ kind: 'spawned', gate: 2 }]);
    // The handoff: null clears the bootstrap branch, preparing lets the
    // per-owner machine provision on the next pass.
    expect(rec.bootstrap).toEqual([null]);
    expect(rec.runState).toEqual([{ state: 'preparing', reason: undefined }]);
  });

  test('a spawn refusal parks the run inconclusive and does not hand off', async () => {
    const { store: s, rec } = store();
    const result = await driveBootstrap(
      multiRun('spawning'),
      deps(scopeIo(0), s, parked, async () => ({ status: 'refused', reason: 'repo-b has 2 possible owners — Name one' })),
    );
    expect(result.drove).toBe(true);
    expect(result.problems).toHaveLength(1);
    expect(rec.inconclusive).toEqual([{ reason: 'repo-b has 2 possible owners — Name one', gate: 2 }]);
    expect(rec.bootstrap).toEqual([]); // no handoff
  });
});

describe('states this slice does not yet drive are benign holds', () => {
  for (const state of ['awaitingManifest', 'done'] as BootstrapState[]) {
    test(`${state} does nothing and reports no problem`, async () => {
      const { store: s, rec } = store();
      const result = await driveBootstrap(multiRun(state), deps(scopeIo(0), s));
      expect(result).toEqual({ drove: false, problems: [] });
      expect(rec.bootstrap).toEqual([]);
      expect(rec.events).toEqual([]);
      expect(rec.inconclusive).toEqual([]);
    });
  }

  test('a null sub-state is a no-op, not a crash', async () => {
    const { store: s } = store();
    const result = await driveBootstrap(multiRun(null), deps(scopeIo(0), s));
    expect(result).toEqual({ drove: false, problems: [] });
  });
});
