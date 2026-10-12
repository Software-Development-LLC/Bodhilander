/**
 * The benign-teardown filter that used to swallow xterm's post-dispose
 * handleResize error is gone; every uncaught error now reaches the log
 * as a plain window.onerror entry instead of being hidden.
 */
import { afterEach, expect, test } from 'bun:test';

const originalOnError = window.onerror;

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  window.onerror = originalOnError;
});

test('window.onerror logs every message and never suppresses one', async () => {
  const logged: unknown[] = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    logError: (...args: unknown[]) => { logged.push(args); },
  };

  await import('../index');

  const result = window.onerror?.(
    "Cannot read properties of undefined (reading 'handleResize')",
    'file.js', 1, 1, new Error('boom')
  );

  expect(result).toBeUndefined();
  expect(logged).toEqual([
    ['window.onerror', "Cannot read properties of undefined (reading 'handleResize') at file.js:1:1", expect.any(String)],
  ]);
});
