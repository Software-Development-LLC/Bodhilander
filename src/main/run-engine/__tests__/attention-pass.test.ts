import { describe, expect, test } from 'bun:test';
import type { RunGateRow, RunRow } from '../../repositories/runs';
import { lookAtGate, sessionStatus, startedAtIso, type AttentionDeps } from '../attention-pass';

const RUN: RunRow = {
  id: 'run-1',
  initiativeKey: 'BDH-239',
  initiativeDir: 'C:/init/BDH-239',
  harnessPath: 'C:/harness',
  bodhiRoot: 'C:/work/repos',
  pythonPath: null,
  state: 'running',
  permissionPosture: 'manual',
  budgetUsd: null,
  groupId: null,
  blockedReason: null,
  createdAt: new Date('2026-09-15T02:00:00Z'),
} as RunRow;

const GATE: RunGateRow = {
  id: 'g',
  runId: 'run-1',
  gate: 2,
  agent: 'bodhilander-lead',
  attempt: 1,
  bgSessionId: 'ea15b328',
  claudeSessionId: 'ea15b328-0000-0000-0000-000000000000',
  status: 'running',
  verdictJson: null,
  posture: 'manual',
  startedAt: '2026-09-15 02:23:22',
};

const RECEIPT = JSON.stringify({
  schema_version: 1, initiative: 'BDH-239', gate: 2, agent: 'bodhilander-lead', verdict: 'pass',
  blocking_findings: [], not_verified: [], written_at: '2026-09-15T02:28:00Z', harness: 'C:/harness',
});

function deps(over: Partial<AttentionDeps> & { files?: Record<string, string>; agents?: unknown } = {}): AttentionDeps {
  const files = over.files ?? {};
  const agents = over.agents ?? [];
  return {
    readFile: (p) => files[p] ?? null,
    run: async () => ({ code: 0, stdout: JSON.stringify(agents), stderr: '' }),
    claudePath: 'claude',
    now: () => Date.parse('2026-09-15T02:30:00Z'),
    busyCeilingMs: 2 * 60 * 60 * 1000,
    ...over,
  };
}

describe('the gathering half of attention', () => {
  test('reads the receipt from the harness’s path for this gate and role', async () => {
    const path = 'C:/init/BDH-239/gates/2-bodhilander-lead.json';
    const look = await lookAtGate(RUN, GATE, deps({ files: { [path]: RECEIPT } }));
    expect(look.receiptPath).toBe(path);
    expect(look.receiptVerdict).toBe('pass');
    expect(look.attention.event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'pass' });
  });

  test('a session the daemon does not list is gone', async () => {
    const look = await lookAtGate(RUN, GATE, deps({ agents: [{ id: 'other', status: 'busy' }] }));
    expect(look.status).toBe('gone');
    expect(look.attention.event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'inconclusive' });
  });

  test('the daemon’s word is passed through, and a busy gate is left alone', async () => {
    const look = await lookAtGate(RUN, GATE, deps({ agents: [{ id: 'ea15b328', status: 'busy' }] }));
    expect(look.status).toBe('busy');
    expect(look.attention.event).toBeNull();
    // Since 02:23:22Z, at 02:30:00Z -- the SQLite form is read as UTC.
    expect(look.runningForMs).toBe(6 * 60_000 + 38_000);
  });

  test('the row’s start time is read as UTC, because that is what SQLite wrote', () => {
    expect(startedAtIso('2026-09-15 02:23:22')).toBe('2026-09-15T02:23:22Z');
  });

  test('a start time that does not parse is said, and the ceiling cannot apply', async () => {
    const look = await lookAtGate(RUN, { ...GATE, startedAt: 'yesterday' }, deps({ agents: [{ id: 'ea15b328', status: 'busy' }] }));
    expect(look.runningForMs).toBeNull();
    expect(look.statusNote).toContain('does not parse');
    expect(look.attention.event).toBeNull();
  });

  test('a stale receipt is refused by the row’s start, gathered from the same row', async () => {
    // written 00:19Z, row opened 02:23Z: a previous attempt's. The row's
    // status decides instead -- gone, so inconclusive -- and the note says
    // the receipt was there.
    const path = 'C:/init/BDH-239/gates/2-bodhilander-lead.json';
    const stale = RECEIPT.replace('2026-09-15T02:28:00Z', '2026-09-15T00:19:00Z');
    const look = await lookAtGate(RUN, GATE, deps({ files: { [path]: stale } }));
    expect(look.attention.event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'inconclusive' });
    expect(look.attention.note).toContain('previous attempt');
  });

  test('a gate number this engine does not know is refused before anything is read', async () => {
    await expect(lookAtGate(RUN, { ...GATE, gate: 7 }, deps())).rejects.toThrow('gate 7');
  });
});

describe('asking the daemon', () => {
  test('no recorded session is unknown, not gone', async () => {
    expect(await sessionStatus(null, deps())).toEqual({ status: null, note: null });
  });

  test('a daemon that could not be asked is unknown, with the reason', async () => {
    const seen = await sessionStatus('abc', deps({ run: async () => ({ code: 1, stdout: '', stderr: 'no daemon' }) }));
    expect(seen.status).toBeNull();
    expect(seen.note).toContain('exited 1');
  });

  test('a word the daemon has not shown before is unknown, named', async () => {
    const seen = await sessionStatus('abc', deps({ agents: [{ id: 'abc', status: 'hibernating' }] }));
    expect(seen.status).toBeNull();
    expect(seen.note).toContain('"hibernating"');
  });

  test('the agents list may arrive wrapped or bare', async () => {
    const bare = await sessionStatus('abc', deps({ agents: [{ id: 'abc', status: 'idle' }] }));
    const wrapped = await sessionStatus('abc', deps({ run: async () => ({ code: 0, stdout: JSON.stringify({ agents: [{ id: 'abc', status: 'idle' }] }), stderr: '' }) }));
    expect(bare.status).toBe('idle');
    expect(wrapped.status).toBe('idle');
  });
});
