/**
 * Root derivation and remapping, across the platform mixes an actual handoff
 * produces. Run with: bun test src/main/transfer
 */
import { describe, expect, test } from 'bun:test';
import { collectWorkingDirRoots, remapWorkingDir } from '../working-dirs';

describe('collectWorkingDirRoots', () => {
  test('collapses siblings to the directory where they branch', () => {
    const roots = collectWorkingDirRoots([
      '/Users/will/Work/Repos/Bodhilander',
      '/Users/will/Work/Repos/bodhi-service-api',
    ]);
    expect(roots).toEqual(['/Users/will/Work/Repos']);
  });

  test('a lone directory is its own root', () => {
    expect(collectWorkingDirRoots(['/Users/will/Work/Repos/Bodhilander'])).toEqual([
      '/Users/will/Work/Repos/Bodhilander',
    ]);
  });

  test('unrelated trees each get a root', () => {
    const roots = collectWorkingDirRoots(['/Users/will/code/a', '/opt/services/b']);
    expect(roots).toEqual(['/Users/will/code/a', '/opt/services/b']);
  });

  test('a directory that is itself a parent of another stops the descent', () => {
    const roots = collectWorkingDirRoots([
      '/Users/will/Work/Repos',
      '/Users/will/Work/Repos/Bodhilander',
    ]);
    expect(roots).toEqual(['/Users/will/Work/Repos']);
  });

  test('windows drives are separate roots and keep their separator', () => {
    const roots = collectWorkingDirRoots(['D:\\Projects\\a', 'D:\\Projects\\b', 'C:\\Temp\\x']);
    expect(roots).toEqual(['C:\\Temp\\x', 'D:\\Projects']);
  });

  test('empty and duplicate directories contribute nothing', () => {
    const roots = collectWorkingDirRoots(['', '  ', '/srv/x', '/srv/x']);
    expect(roots).toEqual(['/srv/x']);
  });

  test('the result is sorted so two exports of one machine agree', () => {
    const a = collectWorkingDirRoots(['/b/one', '/a/two']);
    const b = collectWorkingDirRoots(['/a/two', '/b/one']);
    expect(a).toEqual(b);
  });
});

describe('remapWorkingDir', () => {
  test('rewrites a posix root onto a windows one', () => {
    const mapped = remapWorkingDir('/Users/will/Work/Repos/Bodhilander', [
      { from: '/Users/will/Work/Repos', to: 'D:\\Projects' },
    ]);
    expect(mapped).toBe('D:\\Projects\\Bodhilander');
  });

  test('rewrites a windows root onto a posix one', () => {
    const mapped = remapWorkingDir('D:\\Projects\\app\\web', [
      { from: 'D:\\Projects', to: '/home/will/src' },
    ]);
    expect(mapped).toBe('/home/will/src/app/web');
  });

  test('an exact match becomes the destination itself', () => {
    expect(remapWorkingDir('/srv/x', [{ from: '/srv/x', to: '/mnt/x' }])).toBe('/mnt/x');
  });

  test('the longest matching root wins', () => {
    const mapped = remapWorkingDir('/a/b/c/d', [
      { from: '/a', to: '/short' },
      { from: '/a/b/c', to: '/long' },
    ]);
    expect(mapped).toBe('/long/d');
  });

  test('a sibling that merely shares a prefix string is not rewritten', () => {
    expect(remapWorkingDir('/a/bcd', [{ from: '/a/b', to: '/x' }])).toBe('/a/bcd');
  });

  test('an unmapped directory comes back unchanged', () => {
    expect(remapWorkingDir('/a/b', [{ from: '/c', to: '/d' }])).toBe('/a/b');
  });

  test('an empty destination is ignored rather than blanking the directory', () => {
    expect(remapWorkingDir('/a/b', [{ from: '/a', to: '' }])).toBe('/a/b');
  });
});
