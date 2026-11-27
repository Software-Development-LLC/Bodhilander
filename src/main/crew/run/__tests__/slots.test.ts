import { describe, expect, test } from 'bun:test';
import { RunSlots } from '../slots';

describe('RunSlots', () => {
  test('one run per hire, crew.maxRuns per machine, and release frees the slot', () => {
    let max = 2;
    const slots = new RunSlots(() => max);
    const a = slots.tryAcquire('h1', 'chat');
    expect(a).not.toBeNull();
    expect(slots.tryAcquire('h1', 'routine')).toBeNull();
    expect(slots.tryAcquire('h2', 'chat')).not.toBeNull();
    expect(slots.tryAcquire('h3', 'chat')).toBeNull();
    a!.release();
    expect(slots.tryAcquire('h3', 'chat')).not.toBeNull();
    max = 4;
    expect(slots.tryAcquire('h4', 'routine')).not.toBeNull();
    expect(slots.inUse()).toBe(3);
  });

  test('an unusable preference falls back to 2', () => {
    const slots = new RunSlots(() => Number.NaN);
    expect(slots.pick([{ id: '1', hireId: 'a', kind: 'chat' }, { id: '2', hireId: 'b', kind: 'chat' }, { id: '3', hireId: 'c', kind: 'chat' }])).toHaveLength(2);
  });

  test('a chat beats a routine queued before it; one job per hire; busy hires wait', () => {
    const slots = new RunSlots(() => 2);
    const queue = [
      { id: 'r1', hireId: 'h1', kind: 'routine' as const },
      { id: 'c1', hireId: 'h2', kind: 'chat' as const },
      { id: 'c2', hireId: 'h2', kind: 'chat' as const },
      { id: 'c3', hireId: 'h3', kind: 'chat' as const },
    ];
    expect(slots.pick(queue).map((j) => j.id)).toEqual(['c1', 'c3']);
    slots.tryAcquire('h3', 'chat');
    expect(slots.pick(queue).map((j) => j.id)).toEqual(['c1']);
    expect(slots.pick(queue.filter((j) => j.kind === 'routine')).map((j) => j.id)).toEqual(['r1']);
  });
});
