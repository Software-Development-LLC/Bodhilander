import { describe, expect, test } from 'bun:test';
import { buildRunSettings, namedDenyCovers, projectsEntry } from '../sandbox-settings';
import { hirePaths } from '../scope';

const paths = hirePaths('/ud', 'h1');
const input = (scope: 'owner' | 'circle') => ({
  paths, scope, configDir: '/acct/a1', accountDirs: ['/acct/a1', '/acct/a2'], userData: '/ud',
  userDataEntries: ['crew', 'bodhilander.db', 'claude-accounts'], crewEntries: ['h1', 'h2'], home: '/Users/b',
  sockets: ['/tmp/cr-501/h1.sock'], socketRoot: '/tmp/cr-501', allowedDomains: ['api.anthropic.com'],
});

describe('run settings', () => {
  test('an owner run writes its hire folder only, and reads no account, keychain, other hire or userData', () => {
    const s = buildRunSettings(input('owner'));
    expect(s.autoMemoryEnabled).toBe(false);
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/ud/crew/h1/owner', '/ud/crew/h1/circle']);
    expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['/acct/a1', '/acct/a2', '/Users/b/Library/Keychains', '/ud/crew/h2', '/ud/bodhilander.db', '/ud/claude-accounts']));
    expect(s.sandbox.filesystem.denyRead).not.toContain('/ud/crew/h1');
    expect(s.sandbox.filesystem.denyWrite).toEqual(expect.arrayContaining(['/ud/crew/h1/.claude', '/ud/crew/h1/CLAUDE.md', paths.skills, '/tmp/cr-501']));
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Read(//acct/a1/**)', 'Read(//proc/**)', 'Grep(//dev/fd/**)', 'Write(//ud/crew/h1/CLAUDE.md)', 'Edit(//ud/crew/h1/.claude/**)']));
    expect(s.sandbox.network).toEqual({ allowedDomains: ['api.anthropic.com'], allowUnixSockets: ['/tmp/cr-501/h1.sock'] });
  });

  test('no run can read the owner\'s credential stores under home', () => {
    for (const scope of ['owner', 'circle'] as const) {
      const s = buildRunSettings(input(scope));
      for (const p of ['.ssh', '.aws', '.config/gh', '.gnupg', '.netrc', '.docker', '.kube', '.npmrc', '.git-credentials', 'Library/Application Support/Google/Chrome']) {
        expect(s.sandbox.filesystem.denyRead).toContain(`/Users/b/${p}`);
        expect(s.permissions.deny).toContain(`Read(//Users/b/${p}/**)`);
      }
    }
  });

  test('a circle run cannot read or write the owner folder or its transcripts', () => {
    const s = buildRunSettings(input('circle'));
    expect(s.sandbox.filesystem.allowWrite).toEqual([paths.circle]);
    const proj = projectsEntry('/acct/a1', paths.owner);
    expect(proj).toBe('/acct/a1/projects/-ud-crew-h1-owner');
    expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining([paths.owner, proj]));
    expect(s.permissions.deny).toEqual(expect.arrayContaining([`Read(/${paths.owner}/**)`, `Write(/${paths.owner}/**)`]));
    expect(buildRunSettings(input('owner')).sandbox.filesystem.denyRead).not.toContain(paths.owner);
  });

  test('a relative path is refused', () => {
    expect(() => buildRunSettings({ ...input('owner'), configDir: 'acct' })).toThrow('must be absolute');
  });
});


describe('reads denied by default on macOS', () => {
  const UD = '/Users/b/Library/Application Support/bodhilander';
  const homePaths = hirePaths(UD, 'h1');
  const tree: Record<string, string[]> = {
    '/Users': ['b', 'alice', 'Shared'],
    '/Users/b': ['Library', 'Documents', '.ssh'],
    '/Users/b/Library': ['Application Support', 'Keychains'],
    '/Users/b/Library/Application Support': ['bodhilander', 'Google'],
    [UD]: ['crew', 'bodhilander.db'],
    [`${UD}/crew`]: ['h1', 'h2'],
  };
  const homeInput = (scope: 'owner' | 'circle', over: Record<string, unknown> = {}) => ({
    ...input(scope), paths: homePaths, userData: UD, userDataEntries: ['crew', 'bodhilander.db'], listDir: (d: string) => tree[d] ?? [], ...over,
  });

  test("a run never reads its own run/ folder, where its MCP token sits, nor the owner's ~/.claude.json", () => {
    const withConfig = (d: string) => (d === '/Users/b' ? [...tree[d], '.claude.json'] : tree[d] ?? []);
    for (const scope of ['owner', 'circle'] as const) {
      const s = buildRunSettings(homeInput(scope, { listDir: withConfig, home: '/Users/b' }));
      const { allowRead, denyRead } = s.sandbox.filesystem;
      expect(denyRead).toContain('/Users');
      expect(allowRead.some((a) => homePaths.run === a || homePaths.run.startsWith(`${a}/`))).toBe(false);
      expect(allowRead.some((a) => '/Users/b/.claude.json'.startsWith(`${a}/`) || a === '/Users/b')).toBe(false);
      expect(s.permissions.deny).toEqual(expect.arrayContaining([`Read(/${homePaths.run}/**)`, 'Read(//Users/b/.claude.json)', 'Grep(//Users/b/.claude.json)']));
    }
  });

  test('Bash reads nothing under /Users or /Volumes but what is re-opened, and the named denies stay', () => {
    const s = buildRunSettings(input('owner'));
    expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['/Users', '/Volumes', '/System/Volumes/Data/Users', '/acct/a1', '/Users/b/.ssh', '/ud/crew/h2']));
  });

  test('an owner run re-opens its scope roots, clones and its own run inputs, never run/; it writes owner, circle and clones', () => {
    const s = buildRunSettings({ ...input('owner'), clones: ['/ud/crew/h1/owner/repos/app'] });
    expect(s.sandbox.filesystem.allowRead).toEqual([paths.owner, paths.circle, '/ud/crew/h1/owner/repos/app', paths.skills, paths.shell, paths.ghConfig, paths.git]);
    expect(s.sandbox.filesystem.allowRead).not.toContain(paths.run);
    expect(s.sandbox.filesystem.allowWrite).toEqual([paths.owner, paths.circle, '/ud/crew/h1/owner/repos/app']);
    expect(s.sandbox.filesystem.denyWrite).toContain(paths.git);
  });

  test('a circle run re-opens circle and clones, never owner, and writes circle only', () => {
    const s = buildRunSettings({ ...input('circle'), clones: ['/ud/crew/h1/clones/app'] });
    expect(s.sandbox.filesystem.allowRead).toEqual([paths.circle, '/ud/crew/h1/clones/app', paths.skills, paths.shell, paths.ghConfig, paths.git]);
    expect(s.sandbox.filesystem.allowWrite).toEqual([paths.circle]);
  });

  test('the app bundle and claude are re-opened only where a default deny covers them', () => {
    const s = buildRunSettings({ ...input('owner'), reopen: ['/Applications/Bodhilander.app', '/Users/b/.local/share/claude/versions', '/Volumes/Dev/Bodhilander/resources/crew/gh-shim'] });
    expect(s.sandbox.filesystem.allowRead).toEqual(expect.arrayContaining(['/Users/b/.local/share/claude/versions', '/Volumes/Dev/Bodhilander/resources/crew/gh-shim']));
    expect(s.sandbox.filesystem.allowRead).not.toContain('/Applications/Bodhilander.app');
  });

  test('a named deny under a re-opened path is refused rather than written', () => {
    expect(() => buildRunSettings({ ...input('owner'), clones: ['/acct'] })).toThrow('named deny');
  });

  test('the file tools are denied every entry at each level from /Users to the crew folder but the step toward the hire', () => {
    const deny = buildRunSettings(homeInput('owner')).permissions.deny;
    for (const p of ['/Users/alice', '/Users/Shared', '/Users/b/Documents', '/Users/b/.ssh', '/Users/b/Library/Keychains', '/Users/b/Library/Application Support/Google', `${UD}/bodhilander.db`, `${UD}/crew/h2`, '/Volumes', '/System/Volumes/Data/Users', homePaths.run]) {
      expect(deny).toContain(`Read(/${p}/**)`);
      expect(deny).toContain(`Grep(/${p}/**)`);
    }
    for (const p of ['/Users', '/Users/b', '/Users/b/Library', '/Users/b/Library/Application Support', UD, `${UD}/crew`, homePaths.root, homePaths.owner]) {
      expect(deny).not.toContain(`Read(/${p}/**)`);
    }
  });

  test('a hire folder under /Users with no listing is refused, so the levels are never skipped', () => {
    expect(() => buildRunSettings(homeInput('owner', { listDir: undefined }))).toThrow('listing');
  });

  test('send_file is checked against the named denies, not the default /Users deny', () => {
    const i = homeInput('circle');
    expect(namedDenyCovers(i, '/Users/b/.ssh/id_ed25519')).toBe(true);
    expect(namedDenyCovers(i, '/acct/a1/.credentials.json')).toBe(true);
    expect(namedDenyCovers(i, `${homePaths.owner}/notes.md`)).toBe(true);
    expect(namedDenyCovers(i, `${UD}/crew/h2/owner/x`)).toBe(true);
    expect(namedDenyCovers(i, `${homePaths.circle}/report.pdf`)).toBe(false);
    expect(namedDenyCovers(i, '/Users/b/Documents/report.pdf')).toBe(false);
  });
});
