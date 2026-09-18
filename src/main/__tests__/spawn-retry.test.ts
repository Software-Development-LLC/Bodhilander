import { describe, expect, test } from 'bun:test';
import { isTransientSpawnError, withSpawnRetry } from '../spawn-retry';

describe('isTransientSpawnError', () => {
  test('matches node-pty\'s errno-less posix_spawnp failure (robert2\'s error)', () => {
    expect(isTransientSpawnError(new Error('posix_spawnp failed.'))).toBe(true);
  });

  test('matches raw EAGAIN / ENOMEM / resource-temporarily-unavailable spellings', () => {
    expect(isTransientSpawnError(new Error('spawn EAGAIN'))).toBe(true);
    expect(isTransientSpawnError(new Error('spawn ENOMEM'))).toBe(true);
    expect(isTransientSpawnError(new Error('Resource temporarily unavailable'))).toBe(true);
  });

  test('does NOT match a permanent failure', () => {
    // Helper/shell missing or wrong ABI — retrying is pointless, must surface.
    expect(isTransientSpawnError(new Error('spawn /bin/sh ENOENT'))).toBe(false);
    expect(isTransientSpawnError(new Error('spawn-helper: bad CPU type in executable'))).toBe(false);
    expect(isTransientSpawnError(new Error('EACCES: permission denied'))).toBe(false);
  });

  test('tolerates non-Error values', () => {
    expect(isTransientSpawnError('posix_spawnp failed.')).toBe(true);
    expect(isTransientSpawnError(undefined)).toBe(false);
  });
});

describe('withSpawnRetry', () => {
  const noSleep = async (): Promise<void> => {};

  test('returns immediately when the first attempt succeeds (no retries)', async () => {
    let calls = 0;
    const result = await withSpawnRetry(
      () => {
        calls++;
        return 'ok';
      },
      { sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const result = await withSpawnRetry(
      () => {
        calls++;
        if (calls < 3) throw new Error('posix_spawnp failed.');
        return 'recovered';
      },
      { retries: 3, sleep: noSleep },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  test('gives up after exhausting retries and rethrows the last error', async () => {
    let calls = 0;
    const attempt = withSpawnRetry(
      () => {
        calls++;
        throw new Error('posix_spawnp failed.');
      },
      { retries: 2, sleep: noSleep },
    );
    await expect(attempt).rejects.toThrow('posix_spawnp failed.');
    expect(calls).toBe(3); // first try + 2 retries
  });

  test('does NOT retry a non-transient error — throws on the first attempt', async () => {
    let calls = 0;
    const attempt = withSpawnRetry(
      () => {
        calls++;
        throw new Error('spawn /bin/sh ENOENT');
      },
      { retries: 5, sleep: noSleep },
    );
    await expect(attempt).rejects.toThrow('ENOENT');
    expect(calls).toBe(1);
  });

  test('applies linear backoff between retries', async () => {
    const delays: number[] = [];
    const recordSleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };
    let calls = 0;
    await withSpawnRetry(
      () => {
        calls++;
        if (calls < 3) throw new Error('EAGAIN');
        return 0;
      },
      { retries: 3, delayMs: 100, sleep: recordSleep },
    );
    expect(delays).toEqual([100, 200]); // delayMs * attemptIndex
  });
});
