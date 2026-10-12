import { describe, expect, test } from 'bun:test';
import { discoverPrArgv, readDiscoveredPr, repoSlugFromUrl } from '../pr-discovery';

describe('finding the PR the scribe opened', () => {
  test('asks gh by branch, in every state, with the fields the run needs', () => {
    // --state all: a merged PR is still the run's PR, and a run reconciling
    // after a merge must find it rather than conclude one was never opened.
    const argv = discoverPrArgv('feat/BDH-239-Bodhilander');
    expect(argv.slice(0, 4)).toEqual(['pr', 'list', '--head', 'feat/BDH-239-Bodhilander']);
    expect(argv).toContain('all');
    expect(argv[argv.indexOf('--json') + 1]).toBe('number,url,state');
  });

  test('an open PR is chosen over a closed one for the same branch', () => {
    const out = JSON.stringify([
      { number: 290, url: 'https://github.com/o/r/pull/290', state: 'CLOSED' },
      { number: 299, url: 'https://github.com/o/r/pull/299', state: 'OPEN' },
    ]);
    expect(readDiscoveredPr(out)).toEqual({ number: 299, url: 'https://github.com/o/r/pull/299' });
  });

  test('with no open PR, the most recent one is the run’s', () => {
    // The scribe's PR merged while the run was between ticks. It is still
    // the PR to reconcile against.
    const out = JSON.stringify([
      { number: 12, url: 'https://github.com/o/r/pull/12', state: 'MERGED' },
      { number: 40, url: 'https://github.com/o/r/pull/40', state: 'MERGED' },
    ]);
    expect(readDiscoveredPr(out)?.number).toBe(40);
  });

  test('no PR is null, not a guess', () => {
    expect(readDiscoveredPr('[]')).toBeNull();
  });

  test.each([['not json'], ['{}'], ['null'], ['[{"number":"7","url":"x"}]'], ['[{"number":7}]']])(
    'malformed output %p is null, because attaching to the wrong PR reconciles someone else’s checks',
    (out) => {
      expect(readDiscoveredPr(out)).toBeNull();
    },
  );
});

describe('the repository a PR belongs to', () => {
  test('is read from the PR’s own URL', () => {
    // The registry knows paths, not slugs. The URL is the one place GitHub
    // writes owner and name together.
    expect(repoSlugFromUrl('https://github.com/Software-Development-LLC/Bodhilander/pull/299')).toBe(
      'Software-Development-LLC/Bodhilander',
    );
  });

  test('anything that is not a PR URL is null', () => {
    for (const bad of ['', 'Bodhilander', 'https://github.com/o/r', 'https://github.com/o/r/issues/5', 'o/r/pull/3']) {
      expect(repoSlugFromUrl(bad)).toBeNull();
    }
  });

  test('a GitHub Enterprise host is fine; the host is not part of the slug', () => {
    expect(repoSlugFromUrl('https://git.example.com/team/thing/pull/1')).toBe('team/thing');
  });
});
