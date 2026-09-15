import { describe, expect, test } from 'bun:test';
import { attend } from '../gate-attention';

const BASE = { gate: 2 as const, agent: 'bodhilander-lead' };

describe('a launched gate, looked at again', () => {
  test('a receipt finishes the gate with the receipt’s verdict', () => {
    const { event, note } = attend({ ...BASE, receipt: { verdict: 'pass', blocking: [] }, alive: false });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'pass' });
    expect(note).toContain('verdict pass');
  });

  test('a failing receipt is a fail, and the gate’s own reason travels', () => {
    const { event, note } = attend({
      ...BASE,
      receipt: { verdict: 'fail', blocking: [], reason: 'the gate failed without listing a blocking finding' },
      alive: false,
    });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'fail' });
    expect(note).toContain('the gate failed without listing a blocking finding');
  });

  test('a receipt is taken even while the gate is still alive, and the note says so', () => {
    // The harness says a gate writes its receipt at the end of its work.
    // Holding the run for the process to exit would be the engine deciding
    // the gate had not really meant it. But the log must say the run moved
    // before the process ended, so the sequence is reconstructible.
    const { event, note } = attend({ ...BASE, receipt: { verdict: 'pass', blocking: [] }, alive: true });
    expect(event?.kind).toBe('gateFinished');
    expect(note).toContain('still running when its receipt was read');
  });

  test('a gate that is gone without a receipt established nothing', () => {
    // Crashed, killed, ran out of something: none of those is a verdict. Not
    // a fail -- the branch was never judged -- and not a pass, because
    // nothing said so.
    const { event, note } = attend({ ...BASE, receipt: null, alive: false });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'inconclusive' });
    expect(note).toContain('no longer running and wrote no receipt');
  });

  test('a gate that is alive with no receipt is left alone', () => {
    // Working, as far as these two facts can tell. Telling a thinking gate
    // from a wedged one needs a progress signal and a deadline on silence,
    // which is the next slice, not this one.
    expect(attend({ ...BASE, receipt: null, alive: true })).toEqual({ event: null, note: null });
  });

  test('the note names the gate and the role, because a run has several of each', () => {
    const { note } = attend({ gate: 4, agent: 'scribe', receipt: { verdict: 'pass', blocking: [] }, alive: false });
    expect(note).toContain('gate 4 (scribe)');
  });
});
