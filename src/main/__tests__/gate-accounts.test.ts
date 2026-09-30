/**
 * The config dirs a run's gates launched under, kept while the run is active.
 * Run with: bun test src/main/__tests__/gate-accounts.test.ts
 */
import { beforeEach, expect, test } from 'bun:test';
import { activeGateConfigDirs, clearGateConfigDirs, recordGateConfigDir } from '../gate-accounts';

beforeEach(clearGateConfigDirs);

test('every dir an active run launched under is kept', () => {
  recordGateConfigDir('r1', '/cfg/a');
  recordGateConfigDir('r1', '/cfg/b');
  recordGateConfigDir('r1', '/cfg/a');
  recordGateConfigDir('r1', null);
  expect(activeGateConfigDirs(['r1']).sort()).toEqual(['/cfg/a', '/cfg/b']);
});

test('a run that is no longer active is forgotten', () => {
  recordGateConfigDir('r1', '/cfg/a');
  recordGateConfigDir('r2', '/cfg/b');
  expect(activeGateConfigDirs(['r2'])).toEqual(['/cfg/b']);
  expect(activeGateConfigDirs(['r1', 'r2'])).toEqual(['/cfg/b']);
});
