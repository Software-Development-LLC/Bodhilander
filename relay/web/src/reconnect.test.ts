/**
 * Unit tests for the reconnect scheduler (the offline/closed → auto-recover
 * timer logic). Uses short real delays so it stays DOM-free and deterministic.
 *
 * Run with: bun test relay/web/src/reconnect.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { createReconnectScheduler } from './reconnect';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createReconnectScheduler', () => {
  test('fires reconnect once after the delay when still alive', async () => {
    let count = 0;
    const s = createReconnectScheduler({ isAlive: () => true, reconnect: () => { count++; } });
    s.schedule(10);
    expect(s.pending).toBe(true);
    await wait(25);
    expect(count).toBe(1);
    expect(s.pending).toBe(false);
  });

  test('schedules at most one reconnect while a timer is in flight', async () => {
    let count = 0;
    const s = createReconnectScheduler({ isAlive: () => true, reconnect: () => { count++; } });
    s.schedule(10);
    s.schedule(10); // ignored — one already pending
    s.schedule(10); // ignored
    await wait(25);
    expect(count).toBe(1);
  });

  test('does NOT resurrect the connection when torn down (isAlive false)', async () => {
    let count = 0;
    let alive = true;
    const s = createReconnectScheduler({ isAlive: () => alive, reconnect: () => { count++; } });
    s.schedule(10);
    alive = false; // e.g. logout / machine-switch nulled the connection
    await wait(25);
    expect(count).toBe(0);
    expect(s.pending).toBe(false);
  });

  test('cancel() prevents a pending reconnect from firing', async () => {
    let count = 0;
    const s = createReconnectScheduler({ isAlive: () => true, reconnect: () => { count++; } });
    s.schedule(10);
    s.cancel();
    expect(s.pending).toBe(false);
    await wait(25);
    expect(count).toBe(0);
  });

  test('can schedule again after firing', async () => {
    let count = 0;
    const s = createReconnectScheduler({ isAlive: () => true, reconnect: () => { count++; } });
    s.schedule(10);
    await wait(25);
    s.schedule(10);
    await wait(25);
    expect(count).toBe(2);
  });
});
