/** Deliberately failing test proving the CI gate turns red. Reverted next commit. */
import { expect, test } from 'bun:test';

test('canary: the test gate must fail on a failing test', () => {
  expect('gate').toBe('red');
});
