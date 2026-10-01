/**
 * The teardown order on quit: a held token pair's save starts first and is
 * waited on before the database closes. Run with: bun test <this file>
 */
import { describe, expect, test } from 'bun:test';

import { HELD_ROTATION_SAVE_MS, QUIT_CLEANUP_BUDGET_MS, runQuitCleanup, QuitCleanupSteps } from '../quit-cleanup';

function recorder() {
  const order: string[] = [];
  let finishSave: () => void = () => undefined;
  const steps: QuitCleanupSteps = {
    saveHeldRotations: budgetMs => {
      order.push(`save started (${budgetMs}ms)`);
      return new Promise<void>(resolve => {
        finishSave = () => {
          order.push('save finished');
          resolve();
        };
      });
    },
    killPtys: async () => { order.push('ptys killed'); },
    stopServices: () => { order.push('services stopped'); },
    closeDatabase: () => { order.push('database closed'); },
    logError: message => { order.push(message); },
  };
  return { order, steps, finishSave: () => finishSave() };
}

describe('runQuitCleanup', () => {
  test('starts the held save before the ptys go, and closes the database only after it', async () => {
    const { order, steps, finishSave } = recorder();
    const cleanup = runQuitCleanup(steps);
    await Bun.sleep(5);
    expect(order).toEqual([`save started (${HELD_ROTATION_SAVE_MS}ms)`, 'ptys killed', 'services stopped']);
    finishSave();
    await cleanup;
    expect(order.slice(3)).toEqual(['save finished', 'database closed']);
  });

  test('a pty teardown that throws still saves and closes', async () => {
    const { order, steps, finishSave } = recorder();
    steps.killPtys = async () => { throw new Error('wedged'); };
    const cleanup = runQuitCleanup(steps);
    await Bun.sleep(5);
    finishSave();
    await cleanup;
    expect(order).toEqual([
      `save started (${HELD_ROTATION_SAVE_MS}ms)`, 'Error killing PTYs on quit:', 'services stopped', 'save finished', 'database closed',
    ]);
  });

  test('a service that throws while stopping still lets the save finish and the database close', async () => {
    const { order, steps, finishSave } = recorder();
    steps.stopServices = () => { throw new Error('relay wedged'); };
    const cleanup = runQuitCleanup(steps);
    await Bun.sleep(5);
    finishSave();
    await cleanup;
    expect(order.slice(2)).toEqual(['Error stopping services on quit:', 'save finished', 'database closed']);
  });

  test('the held save fits inside the guarded cleanup budget', () => {
    expect(HELD_ROTATION_SAVE_MS).toBeLessThan(QUIT_CLEANUP_BUDGET_MS);
  });
});
