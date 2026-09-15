import { describe, expect, test } from 'bun:test';
import { attend } from '../gate-attention';

const BASE = { gate: 2 as const, agent: 'bodhilander-lead', backgroundId: 'ea15b328' };

describe('a launched gate, looked at again', () => {
  test('a receipt finishes the gate with the receipt’s verdict', () => {
    const { event, note } = attend({ ...BASE, receipt: { verdict: 'pass', blocking: [], writtenAt: null }, status: 'gone' });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'pass' });
    expect(note).toContain('verdict pass');
  });

  test('a failing receipt is a fail, and the gate’s own reason travels', () => {
    const { event, note } = attend({
      ...BASE,
      receipt: { verdict: 'fail', blocking: [], reason: 'the gate failed without listing a blocking finding', writtenAt: null },
      status: 'idle',
    });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'fail' });
    expect(note).toContain('the gate failed without listing a blocking finding');
  });

  test('a receipt is taken even while the gate is still busy, and the note says so', () => {
    // The harness says a gate writes its receipt at the end of its work.
    // Holding the run for the process to exit would be the engine deciding
    // the gate had not really meant it. But the log must say the run moved
    // before the process ended, so the sequence is reconstructible.
    const { event, note } = attend({ ...BASE, receipt: { verdict: 'pass', blocking: [], writtenAt: null }, status: 'busy' });
    expect(event?.kind).toBe('gateFinished');
    expect(note).toContain('still working when its receipt was read');
  });

  test('a gate that is gone without a receipt established nothing', () => {
    // Crashed, killed, ran out of something: none of those is a verdict. Not
    // a fail -- the branch was never judged -- and not a pass, because
    // nothing said so.
    const { event, note } = attend({ ...BASE, receipt: null, status: 'gone' });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'inconclusive' });
    expect(note).toContain('no longer running and wrote no receipt');
  });

  test('a gate that finished its turn without a receipt established nothing, and the note says which', () => {
    // Measured: a background session reads `idle` once its turn is done. The
    // note differs from gone because the fix differs: a crash is the
    // machine's, a missing sign-off is the role's.
    const { event, note } = attend({ ...BASE, receipt: null, status: 'idle' });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'inconclusive' });
    expect(note).toContain('finished its turn without writing a receipt');
  });

  test('a gate waiting on a prompt nobody is attached to is a person’s problem, with the id to attach to', () => {
    // Measured: a session wedged on a permission prompt reads `waiting`. The
    // event is `permissionRequested`, which the machine answers by moving the
    // run to the waitingPermission state -- into the inbox -- rather than the
    // gate being called finished or left to sit.
    const { event, note } = attend({ ...BASE, receipt: null, status: 'waiting' });
    expect(event).toEqual({ kind: 'permissionRequested' });
    expect(note).toContain('waiting on a prompt nobody is attached to');
    expect(note).toContain('claude attach ea15b328');
  });

  test('busy past the ceiling is a person’s call, not a kill', () => {
    // The clock #292 is named for killed a working reviewer. This one does
    // not touch the gate: the run goes to the inbox with the id to attach to,
    // and whether it is thought or a loop is decided by someone who can look.
    const { event, note } = attend({
      ...BASE, receipt: null, status: 'busy', busyForMs: 3 * 60 * 60 * 1000, busyCeilingMs: 2 * 60 * 60 * 1000,
    });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'inconclusive' });
    expect(note).toContain('running for 180 minutes');
    expect(note).toContain('busy now');
    expect(note).toContain('120-minute ceiling');
    expect(note).toContain('claude attach ea15b328');
  });

  test('busy under the ceiling is thinking', () => {
    expect(attend({
      ...BASE, receipt: null, status: 'busy', busyForMs: 90 * 60 * 1000, busyCeilingMs: 2 * 60 * 60 * 1000,
    })).toEqual({ event: null, note: null });
  });

  test('a clock nobody wound gives no verdict', () => {
    // A caller that cannot say how long the gate has run -- or has no
    // ceiling to apply -- gets nothing from the ceiling. Half a clock is not
    // a clock.
    expect(attend({ ...BASE, receipt: null, status: 'busy', busyForMs: null, busyCeilingMs: 1 })).toEqual({ event: null, note: null });
    expect(attend({ ...BASE, receipt: null, status: 'busy', busyForMs: 1e9, busyCeilingMs: null })).toEqual({ event: null, note: null });
  });

  test('a receipt outranks the ceiling', () => {
    // A gate that signed off is finished whatever the clock says.
    const { event } = attend({
      ...BASE, receipt: { verdict: 'pass', blocking: [], writtenAt: null }, status: 'busy', busyForMs: 1e12, busyCeilingMs: 1,
    });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'pass' });
  });

  test('a receipt written before this attempt started is a previous attempt’s, and is not used', () => {
    // Measured, not hypothetical: `watch` on a fresh run found this morning's
    // 3-reviewer.json at the shared path and launched gate 4 on it. The
    // receipt path is per initiative and per role -- no run, no attempt --
    // so written_at against the row's started_at is the only thing that
    // tells a previous attempt's sign-off from this one's.
    const { event, note } = attend({
      ...BASE,
      receipt: { verdict: 'pass', blocking: [], writtenAt: '2026-09-15T00:19:00Z' },
      startedAt: '2026-09-15T02:23:22Z',
      status: 'busy',
    });
    expect(event).toBeNull();
    expect(note).toContain('previous attempt');
    expect(note).toContain('2026-09-15T00:19:00Z');
  });

  test('a stale receipt still lets the status decide, and both notes are kept', () => {
    // Stale receipt, gate gone: the gate established nothing, and the log
    // should say both that a receipt was there and why it did not count.
    const { event, note } = attend({
      ...BASE,
      receipt: { verdict: 'pass', blocking: [], writtenAt: '2026-09-15T00:19:00Z' },
      startedAt: '2026-09-15T02:23:22Z',
      status: 'gone',
    });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'inconclusive' });
    expect(note).toContain('previous attempt');
    expect(note).toContain('wrote no receipt');
  });

  test('a receipt written after the attempt started is this attempt’s', () => {
    const { event } = attend({
      ...BASE,
      receipt: { verdict: 'pass', blocking: [], writtenAt: '2026-09-15T02:28:00Z' },
      startedAt: '2026-09-15T02:23:22Z',
      status: 'gone',
    });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'pass' });
  });

  test('SQLite’s timestamp and ISO 8601 are compared as instants, not text', () => {
    // '2026-09-15 02:23:22' sorts AFTER '2026-09-15T00:19:00Z' as text only
    // by accident of the space; the comparison must not depend on it.
    const { event } = attend({
      ...BASE,
      receipt: { verdict: 'pass', blocking: [], writtenAt: '2026-09-15T02:28:00Z' },
      startedAt: '2026-09-15 02:23:22',
      status: 'gone',
    });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'pass' });
  });

  test('without both timestamps nothing is called stale', () => {
    // A receipt with no written_at is already odd -- the harness always
    // writes one -- and is something to look at, not something to discard.
    const { event } = attend({
      ...BASE, receipt: { verdict: 'pass', blocking: [], writtenAt: null }, startedAt: '2026-09-15T02:23:22Z', status: 'gone',
    });
    expect(event).toEqual({ kind: 'gateFinished', gate: 2, verdict: 'pass' });
  });

  test('an unknown status is not gone', () => {
    // No id recorded, or the daemon could not be asked. "Gone" is a verdict
    // about the gate and must not be reached by failing to look.
    expect(attend({ ...BASE, receipt: null, status: null })).toEqual({ event: null, note: null });
  });

  test('a busy gate with no receipt is left alone', () => {
    // Thinking. The daemon says so, which is what makes a deadline on
    // elapsed time unnecessary here -- the one clock still owed is on how
    // long busy may last without a word, and that is a cadence, not a fact.
    expect(attend({ ...BASE, receipt: null, status: 'busy' })).toEqual({ event: null, note: null });
  });

  test('the note names the gate and the role, because a run has several of each', () => {
    const { note } = attend({ gate: 4, agent: 'scribe', backgroundId: null, receipt: { verdict: 'pass', blocking: [], writtenAt: null }, status: 'gone' });
    expect(note).toContain('gate 4 (scribe)');
  });
});
