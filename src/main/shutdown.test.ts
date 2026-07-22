import { test, expect } from 'bun:test';
import { runGuardedShutdown } from './shutdown';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('forces exit once after cleanup completes normally', async () => {
  let exits = 0;
  runGuardedShutdown({
    cleanup: async () => {
      await tick(5);
    },
    forceExit: () => {
      exits++;
    },
    budgetMs: 1000,
  });

  await tick(40);
  expect(exits).toBe(1);
});

test('forces exit within budget even when cleanup hangs forever', async () => {
  let exits = 0;
  const start = Date.now();
  let exitedAt = 0;

  runGuardedShutdown({
    cleanup: () => new Promise<void>(() => { /* never resolves */ }),
    forceExit: () => {
      exits++;
      exitedAt = Date.now();
    },
    budgetMs: 20,
  });

  await tick(80);
  expect(exits).toBe(1);
  // Exit was driven by the watchdog, not the (hung) cleanup.
  expect(exitedAt - start).toBeGreaterThanOrEqual(15);
});

test('still exits exactly once when cleanup rejects', async () => {
  let exits = 0;
  runGuardedShutdown({
    cleanup: async () => {
      throw new Error('teardown blew up');
    },
    forceExit: () => {
      exits++;
    },
    budgetMs: 1000,
  });

  await tick(40);
  expect(exits).toBe(1);
});

test('does not double-fire when cleanup resolves just after the deadline', async () => {
  let exits = 0;
  runGuardedShutdown({
    cleanup: async () => {
      await tick(60); // resolves AFTER the 20ms budget
    },
    forceExit: () => {
      exits++;
    },
    budgetMs: 20,
  });

  await tick(120);
  expect(exits).toBe(1);
});
