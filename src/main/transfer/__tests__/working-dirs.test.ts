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

  test('unrelated trees each get a root, ordered for a human to read', () => {
    const roots = collectWorkingDirRoots(['/Users/will/code/a', '/opt/services/b']);
    // Alphabetical, not by code point: the user reads this list to say where
    // each root went, so `/opt` sorting before `/Users` is the point.
    expect(roots).toEqual(['/opt/services/b', '/Users/will/code/a']);
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

describe('UNC destinations', () => {
  test('a child keeps both leading separators', () => {
    const mapped = remapWorkingDir('/Users/will/Repos/A', [
      { from: '/Users/will/Repos', to: '\\\\nas2\\share\\R' },
    ]);
    expect(mapped).toBe('\\\\nas2\\share\\R\\A');
  });

  test('an exact match returns the share path unchanged', () => {
    const mapped = remapWorkingDir('/Users/will/Repos', [
      { from: '/Users/will/Repos', to: '\\\\nas2\\share\\R' },
    ]);
    expect(mapped).toBe('\\\\nas2\\share\\R');
  });

  test('a UNC source is surfaced as a root with its server and share intact', () => {
    const roots = collectWorkingDirRoots(['\\\\nas2\\share\\R\\A', '\\\\nas2\\share\\R\\B']);
    expect(roots).toEqual(['\\\\nas2\\share\\R']);
  });

  test('the server and share are never treated as remappable segments', () => {
    const roots = collectWorkingDirRoots(['\\\\nas2\\share\\only']);
    expect(roots).toEqual(['\\\\nas2\\share\\only']);
  });

  test('a UNC subject is rewritten onto a local folder', () => {
    const mapped = remapWorkingDir('\\\\nas2\\share\\R\\A', [
      { from: '\\\\nas2\\share\\R', to: '/home/will/src' },
    ]);
    expect(mapped).toBe('/home/will/src/A');
  });
});

describe('windows case-insensitivity', () => {
  test('a drive spelled differently is still one root', () => {
    expect(collectWorkingDirRoots(['D:\\Projects\\a', 'd:\\projects\\b'])).toEqual(['D:\\Projects']);
  });

  test('a mapping applies regardless of how the drive was typed', () => {
    const mapped = remapWorkingDir('D:\\Projects\\App', [{ from: 'd:\\projects', to: '/srv' }]);
    expect(mapped).toBe('/srv/App');
  });

  test('the tail keeps the spelling the session actually used', () => {
    const mapped = remapWorkingDir('D:\\Projects\\MyApp', [{ from: 'D:\\projects', to: 'E:\\work' }]);
    expect(mapped).toBe('E:\\work\\MyApp');
  });

  test('posix paths stay case-sensitive, because their filesystems are', () => {
    // Folded, these two would collapse into the single chain /srv/Apps/a.
    expect(collectWorkingDirRoots(['/srv/Apps/a', '/srv/apps/a'])).toEqual(['/srv']);
    expect(remapWorkingDir('/srv/Apps', [{ from: '/srv/apps', to: '/mnt' }])).toBe('/srv/Apps');
  });
});

describe('volume roots', () => {
  test('a session at a posix volume root is still offered for mapping', () => {
    expect(collectWorkingDirRoots(['/'])).toEqual(['/']);
  });

  test('a session at a windows drive root is still offered for mapping', () => {
    expect(collectWorkingDirRoots(['C:\\'])).toEqual(['C:\\']);
  });

  test('a volume root sits beside the deeper roots on the same volume', () => {
    expect(collectWorkingDirRoots(['C:\\', 'C:\\Work\\a', 'C:\\Work\\b'])).toEqual(['C:\\', 'C:\\Work']);
  });
});
