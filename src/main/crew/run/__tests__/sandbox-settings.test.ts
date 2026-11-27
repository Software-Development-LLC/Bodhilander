import { describe, expect, test } from 'bun:test';
import { buildRunSettings, projectsEntry } from '../sandbox-settings';
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
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/ud/crew/h1']);
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
