import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import { findKnownRepo, isTooBroad, knownRepos } from '../known-repos';

const HOME = '/home/w';

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
    expect(knownRepos(groups, sessions, 'linux', HOME)).toEqual([
      { dir: '/code/api', groupId: 'g1', groupName: 'API' },
      { dir: '/code/web', groupId: 'g2', groupName: null },
    ]);
  });
});

describe('findKnownRepo', () => {
  test('matches the folder exactly, after resolving', () => {
    expect(findKnownRepo('/code/api/', groups, sessions, 'linux', HOME)?.groupId).toBe('g1');
    expect(findKnownRepo('/code/api/../web', groups, sessions, 'linux', HOME)?.groupId).toBe('g2');
  });

  test('refuses a shell folder, a parent and a lookalike', () => {
    for (const dir of ['/home/w', '/code', '/code/api-old']) {
      expect(findKnownRepo(dir, groups, sessions, 'linux', HOME)).toBeNull();
    }
  });

  test('is case-insensitive on Windows only', () => {
    const win = [{ id: 'g', name: 'W', workingDir: 'C:\\Code\\Api' }];
    expect(findKnownRepo('c:\\code\\api', win, [], 'win32', 'C:\\Users\\w')?.groupId).toBe('g');
    expect(findKnownRepo('/Code/API', groups, [], 'linux', HOME)).toBeNull();
  });
});

describe('the home folder, its ancestors and roots are never repos', () => {
  test.each([
    ['/', 'linux', '/home/w'],
    ['/home', 'linux', '/home/w'],
    ['/home/w', 'linux', '/home/w'],
    ['/home/w/', 'linux', '/home/w'],
    ['C:\\', 'win32', 'C:\\Users\\w'],
    ['D:\\', 'win32', 'C:\\Users\\w'],
    ['c:\\users', 'win32', 'C:\\Users\\w'],
    ['C:\\Users\\W', 'win32', 'C:\\Users\\w'],
  ])('%s is too broad (%s)', (dir, platform, home) => {
    expect(isTooBroad(dir, platform as NodeJS.Platform, home)).toBe(true);
  });

  test.each([
    ['/home/w/code/api', 'linux', '/home/w'],
    ['/home/wx', 'linux', '/home/w'],
    ['C:\\Users\\w\\code', 'win32', 'C:\\Users\\w'],
  ])('%s is fine (%s)', (dir, platform, home) => {
    expect(isTooBroad(dir, platform as NodeJS.Platform, home)).toBe(false);
  });

  test('a Claude session that fell back to the home folder does not make it a repo', () => {
    const fellBack = [{ groupId: 'g2', workingDir: '/home/w', shellType: 'claude' }];
    expect(findKnownRepo('/home/w', [], fellBack, 'linux', '/home/w')).toBeNull();
    expect(findKnownRepo('/', [{ id: 'g', name: 'Root', workingDir: '/' }], [], 'linux', '/home/w')).toBeNull();
  });

  test('the real home folder is excluded by default', () => {
    expect(knownRepos([], [{ groupId: 'g', workingDir: os.homedir(), shellType: 'claude' }], process.platform)).toEqual([]);
  });
});
