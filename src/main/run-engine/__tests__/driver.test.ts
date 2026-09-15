/**
 * Driver tests (CO-722).
 *
 * A real database and the real state machine; only the commands are faked.
 * The properties under test are the ones a run's durability rests on, and
 * every one of them is about ORDER or about what is NOT written:
 *
 * - the transition lands before the action runs, so a crash mid-action leaves
 *   a record rather than a hole;
 * - an event that decides nothing writes nothing, so the log stays readable;
 * - the state comes from the database, not from the caller, because two
 *   things can advance a run and the stale one would overwrite the other;
 * - a cycle stops, loudly.
 *
 * Run with: bun test src/main/run-engine
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';

let db: Database;

mock.module('../../database', () => ({ getDatabase: () => db }));

const runs = await import('../../repositories/runs');
const { RUN_TABLES_SQL } = await import('../../run-tables-sql');
const { MAX_ROUNDS, advance } = await import('../driver');
const { execute } = await import('../executor');
import type { ExecutorDeps, ExecutorTarget } from '../executor';
import type { RunEvent } from '../transitions';

const TARGET: ExecutorTarget = {
  repo: 'Software-Development-LLC/Bodhilander',
  prNumber: 275,
  approvers: ['brannon-bowden'],
  initiativePath: 'C:/work/initiatives/CO-722',
  harnessPath: '/plugins/bodhi',
  pythonPath: 'C:/py/python.exe',
  agents: { 2: ['bsa-lead'], 3: ['reviewer'], 4: ['verifier'] },
  posture: 'manual',
};

const OK = { code: 0, stdout: '', stderr: '' };

// The owner (repo) the driver advances. Its registry name, not the PR slug on
// TARGET.repo -- run_owners and run_gates are keyed by this (CO-722 multi-owner).
const REPO = 'Bodhilander';

function deps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    gh: async () => OK,
    plugin: async () => OK,
    provision: async () => OK,
    spawnGate: async () => ({
      status: 'launched' as const,
      backgroundId: '11111111',
      sessionId: 'session',
      durationMs: 1,
    }),
    ...over,
  };
}

function seed(state = 'preparing'): string {
  runs.createRun({
    id: 'run-1',
    initiativeKey: 'CO-722',
    initiativeDir: 'C:/work/initiatives/CO-722',
    harnessPath: '/plugins/bodhi',
    bodhiRoot: 'C:/work/repos',
    pythonPath: 'C:/py/python.exe',
    permissionPosture: 'manual',
  });
  runs.upsertOwner({
    runId: 'run-1', repo: REPO, worktree: 'C:/work/repos/_wt-co722-Bodhilander',
    branch: 'feat/co722', base: 'origin/development', scratch: null,
    agent: 'bsa-lead', status: 'pending', prNumber: null, prUrl: null,
  });
  if (state !== 'preparing') {
    db.prepare('UPDATE runs SET state = ? WHERE id = ?').run(state, 'run-1');
    // A run past the prelude drives on its owner's state; seed it to match so
    // the driver reads the same starting point the run-level state implies.
    if (state !== 'provisioning' && state !== 'failed') {
      db.prepare('UPDATE run_owners SET state = ? WHERE run_id = ?').run(state, 'run-1');
    }
  }
  return 'run-1';
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL);');
  db.exec(RUN_TABLES_SQL);
});

describe('a state change and its reason land together', () => {
  test('the run moves as far as one call can take it', async () => {
    // Not to `provisioning` and no further: the provision succeeds, which
    // produces `provisioned`, which the same call applies. A driver that
    // stopped at the first transition would leave every run a step behind
    // until something else happened to look at it.
    const id = seed('preparing');
    const result = await advance(id, REPO, { kind: 'prepared' }, TARGET, deps());
    expect(result.applied.map((e) => e.kind)).toEqual(['prepared', 'provisioned']);
    expect(result.state).toBe('running');
    expect(runs.listEvents(id).map((e) => e.kind)).toEqual(['prepared', 'provisioned']);
  });

  test('the transition is written BEFORE the action runs', async () => {
    // The order the whole module is arranged around. An action that starts an
    // agent and then crashes must leave a record: "did that already happen?"
    // is otherwise a question somebody answers by looking at GitHub.
    const id = seed('provisioning');
    let stateWhenActionRan: string | undefined;
    await advance(id, REPO, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => {
        stateWhenActionRan = runs.getRun(id)?.state;
        return { status: 'launched', backgroundId: '1', sessionId: 's', durationMs: 1 };
      },
    }));
    expect(stateWhenActionRan).toBe('running');
  });

  test('a gate that crashes on launch still left a row behind', async () => {
    // The same rule as the transition, applied to gates: recorded BEFORE the
    // spawn, so a gate that starts and dies is a row somebody can see rather
    // than a run that says `running` with nothing to show for it. Ordering
    // the other way looks identical on every happy path, which is why this
    // asserts the crash.
    const id = seed('provisioning');
    await advance(id, REPO, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => {
        throw new Error('claude is not on PATH');
      },
    }));
    const gates = runs.listGates(id);
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ gate: 2, agent: 'bsa-lead', status: 'running' });
  });

  test('a gate with no role recorded is not started at all', async () => {
    // run_gates.agent exists so somebody can tell afterwards who ran, and a
    // placeholder there is worse than an unspawned gate: it is an answer that
    // reads as one.
    const id = seed('provisioning');
    let spawned = false;
    const result = await advance(
      id,
      REPO,
      { kind: 'provisioned' },
      { ...TARGET, agents: {} },
      deps({ spawnGate: async () => { spawned = true; throw new Error('unreachable'); } }),
    );
    expect(runs.listGates(id)).toEqual([]);
    expect(result.problems[0]).toContain('no role recorded');
    // Not spawned, not merely unrecorded. A gate that runs with no row is
    // worse than one that does not run: it spends tokens, changes a worktree,
    // and leaves nothing saying it happened. The first version of this test
    // asserted `true` here, which is how the gap was found.
    expect(spawned).toBe(false);
  });

  test('a blocked run records why, not just that', async () => {
    // A run in the inbox saying it needs a person without saying what for
    // sends whoever opens it back to the log to work it out.
    const id = seed('waitingChecks');
    await advance(
      id,
      REPO,
      { kind: 'checksUndriveable', reason: 'no expected_checks recorded' },
      TARGET,
      deps(),
    );
    const run = runs.getRun(id);
    expect(run?.state).toBe('inconclusive');
    expect(run?.blockedReason).toBe('no expected_checks recorded');
  });
});

describe('what is not written', () => {
  test('an event that decides nothing leaves no trace', async () => {
    // The machine returns the state it is already in for an event that does
    // not apply. Recording those fills the log with rows saying nothing
    // happened — which is the log becoming unreadable, not complete.
    const id = seed('waitingReview');
    const before = runs.listEvents(id).length;
    const result = await advance(id, REPO, { kind: 'prepared' }, TARGET, deps());
    expect(result.applied).toEqual([]);
    expect(runs.listEvents(id)).toHaveLength(before);
    expect(runs.getRun(id)?.state).toBe('waitingReview');
  });

  test('a failed action records no event claiming it worked', async () => {
    // The executor reports rather than assumes, and this is where that pays:
    // the run stays in reviewNotRequested, which has its own retry cadence.
    const id = seed('waitingChecks');
    const result = await advance(id, REPO, { kind: 'checksGreen' }, TARGET, deps({
      gh: async () => ({ code: 1, stdout: '', stderr: 'HTTP 403' }),
    }));
    expect(runs.getRun(id)?.state).toBe('reviewNotRequested');
    expect(runs.listEvents(id).map((e) => e.kind)).not.toContain('reviewRequested');
    expect(result.problems[0]).toContain('HTTP 403');
  });
});

describe('the state comes from the database', () => {
  test('an event decides against what is stored, not what a caller remembers', async () => {
    // Two things advance a run — a reconcile pass and a gate finishing — and
    // a caller holding a state it read a minute ago would overwrite the
    // other's work from a stale position.
    const id = seed('waitingChecks');
    // The persisted state now lives on the owner's track; the driver reads it,
    // not a state the caller passes. Move it out from under the caller.
    db.prepare('UPDATE run_owners SET state = ? WHERE run_id = ?').run('waitingReview', id);
    const result = await advance(id, REPO, { kind: 'reviewApproved' }, TARGET, deps());
    expect(result.state).toBe('approved');
  });

  test('a run that is not there is a problem, not a crash', async () => {
    const result = await advance('nonesuch', { kind: 'prepared' }, TARGET, deps());
    expect(result.problems[0]).toContain('not in the database');
  });

  test('a stale gate report cannot regress the run', async () => {
    // The activeGate guard, driven through the driver: the gate the run is
    // INSIDE comes from run_gates, so a late gate-2 verdict arriving after
    // gate 4 is ignored rather than pulling the run backwards.
    const id = seed('running');
    runs.startGate({ id: 'g4', runId: id, repo: REPO, gate: 4, agent: 'verifier', posture: 'manual' });
    const result = await advance(
      id,
      REPO,
      { kind: 'gateFinished', gate: 2, verdict: 'pass' },
      TARGET,
      deps(),
    );
    expect(result.applied).toEqual([]);
    expect(runs.getRun(id)?.state).toBe('running');
  });

  test('and the gate that IS active advances it', async () => {
    // CONTROL: a guard that ignored every report would satisfy the case above
    // and freeze every run at its first gate.
    const id = seed('running');
    runs.startGate({ id: 'g2', runId: id, repo: REPO, gate: 2, agent: 'bsa-lead', posture: 'manual' });
    const result = await advance(
      id,
      REPO,
      { kind: 'gateFinished', gate: 2, verdict: 'pass' },
      TARGET,
      deps(),
    );
    expect(result.applied).toHaveLength(1);
    // Still `running`, and that is the point: gate 2 passing does not move
    // the run, it moves the GATE. The row for 2 is closed with its verdict
    // and a row for 3 is open — which is progress the state alone cannot show.
    const gates = runs.listGates(id);
    expect(gates.find((g) => g.gate === 2)?.status).toBe('done');
    expect(gates.find((g) => g.gate === 3)?.status).toBe('running');
    expect(runs.activeGate(id)?.gate).toBe(3);
  });
});

describe('the loop', () => {
  test('an action’s event is applied in the same call', async () => {
    // provisioned → spawnGate, and a gate that comes back undriveable
    // produces gateFinished, which the same call must apply. Otherwise a run
    // sits in `running` until something else happens to look at it.
    const id = seed('provisioning');
    const result = await advance(id, REPO, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => ({
        status: 'undriveable',
        reason: 'claude is not on PATH',
        detail: null,
        durationMs: 1,
      }),
    }));
    expect(result.applied.map((e) => e.kind)).toEqual(['provisioned', 'gateFinished']);
    expect(runs.getRun(id)?.state).toBe('inconclusive');
  });

  test('a cycle stops, and says it is a fault', async () => {
    // The machine has cycles by design — gate 3 sends a run back to gate 2.
    // One that does not settle would spin for as long as the process lives,
    // so the limit is a tripwire rather than a tuning knob.
    const id = seed('running');
    runs.startGate({ id: 'g3', runId: id, repo: REPO, gate: 3, agent: 'reviewer', posture: 'manual' });
    const result = await advance(id, REPO, { kind: 'gateFinished', gate: 3, verdict: 'fail' }, TARGET, {
      ...deps(),
      // Every spawn reports a failed gate 2, which sends the run back to
      // gate 2, which spawns again.
      spawnGate: async () => {
        const gate = runs.activeGate(id);
        if (gate) runs.finishGate(gate.id, 'done');
        runs.startGate({
          id: `g${Math.random()}`, runId: id, repo: REPO, gate: 2, agent: 'owner', posture: 'manual',
        });
        return {
          status: 'completed' as const,
          structuredOutput: { verdict: 'fail', summary: 'still broken' },
          sessionId: null,
          costUsd: null,
          durationMs: 1,
        };
      },
    });
    expect(result.runaway).toContain('cycle');
    expect(result.problems).toContain(result.runaway);
  });

  test('the limit is not reached by an ordinary advance', async () => {
    // CONTROL for the tripwire: if a normal run tripped it, the number would
    // be a tuning knob and every real advance would report a fault.
    const id = seed('preparing');
    const result = await advance(id, REPO, { kind: 'prepared' }, TARGET, deps());
    expect(result.runaway).toBeNull();
    expect(MAX_ROUNDS).toBeGreaterThan(2);
  });
});

describe('the round limit', () => {
  test('a run that settles on the last permitted round is not a cycle', async () => {
    // The loop exits by falling off the `for` condition here, not by the
    // early return at the top — so an unconditional "runaway" puts a fault on
    // a run that finished correctly and merely took the long way.
    //
    // The fake touches no rows: openGates opens gate 2 each round and the
    // driver closes it when the report is accepted, so a failing gate 2
    // cycles on its own. An earlier version juggled run_gates itself and
    // broke the chain at round one, which is why it passed against the bug.
    const id = seed('running');
    runs.startGate({ id: 'g2', runId: id, repo: REPO, gate: 2, agent: 'bsa-lead', posture: 'manual' });
    let spawns = 0;
    const result = await advance(id, REPO, { kind: 'gateFinished', gate: 2, verdict: 'fail' }, TARGET, {
      ...deps(),
      spawnGate: async () => {
        spawns += 1;
        // MAX_ROUNDS, not one less: settling a round early means the loop
        // returns from the check at the TOP and never reaches the boundary
        // this test exists for. Off by one here and it passes against the bug.
        if (spawns >= MAX_ROUNDS) {
          // Settles: a launch reports no event, so this round produces none.
          return { status: 'launched' as const, backgroundId: '1', sessionId: 's', durationMs: 1 };
        }
        return {
          status: 'completed' as const,
          structuredOutput: { verdict: 'fail', summary: 'again' },
          sessionId: null,
          costUsd: null,
          durationMs: 1,
        };
      },
    });
    expect(spawns).toBe(MAX_ROUNDS);
    expect(result.runaway).toBeNull();
  });
});

describe('one run advances at a time', () => {
  test('a second call waits for the first to finish', async () => {
    // What the queue actually guarantees, asserted as what can be observed.
    //
    // Not a timing-overlap test: reading, deciding and writing are
    // synchronous inside one round, so a single advance is already atomic and
    // an overlap assertion passes with no queue at all — which is what two
    // earlier versions of this test did. What the queue adds is that a
    // MULTI-ROUND advance is atomic too, and the visible consequence is that
    // the second call does not begin until the first has returned.
    const id = seed('provisioning');
    const order: string[] = [];
    const label = (name: string) =>
      deps({
        spawnGate: async () => {
          order.push(`${name}:start`);
          await new Promise((resolve) => { setTimeout(resolve, 10); });
          order.push(`${name}:end`);
          return { status: 'launched' as const, backgroundId: '1', sessionId: 's', durationMs: 1 };
        },
      });
    await Promise.all([
      advance(id, REPO, { kind: 'provisioned' }, TARGET, label('first')),
      advance(id, REPO, { kind: 'gateFinished', gate: 2, verdict: 'fail' }, TARGET, label('second')),
    ]);
    // Interleaved, this reads first:start, second:start, ... Serialised, the
    // first pair closes before the second opens.
    expect(order.slice(0, 2)).toEqual(['first:start', 'first:end']);
  });

  test('a different run is not held up behind it', async () => {
    // CONTROL: a single global lock would serialise every run in the app
    // behind whichever one is slowest, which is a worse problem than the one
    // being solved.
    seed('preparing');
    runs.createRun({
      id: 'run-2',
      initiativeKey: 'CO-723',
      initiativeDir: 'C:/work/initiatives/CO-723',
      harnessPath: '/plugins/bodhi',
      bodhiRoot: 'C:/work/repos',
      permissionPosture: 'manual',
    });
    runs.upsertOwner({
      runId: 'run-2', repo: REPO, worktree: 'C:/wt', branch: 'b', base: 'origin/development',
      scratch: null, agent: 'bsa-lead', status: 'pending', prNumber: null, prUrl: null,
    });
    const order: string[] = [];
    const first = advance('run-1', REPO, { kind: 'prepared' }, TARGET, deps({
      provision: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        order.push('run-1');
        return OK;
      },
    }));
    const second = advance('run-2', REPO, { kind: 'prepared' }, TARGET, deps({
      provision: async () => {
        order.push('run-2');
        return OK;
      },
    }));
    await Promise.all([first, second]);
    expect(order).toEqual(['run-2', 'run-1']);
  });

  test('a failure does not wedge the queue behind it', async () => {
    const id = seed('preparing');
    await advance(id, REPO, { kind: 'prepared' }, TARGET, deps({
      provision: async () => { throw new Error('boom'); },
    }));
    const after = await advance(id, REPO, { kind: 'provisioned' }, TARGET, deps());
    expect(after.problems.filter((p) => p.includes('boom'))).toEqual([]);
  });
});

describe('what the caller is told', () => {
  test('notifications and problems come back together with the state', async () => {
    const id = seed('provisioning');
    const result = await advance(id, REPO, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => ({
        status: 'undriveable',
        reason: 'claude is not on PATH',
        detail: null,
        durationMs: 1,
      }),
    }));
    expect(result.notifications).toContain('claude is not on PATH');
    expect(result.state).toBe('inconclusive');
  });

  test('a released run says so', async () => {
    const id = seed('waitingReview');
    const result = await advance(id, REPO, { kind: 'reviewApproved' }, TARGET, deps());
    expect(result.released).toBe(true);
    expect(result.state).toBe('approved');
  });
});

describe('the executor is reached with the decision’s own actions', () => {
  test('nothing is invented between deciding and doing', async () => {
    // Bound to execute() itself rather than a stub, because an action shape
    // the driver builds by hand would drift from what the machine emits.
    const performed: string[] = [];
    const id = seed('waitingChecks');
    await advance(id, REPO, { kind: 'checksGreen' }, TARGET, deps({
      gh: async (argv) => {
        performed.push(argv.join(' '));
        return OK;
      },
    }));
    expect(performed[0]).toContain('--add-reviewer brannon-bowden');
    expect(typeof execute).toBe('function');
  });
});

describe('a gate served by several roles in sequence', () => {
  // Gate 4 is the verifier and then the scribe. The machine sees ONE gate;
  // the driver runs the sequence and reports to the machine only when the
  // last role has.
  const SEQUENCED: ExecutorTarget = { ...TARGET, agents: { ...TARGET.agents, 4: ['verifier', 'scribe'] } };

  /** A spawner that reports every role as `verdict`, and records who ran. */
  function reporting(verdict: 'pass' | 'fail' | 'inconclusive', ran: string[]) {
    return deps({
      spawnGate: async (_gate, agent) => {
        ran.push(agent);
        return {
          status: 'completed' as const,
          structuredOutput: { verdict, summary: `${agent} says ${verdict}`, findings: [] },
          sessionId: 's',
          costUsd: null,
          durationMs: 1,
        };
      },
    });
  }

  test('the first role passing starts the second and does not finish the gate', async () => {
    // The verifier's green is not the gate's green. Telling the machine
    // `gateFinished` here would send the run to waitingChecks with no PR
    // open, because the scribe -- the only role that opens one -- has not
    // run yet.
    const id = seed('running');
    runs.startGate({ id: 'v', runId: id, repo: REPO, gate: 4, agent: 'verifier', posture: 'manual' });
    const ran: string[] = [];
    const result = await advance(id, REPO, { kind: 'gateFinished', gate: 4, verdict: 'pass' }, SEQUENCED, {
      ...reporting('pass', ran),
      // Nothing after the sequence should run: the scribe's pass moves the
      // run to waitingChecks, whose only action is `reconcile`, which the
      // executor deliberately ignores.
    });
    expect(ran).toEqual(['scribe']);
    expect(result.state).toBe('waitingChecks');
    const gates = runs.listGates(id);
    expect(gates.map((g) => [g.agent, g.status])).toEqual([['verifier', 'done'], ['scribe', 'done']]);
  });

  test('the machine is told about the gate exactly once, when the last role reports', async () => {
    // Two roles, two reports, ONE gateFinished in the run's own history. The
    // step boundary is recorded in run_gates, where the rows say who ran.
    const id = seed('running');
    runs.startGate({ id: 'v', runId: id, repo: REPO, gate: 4, agent: 'verifier', posture: 'manual' });
    await advance(id, REPO, { kind: 'gateFinished', gate: 4, verdict: 'pass' }, SEQUENCED, reporting('pass', []));
    const finished = runs.listEvents(id).filter((e) => e.kind === 'gateFinished');
    expect(finished).toHaveLength(1);
  });

  test('a red first role ends the gate; the second never runs', async () => {
    // Red is red whoever found it. The verifier failing means the branch is
    // still soft, and the scribe opening a PR on it would be a PR carrying a
    // verdict nobody reached.
    const id = seed('running');
    runs.startGate({ id: 'v', runId: id, repo: REPO, gate: 4, agent: 'verifier', posture: 'manual' });
    const ran: string[] = [];
    // The owner reports `launched` so the run pauses there. A fake that kept
    // everything green would walk owner -> reviewer -> verifier -> scribe in
    // one call, and the scribe appearing in `ran` would then be correct
    // rather than the thing this test forbids.
    const result = await advance(id, REPO, { kind: 'gateFinished', gate: 4, verdict: 'fail' }, SEQUENCED, deps({
      spawnGate: async (_gate, agent) => {
        ran.push(agent);
        return { status: 'launched', backgroundId: '1', sessionId: 's', durationMs: 1 };
      },
    }));
    // backToOwner: the machine spawns gate 2, which is the owner, not the scribe.
    expect(ran).toEqual(['bsa-lead']);
    expect(result.state).toBe('running');
    expect(runs.listGates(id).map((g) => [g.agent, g.status])).toEqual([['verifier', 'done'], ['bsa-lead', 'running']]);
  });

  test('an inconclusive first role stops the run; the second never runs', async () => {
    const id = seed('running');
    runs.startGate({ id: 'v', runId: id, repo: REPO, gate: 4, agent: 'verifier', posture: 'manual' });
    const ran: string[] = [];
    const result = await advance(
      id, REPO, { kind: 'gateFinished', gate: 4, verdict: 'inconclusive' }, SEQUENCED, reporting('pass', ran),
    );
    expect(ran).toEqual([]);
    expect(result.state).toBe('inconclusive');
  });

  test('a fresh spawn of a sequenced gate starts with its first role', async () => {
    // provisioned -> gate 2 passes -> gate 3 passes -> gate 4: the machine
    // says `spawnGate 4` and the driver must open the VERIFIER, not the
    // scribe, and not both.
    const id = seed('running');
    runs.startGate({ id: 'r', runId: id, repo: REPO, gate: 3, agent: 'reviewer', posture: 'manual' });
    const ran: string[] = [];
    // Gate 3's pass spawns gate 4. Make the verifier report `launched` so the
    // sequence pauses there and we can look at what was opened.
    const result = await advance(id, REPO, { kind: 'gateFinished', gate: 3, verdict: 'pass' }, SEQUENCED, deps({
      spawnGate: async (_gate, agent) => {
        ran.push(agent);
        return { status: 'launched', backgroundId: '1', sessionId: 's', durationMs: 1 };
      },
    }));
    expect(ran).toEqual(['verifier']);
    expect(result.state).toBe('running');
    expect(runs.activeGate(id)).toMatchObject({ gate: 4, agent: 'verifier', attempt: 1 });
  });

  test('the second role is its own first attempt, not the gate’s second', async () => {
    // The column exists to make a retry loop visible. A scribe following a
    // green verifier is the same attempt's second half, and counting it as
    // attempt 2 would make every sequence read as a gate that had to be
    // rerun.
    const id = seed('running');
    runs.startGate({ id: 'v', runId: id, repo: REPO, gate: 4, agent: 'verifier', posture: 'manual' });
    await advance(id, REPO, { kind: 'gateFinished', gate: 4, verdict: 'pass' }, SEQUENCED, reporting('pass', []));
    const scribe = runs.listGates(id).find((g) => g.agent === 'scribe');
    expect(scribe?.attempt).toBe(1);
  });

  test('a report from a role outside the sequence is the gate’s own, and said so', async () => {
    // A run armed under one harness and advanced under another, or a row
    // somebody edited. There is no correct next step from an unknown
    // position, so the report goes to the machine as it did before sequences
    // existed -- and the mismatch is a problem, not a silence.
    const id = seed('running');
    runs.startGate({ id: 'x', runId: id, repo: REPO, gate: 4, agent: 'auditor', posture: 'manual' });
    const ran: string[] = [];
    const result = await advance(id, REPO, { kind: 'gateFinished', gate: 4, verdict: 'pass' }, SEQUENCED, reporting('pass', ran));
    expect(ran).toEqual([]);
    expect(result.state).toBe('waitingChecks');
    expect(result.problems.some((p) => p.includes('auditor') && p.includes('verifier then scribe'))).toBe(true);
  });
});

describe('a launched gate is written down', () => {
  test('the session it became lands on its row', async () => {
    // `launched` produces no event -- the verdict comes later, by receipt --
    // so this is the only record that the gate exists as a session at all. A
    // row with no session is a gate nothing can look at again.
    const id = seed('provisioning');
    await advance(id, REPO, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => ({
        status: 'launched', backgroundId: 'abcd1234', sessionId: 'abcd1234-0000-0000-0000-000000000000', durationMs: 1,
      }),
    }));
    expect(runs.activeGate(id)).toMatchObject({
      gate: 2,
      agent: 'bsa-lead',
      claudeSessionId: 'abcd1234-0000-0000-0000-000000000000',
      bgSessionId: 'abcd1234',
    });
  });

  test('a print gate that completed leaves the session columns alone', async () => {
    // Nothing to attach to: the verdict already arrived, and the row is
    // closed by the machine accepting it.
    const id = seed('provisioning');
    await advance(id, REPO, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => ({
        status: 'completed', structuredOutput: { verdict: 'pass', summary: 'ok' }, sessionId: 's', costUsd: null, durationMs: 1,
      }),
    }));
    const rows = runs.listGates(id).filter((g) => g.gate === 2);
    expect(rows[0]).toMatchObject({ status: 'done', claudeSessionId: null, bgSessionId: null });
  });
});

describe('a launch is recorded on the row opened for it', () => {
  test('not on whatever running row is newest with the same gate number', async () => {
    // The concern from review, constructed rather than argued: while the
    // spawn is in flight, ANOTHER running row for the same gate appears --
    // a concurrent opener, a stale attempt, a bug elsewhere. Resolving "the
    // active gate" by number would put this launch's session on that row
    // and leave the real one blank: a gate nothing can look at again, which
    // is the failure this bookkeeping exists to end.
    const id = seed('provisioning');
    let intruder: string | null = null;
    await advance(id, REPO, { kind: 'provisioned' }, TARGET, deps({
      spawnGate: async () => {
        intruder = 'intruder-' + Math.random().toString(16).slice(2);
        runs.startGate({ id: intruder, runId: id, repo: REPO, gate: 2, agent: 'bsa-lead', posture: 'manual' });
        return { status: 'launched', backgroundId: 'abcd1234', sessionId: 'abcd1234-0000-0000-0000-000000000000', durationMs: 1 };
      },
    }));
    const rows = runs.listGates(id).filter((g) => g.gate === 2);
    const opened = rows.find((g) => g.id !== intruder);
    const stray = rows.find((g) => g.id === intruder);
    expect(opened?.claudeSessionId).toBe('abcd1234-0000-0000-0000-000000000000');
    expect(stray?.claudeSessionId).toBeNull();
  });
});

describe('two owners advance on their own tracks (multi-owner)', () => {
  // One run, two repos. Each has its own gate in flight and its own state; the
  // driver advances one by naming its repo, and must not touch the other.
  function seedTwoOwners(gates: Record<string, { gate: number; id: string }>): string {
    runs.createRun({
      id: 'run-1', initiativeKey: 'CO-722', initiativeDir: 'C:/i',
      harnessPath: '/plugins/bodhi', bodhiRoot: 'C:/work/repos',
      pythonPath: 'C:/py/python.exe', permissionPosture: 'manual',
    });
    for (const repo of Object.keys(gates)) {
      runs.upsertOwner({
        runId: 'run-1', repo, worktree: `C:/wt-${repo}`, branch: 'b', base: 'origin/development',
        scratch: null, agent: 'bsa-lead', status: 'pending', prNumber: null, prUrl: null,
      });
      db.prepare('UPDATE run_owners SET state = ? WHERE run_id = ? AND repo = ?').run('running', 'run-1', repo);
      runs.startGate({ id: gates[repo].id, runId: 'run-1', repo, gate: gates[repo].gate, agent: 'bsa-lead', posture: 'manual' });
    }
    db.prepare("UPDATE runs SET state = 'running' WHERE id = 'run-1'");
    return 'run-1';
  }

  test('advancing one repo\u2019s gate leaves the other repo\u2019s gate untouched', async () => {
    const id = seedTwoOwners({ 'repo-a': { gate: 2, id: 'a2' }, 'repo-b': { gate: 2, id: 'b2' } });
    await advance(id, 'repo-a', { kind: 'gateFinished', gate: 2, verdict: 'pass' }, TARGET, deps());
    // repo-a moved to gate 3; repo-b is still at its gate 2.
    expect(runs.activeGate(id, 'repo-a')).toMatchObject({ gate: 3 });
    expect(runs.activeGate(id, 'repo-b')).toMatchObject({ gate: 2, id: 'b2' });
    // Both owners are still running; the run rolls up to running.
    expect(runs.getRun(id)?.state).toBe('running');
  });

  test('a stale gate-2 verdict for a repo at gate 4 is ignored, while another repo advances', async () => {
    // repo-a is at gate 4; a late gate-2 verdict for it must not pull it back.
    // repo-b is genuinely at gate 2 and must advance -- proving activeGate is
    // read per repo, not once for the whole run.
    const id = seedTwoOwners({ 'repo-a': { gate: 4, id: 'a4' }, 'repo-b': { gate: 2, id: 'b2' } });
    await advance(id, 'repo-a', { kind: 'gateFinished', gate: 2, verdict: 'pass' }, TARGET, deps());
    await advance(id, 'repo-b', { kind: 'gateFinished', gate: 2, verdict: 'pass' }, TARGET, deps());
    expect(runs.activeGate(id, 'repo-a')).toMatchObject({ gate: 4, id: 'a4' });
    expect(runs.activeGate(id, 'repo-b')).toMatchObject({ gate: 3 });
  });
});
