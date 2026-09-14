import { test, expect } from 'bun:test';
import { checkPendingInstall } from './update-verify';

test('no pending version recorded — nothing to verify', () => {
  expect(checkPendingInstall(null, '3.5.1-beta.14')).toEqual({
    nextPendingVersion: null,
    failedInstall: null,
  });
});

test('pending version matches current — install succeeded, clear it', () => {
  expect(checkPendingInstall('3.5.1-beta.14', '3.5.1-beta.14')).toEqual({
    nextPendingVersion: null,
    failedInstall: null,
  });
});

test('pending version differs from current — install silently failed (#294)', () => {
  // The exact bug this app hit: quitAndInstall() ran, the process exited
  // cleanly, and the next launch came back up on the OLD version with
  // nothing anywhere reporting a problem.
  expect(checkPendingInstall('3.5.1-beta.14', '3.5.1-beta.6')).toEqual({
    nextPendingVersion: null,
    failedInstall: { expected: '3.5.1-beta.14', actual: '3.5.1-beta.6' },
  });
});

test('always clears the pending marker so a failure is reported once, not every launch', () => {
  const result = checkPendingInstall('3.5.1-beta.14', '3.5.1-beta.6');
  expect(result.nextPendingVersion).toBeNull();
});
