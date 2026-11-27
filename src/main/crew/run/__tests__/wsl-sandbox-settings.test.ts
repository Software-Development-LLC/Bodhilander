import { describe, expect, test } from 'bun:test';
import { WSL_BIN_DIR, WSL_NODE_DIR, buildWslRunSettings, wslHirePaths, type WslSandboxInput } from '../sandbox-settings';

const H = '/home/crew/.bodhilander/crew/hires/h1';
const input = (over: Partial<WslSandboxInput> = {}): WslSandboxInput => ({
  hireId: 'h1',
  scope: 'owner',
  uid: 1000,
  configDir: '/home/crew/.bodhilander/crew/accounts/a1',
  accountDirs: ['/home/crew/.bodhilander/crew/accounts/a2'],
  clones: [`${H}/projects/repo`],
  runDir: '/tmp/cr-1000/abcdefgh',
  tmpDir: '/tmp/crt-1000/0123456789abcdef0123456789abcdef',
  levels: {
    '/home': ['crew', 'ubuntu'],
    '/home/crew': ['.bodhilander', '.bashrc'],
    '/home/crew/.bodhilander': ['crew'],
    '/home/crew/.bodhilander/crew': ['hires', 'accounts', 'node', 'bin'],
    '/home/crew/.bodhilander/crew/hires': ['h1', 'h2'],
  },
  allowedDomains: ['api.anthropic.com'],
  ...over,
});

describe('WSL2 run settings', () => {
  test('reads are denied by default: /home and /mnt whole, plus the WSL and WSLg paths and the socket root', () => {
    const fs = buildWslRunSettings(input()).sandbox.filesystem;
    for (const p of ['/home', '/mnt', '/run/WSL', '/init', '/mnt/wslg', '/tmp/.X11-unix', '/tmp/cr-1000', '/tmp/cc-socks', '/tmp/cc-socks-1000']) expect(fs.denyRead).toContain(p);
    expect(fs.denyRead).toContain('/tmp/crt-1000/0123456789abcdef0123456789abcdef/cc-socks');
  });

  test('only the run own paths are opened again, the install dirs read-only', () => {
    const s = buildWslRunSettings(input()).sandbox;
    expect(s.filesystem.allowRead).toEqual([`${H}/owner`, `${H}/circle`, `${H}/projects/repo`, `${H}/skills`, `${H}/empty-shell`, `${H}/gh-config`, `${H}/git`, WSL_NODE_DIR, WSL_BIN_DIR, '/tmp/cr-1000/abcdefgh']);
    expect(s.filesystem.denyWrite).toEqual(expect.arrayContaining([WSL_NODE_DIR, WSL_BIN_DIR, '/mnt', '/run/WSL', '/init']));
    expect(s.filesystem.allowRead).not.toContain(`${H}/run`);
    expect(s.network.allowAllUnixSockets).toBe(true);
    expect(s.network).not.toHaveProperty('allowUnixSockets');
  });

  test('a circle run reads and writes circle/ only', () => {
    const fs = buildWslRunSettings(input({ scope: 'circle' })).sandbox.filesystem;
    expect(fs.allowWrite).toEqual([`${H}/circle`, '/tmp/crt-1000/0123456789abcdef0123456789abcdef']);
    expect(fs.allowRead).not.toContain(`${H}/owner`);
    expect(fs.denyRead).toContain(`${H}/owner`);
  });

  test('the TMPDIR is writable and never under a denyRead', () => {
    const fs = buildWslRunSettings(input()).sandbox.filesystem;
    expect(fs.allowWrite).toContain('/tmp/crt-1000/0123456789abcdef0123456789abcdef');
    expect(() => buildWslRunSettings(input({ tmpDir: '/home/crew/tmp/x' }))).toThrow(/TMPDIR/);
    expect(() => buildWslRunSettings(input({ tmpDir: '/tmp/cr-1000/x' }))).toThrow(/TMPDIR/);
  });

  test('every account dir is denied, ours included', () => {
    const s = buildWslRunSettings(input());
    expect(s.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['/home/crew/.bodhilander/crew/accounts/a1', '/home/crew/.bodhilander/crew/accounts/a2']));
    expect(s.permissions.deny).toContain('Read(//home/crew/.bodhilander/crew/accounts/a1/**)');
  });

  test('the file tools deny every entry beside the hire path at each level, and /mnt', () => {
    const deny = buildWslRunSettings(input()).permissions.deny;
    for (const p of ['/home/ubuntu', '/home/crew/.bashrc', '/home/crew/.bodhilander/crew/accounts', '/home/crew/.bodhilander/crew/node', '/home/crew/.bodhilander/crew/hires/h2', '/mnt']) expect(deny).toContain(`Read(/${p})`);
    for (const p of ['/home/crew', '/home/crew/.bodhilander/crew/hires/h1']) expect(deny).not.toContain(`Read(/${p})`);
  });

  test('a run dir outside the socket root is refused', () => {
    expect(() => buildWslRunSettings(input({ runDir: '/tmp/elsewhere' }))).toThrow();
  });

  test('paths are posix whatever the host', () => {
    expect(wslHirePaths('h1').owner).toBe(`${H}/owner`);
  });
});
