/**
 * Arena folder-scope option tests.
 *
 * Run with: bun test src/renderer/components/__tests__
 */
import { describe, expect, test } from 'bun:test';
import { buildFolderOptions } from '../arenaFolderOptions';

describe('buildFolderOptions', () => {
  test('one option per group with a working directory, in given order', () => {
    const options = buildFolderOptions([
      { id: 'g1', name: 'API', workingDir: '/work/api' },
      { id: 'g2', name: 'Scratch', workingDir: '' },
      { id: 'g3', name: 'App', workingDir: '/work/app' },
    ]);
    expect(options).toEqual([
      { groupId: 'g1', label: 'API — /work/api', dir: '/work/api' },
      { groupId: 'g3', label: 'App — /work/app', dir: '/work/app' },
    ]);
  });

  test('whitespace-only directories are treated as unset', () => {
    expect(buildFolderOptions([{ id: 'g', name: 'X', workingDir: '   ' }])).toEqual([]);
  });

  test('duplicate directories are kept — group names disambiguate', () => {
    const options = buildFolderOptions([
      { id: 'a', name: 'One', workingDir: '/same' },
      { id: 'b', name: 'Two', workingDir: '/same' },
    ]);
    expect(options.length).toBe(2);
  });

  test('empty group list produces no options', () => {
    expect(buildFolderOptions([])).toEqual([]);
  });
});
