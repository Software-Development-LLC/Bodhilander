/**
 * Proposing where a source machine's roots live here.
 *
 * The load-bearing property is not how many roots it finds — it is that it
 * declines to answer when it does not know. A wrong proposal that somebody
 * clicks through moves every session under a root to a tree that merely shares
 * a name, and the failure is silent: the sessions start, in the wrong place.
 */
import { describe, expect, test } from 'bun:test';
import { mappingsFrom, suggestRootMappings, type SuggestOptions } from '../root-suggest';

/**
 * A filesystem as a set of absolute directory paths. Every parent of a listed
 * path is implied, so a fixture names only its leaves.
 */
function fs(paths: string[], separator = '/'): Pick<SuggestOptions, 'readSubdirs' | 'directoryExists'> {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split(separator);
    for (let i = 1; i <= parts.length; i++) {
      const joined = parts.slice(0, i).join(separator);
      if (joined) dirs.add(joined);
    }
  }
  return {
    directoryExists: (dir) => dirs.has(dir),
    readSubdirs: (dir) => {
      const prefix = dir.endsWith(separator) ? dir : dir + separator;
      const names = new Set<string>();
      for (const candidate of dirs) {
        if (!candidate.startsWith(prefix)) continue;
        const rest = candidate.slice(prefix.length);
        if (rest && !rest.includes(separator)) names.add(rest);
      }
      return [...names];
    },
  };
}

describe('proposing a root mapping', () => {
  test('finds the same tail under a different home, which is the whole point', () => {
    const suggestions = suggestRootMappings(['/Users/will/Work/Repos'], {
      bases: ['/home/will'],
      ...fs(['/home/will/Work/Repos/Bodhilander', '/home/will/Downloads']),
    });

    expect(suggestions).toEqual([
      // 3, not 2: `will` is shared as well as `Work/Repos`. The home
      // directory's own name is the only component that differs.
      { from: '/Users/will/Work/Repos', to: '/home/will/Work/Repos', matchedSegments: 3, unchanged: false },
    ]);
    expect(mappingsFrom(suggestions)).toEqual([{ from: '/Users/will/Work/Repos', to: '/home/will/Work/Repos' }]);
  });

  test('prefers the deeper tail over a bare name collision', () => {
    // `/home/will/archive/Repos` matches on one component. The real one
    // matches on two, and must win rather than making this ambiguous.
    const suggestions = suggestRootMappings(['/Users/will/Work/Repos'], {
      bases: ['/home/will'],
      ...fs(['/home/will/Work/Repos', '/home/will/archive/Repos']),
    });

    expect(suggestions).toEqual([
      { from: '/Users/will/Work/Repos', to: '/home/will/Work/Repos', matchedSegments: 3, unchanged: false },
    ]);
  });

  test('says nothing when two places match equally well', () => {
    // Neither is more right than the other, and picking one silently relocates
    // every session under the root. The user gets asked instead.
    const suggestions = suggestRootMappings(['/Users/will/code'], {
      bases: ['/home/will'],
      ...fs(['/home/will/personal/code', '/home/will/work/code']),
    });

    expect(suggestions).toEqual([]);
  });

  test('says nothing when nothing matches at all', () => {
    const suggestions = suggestRootMappings(['/Users/will/Work/Repos'], {
      bases: ['/home/will'],
      ...fs(['/home/will/Documents', '/home/will/Downloads']),
    });

    expect(suggestions).toEqual([]);
  });

  test('reports a root already at this path as unchanged, and proposes no move', () => {
    const suggestions = suggestRootMappings(['/home/will/Work/Repos'], {
      bases: ['/home/will'],
      ...fs(['/home/will/Work/Repos']),
    });

    expect(suggestions).toEqual([
      { from: '/home/will/Work/Repos', to: '/home/will/Work/Repos', matchedSegments: 4, unchanged: true },
    ]);
    // Nothing to remap — `remapWorkingDir` would leave these alone anyway, and
    // a mapping from a path to itself is noise in the confirmation.
    expect(mappingsFrom(suggestions)).toEqual([]);
  });

  test('crosses platforms, which is the case a manifest exists for', () => {
    const suggestions = suggestRootMappings(['C:\\Users\\will\\Work\\Repos'], {
      bases: ['/home/will'],
      ...fs(['/home/will/Work/Repos']),
    });

    expect(suggestions).toEqual([
      { from: 'C:\\Users\\will\\Work\\Repos', to: '/home/will/Work/Repos', matchedSegments: 3, unchanged: false },
    ]);
  });

  test('folds case when either side is a Windows path, and not when neither is', () => {
    const windows = suggestRootMappings(['C:\\Users\\will\\work\\repos'], {
      bases: ['/home/will'],
      ...fs(['/home/will/Work/Repos']),
    });
    expect(windows[0]?.to).toBe('/home/will/Work/Repos');

    // Both posix: `repos` and `Repos` are different directories, and a machine
    // that has both must not be told they are the same one.
    const posix = suggestRootMappings(['/Users/will/work/repos'], {
      bases: ['/home/will'],
      ...fs(['/home/will/Work/Repos']),
    });
    expect(posix).toEqual([]);
  });

  test('answers each root independently, so one unknown does not sink the rest', () => {
    const suggestions = suggestRootMappings(['/Users/will/Work/Repos', '/Users/will/nowhere'], {
      bases: ['/home/will'],
      ...fs(['/home/will/Work/Repos']),
    });

    expect(suggestions.map((s) => s.from)).toEqual(['/Users/will/Work/Repos']);
  });

  test('does not descend into the directories a checkout is never the root of', () => {
    // A vendored copy inside node_modules is not somebody's working tree, and
    // reaching it would both slow the walk and manufacture ambiguity.
    const visited: string[] = [];
    const backing = fs(['/home/will/proj/node_modules/thing/Repos', '/home/will/Work/Repos']);
    const suggestions = suggestRootMappings(['/Users/will/Work/Repos'], {
      bases: ['/home/will'],
      directoryExists: backing.directoryExists,
      readSubdirs: (dir) => {
        visited.push(dir);
        return backing.readSubdirs(dir);
      },
    });

    expect(suggestions[0]?.to).toBe('/home/will/Work/Repos');
    expect(visited.some((d) => d.includes('node_modules'))).toBe(false);
  });

  test('stops at the visit ceiling rather than walking an enormous home', () => {
    const wide = Array.from({ length: 500 }, (_, i) => `/home/will/d${i}/inner`);
    let reads = 0;
    const backing = fs([...wide, '/home/will/Work/Repos']);

    suggestRootMappings(['/Users/will/Work/Repos'], {
      bases: ['/home/will'],
      directoryExists: backing.directoryExists,
      readSubdirs: (dir) => {
        reads++;
        return backing.readSubdirs(dir);
      },
      maxVisits: 50,
    });

    // The budget bounds directories *visited*, so the number of listings it
    // performs stays in the same order rather than running to 500.
    expect(reads).toBeLessThan(60);
  });

  test('spends no listing at all once the budget is gone', () => {
    // Needs SEVERAL bases: the waste is within one depth level, where the
    // budget runs out on the first parent and the rest of the frontier would
    // still each pay for a readdir whose results are discarded.
    const backing = fs([
      '/home/a/one', '/home/a/two', '/home/a/three',
      '/home/b/four', '/home/c/five',
    ]);
    const listed: string[] = [];

    suggestRootMappings(['/Users/will/Work/Repos'], {
      bases: ['/home/a', '/home/b', '/home/c'],
      directoryExists: backing.directoryExists,
      readSubdirs: (dir) => {
        listed.push(dir);
        return backing.readSubdirs(dir);
      },
      maxVisits: 2,
    });

    // `/home/a` alone exhausts the budget. `/home/b` and `/home/c` are still
    // in the frontier behind it and must not be read.
    expect(listed).toEqual(['/home/a']);
  });

  test('an unreadable directory is empty, not fatal', () => {
    const backing = fs(['/home/will/Work/Repos']);
    const suggestions = suggestRootMappings(['/Users/will/Work/Repos'], {
      bases: ['/home/will', '/root'],
      directoryExists: backing.directoryExists,
      readSubdirs: (dir) => {
        if (dir === '/root') throw new Error('EACCES');
        return backing.readSubdirs(dir);
      },
    });

    expect(suggestions[0]?.to).toBe('/home/will/Work/Repos');
  });
});
