/**
 * Waiting on token refreshes and held rotations. Run with: bun test <this file>
 */
import { describe, expect, mock, test } from 'bun:test';

const warned: string[] = [];
mock.module('electron-log', () => ({ default: { info() {}, warn: (line: string) => { warned.push(line); }, error() {}, debug() {} } }));

const { holdRotation, releaseRotation, saveHeldRotations, tokenRefreshSettled } = await import('../token-refresh');

describe('held rotations', () => {
  test('with nothing held, the way out neither waits nor warns', async () => {
    const started = Date.now();
    await saveHeldRotations(5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(warned).toEqual([]);
  });

  test('two launches on a held dir share one save', async () => {
    let saves = 0;
    holdRotation('/cfg/a', async () => {
      saves++;
      releaseRotation('/cfg/a');
      return true;
    });
    await Promise.all([tokenRefreshSettled('/cfg/a'), tokenRefreshSettled('/cfg/a')]);
    expect(saves).toBe(1);
    expect(warned).toEqual([]);
  });
});
