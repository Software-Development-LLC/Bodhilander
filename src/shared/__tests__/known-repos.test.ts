import { describe, expect, test } from 'bun:test';
import { findKnownRepo, knownRepos } from '../known-repos';

const groups = [
  { id: 'g1', name: 'API', workingDir: '/code/api' },
  { id: 'g2', name: 'Inherits', workingDir: '' },
];
const sessions = [
  { groupId: 'g2', workingDir: '/code/web', shellType: 'claude' },
  { groupId: 'g2', workingDir: '/home/w', shellType: 'bash' },
  { groupId: 'g1', workingDir: '/code/api/', shellType: 'claude' },
];

describe('knownRepos', () => {
  test('group folders and agent-session folders, once each; never a plain shell\'s', () => {
    expect(knownRepos(groups, sessions, 'linux')).toEqual([
      { dir: '/code/api', groupId: 'g1', groupName: 'API' },
      { dir: '/code/web', groupId: 'g2', groupName: null },
    ]);
  });
});

describe('findKnownRepo', () => {
  test('matches the folder exactly, after resolving', () => {
    expect(findKnownRepo('/code/api/', groups, sessions, 'linux')?.groupId).toBe('g1');
    expect(findKnownRepo('/code/api/../web', groups, sessions, 'linux')?.groupId).toBe('g2');
  });

  test('refuses a shell folder, a parent and a lookalike', () => {
    for (const dir of ['/home/w', '/code', '/code/api-old']) {
      expect(findKnownRepo(dir, groups, sessions, 'linux')).toBeNull();
    }
  });

  test('is case-insensitive on Windows only', () => {
    const win = [{ id: 'g', name: 'W', workingDir: 'C:\\Code\\Api' }];
    expect(findKnownRepo('c:\\code\\api', win, [], 'win32')?.groupId).toBe('g');
    expect(findKnownRepo('/Code/API', groups, [], 'linux')).toBeNull();
  });
});
