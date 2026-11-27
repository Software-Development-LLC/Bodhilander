import { describe, expect, test } from 'bun:test';
import { LEASE_MS, LeaseClock } from '../lease';
import { HIRE, HIRE_B } from './crew-db';

function clocks() {
  const c = { m: 1_000, w: 1_700_000_000_000 };
  return { c, clocks: { mono: () => c.m, wall: () => c.w } };
}

describe('LeaseClock', () => {
  test('a renew holds the lease from the heartbeat send, not from the renew', () => {
    const { c, clocks: k } = clocks();
    const lease = new LeaseClock(k);
    const seq = lease.sendHeartbeat();
    c.m += 60_000;
    c.w += 60_000;
    expect(lease.onRenew(seq, [{ hireId: HIRE, epoch: 1 }])).toEqual([HIRE]);
    c.m += LEASE_MS - 60_001;
    c.w += LEASE_MS - 60_001;
    expect(lease.held(HIRE)).toBe(true);
    c.m += 1;
    c.w += 1;
    expect(lease.held(HIRE)).toBe(false);
  });

  test('either clock passing five minutes lapses the lease', () => {
    for (const which of ['m', 'w'] as const) {
      const { c, clocks: k } = clocks();
      const lease = new LeaseClock(k);
      lease.onRenew(lease.sendHeartbeat(), [{ hireId: HIRE, epoch: 1 }]);
      c[which] += LEASE_MS;
      expect(lease.held(HIRE)).toBe(false);
    }
  });

  test('a wall clock set backwards lapses the lease', () => {
    const { c, clocks: k } = clocks();
    const lease = new LeaseClock(k);
    lease.onRenew(lease.sendHeartbeat(), [{ hireId: HIRE, epoch: 1 }]);
    c.w -= 1;
    expect(lease.held(HIRE)).toBe(false);
  });

  test('a wake lapses every lease, and a pre-wake heartbeat renews nothing', () => {
    const { clocks: k } = clocks();
    const lease = new LeaseClock(k);
    lease.onRenew(lease.sendHeartbeat(), [{ hireId: HIRE, epoch: 1 }]);
    const before = lease.sendHeartbeat();
    lease.onResume();
    expect(lease.held(HIRE)).toBe(false);
    expect(lease.onRenew(before, [{ hireId: HIRE, epoch: 1 }])).toEqual([]);
    expect(lease.onRenew(lease.sendHeartbeat(), [{ hireId: HIRE, epoch: 1 }])).toEqual([HIRE]);
  });

  test('an unknown seq renews nothing, and a seq is answered once', () => {
    const lease = new LeaseClock(clocks().clocks);
    expect(lease.onRenew(99, [{ hireId: HIRE, epoch: 1 }])).toEqual([]);
    const seq = lease.sendHeartbeat();
    expect(lease.onRenew(seq, [{ hireId: HIRE, epoch: 1 }])).toEqual([HIRE]);
    expect(lease.onRenew(seq, [{ hireId: HIRE_B, epoch: 1 }])).toEqual([]);
  });

  test('seq is per connection', () => {
    const lease = new LeaseClock(clocks().clocks);
    const old = lease.sendHeartbeat();
    lease.onConnectionClosed();
    expect(lease.onRenew(old, [{ hireId: HIRE, epoch: 1 }])).toEqual([]);
    expect(lease.sendHeartbeat()).toBe(1);
  });

  test('a lease never moves back to an older heartbeat or epoch', () => {
    const { c, clocks: k } = clocks();
    const lease = new LeaseClock(k);
    const first = lease.sendHeartbeat();
    c.m += 10;
    c.w += 10;
    const second = lease.sendHeartbeat();
    expect(lease.onRenew(second, [{ hireId: HIRE, epoch: 2 }])).toEqual([HIRE]);
    expect(lease.onRenew(first, [{ hireId: HIRE, epoch: 2 }])).toEqual([]);
    expect(lease.onRenew(lease.sendHeartbeat(), [{ hireId: HIRE, epoch: 1 }])).toEqual([]);
    expect(lease.epochOf(HIRE)).toBe(2);
    expect(lease.held(HIRE, 1)).toBe(false);
    expect(lease.held(HIRE, 2)).toBe(true);
  });

  test('revoke ends the lease, and sweep reports each lapse once', () => {
    const { c, clocks: k } = clocks();
    const lease = new LeaseClock(k);
    lease.onRenew(lease.sendHeartbeat(), [{ hireId: HIRE, epoch: 1 }, { hireId: HIRE_B, epoch: 1 }]);
    expect(lease.sweep()).toEqual([]);
    lease.revoke(HIRE_B);
    expect(lease.held(HIRE_B)).toBe(false);
    c.m += LEASE_MS;
    expect(lease.sweep().sort()).toEqual([HIRE, HIRE_B].sort());
    expect(lease.sweep()).toEqual([]);
  });
});
