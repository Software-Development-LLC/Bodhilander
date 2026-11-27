import { describe, expect, test } from 'bun:test';
import { ArtifactError, IMAGE_MISMATCH, type CrewVersions } from '../artifacts';
import {
  InstallLock, LINK_REFUSED, USER_CONFLICT, WSL_CONF, checkInterop, classifyUser, interopRefused, machineCheck, parsePasswd, repairUser, runSetup, setupUser,
  type SetupDeps, type SetupStep,
} from '../wsl-setup';
import type { WslExec, WslResult } from '../wsl';

const versions: CrewVersions = {
  rootfs: { name: 'rootfs/u.tar.gz', sha256: 'a'.repeat(64) },
  node: { version: '24.22.3', file: 'node.tar.xz', sha256: 'b'.repeat(64) },
  claude: { version: '2.1.332' },
  crewAgent: { version: '1.0.0' },
  apt: { bubblewrap: '0.9.0', socat: '1.8.0.0' },
};

interface User { name: string; uid: number; gid: number }

/** A small model of the distro: its users, its files, what is installed, and every command run. */
class FakeDistro {
  listed: string | null = null;
  users: User[] = [{ name: 'root', uid: 0, gid: 0 }, { name: 'ubuntu', uid: 1000, gid: 1001 }];
  wslConf = '';
  shipped = { node: '', claude: '', agent: '' };
  aptOk = false;
  hiresContent = false;
  usermodFails = 0;
  interop: WslResult = { code: 1, stdout: '', stderr: '<3>WSL (12) ERROR: UtilAcceptVsock:281: accept4 failed 110' };
  calls: string[][] = [];

  exec: WslExec = async (args, opts) => {
    this.calls.push(args);
    const ok = (stdout = ''): WslResult => ({ code: 0, stdout, stderr: '' });
    const no = (stderr = 'failed'): WslResult => ({ code: 1, stdout: '', stderr });
    if (args[0] === '-l') return this.listed === null ? { code: 1, stdout: 'no installed distributions', stderr: '' } : ok(this.listed);
    if (args[0] === '--import') return (this.listed = '  NAME  STATE  VERSION\n  BodhiCrew  Stopped  2\n'), ok();
    if (args[0] === '--terminate' || args[0] === '--version') return ok('WSL version: 2.6.1.0');
    const cmd = args.slice(args.indexOf('--') + 1);
    const line = cmd.join(' ');
    switch (cmd[0]) {
      case 'getent':
        return ok(this.users.map((u) => `${u.name}:x:${u.uid}:${u.gid}::/home/${u.name}:/bin/bash`).join('\n'));
      case 'userdel':
        this.users = this.users.filter((u) => u.name !== cmd[2]);
        return ok();
      case 'useradd': {
        if (this.users.some((u) => u.uid === 1000)) return no('useradd: UID 1000 is not unique');
        this.users.push({ name: 'crew', uid: 1000, gid: 1000 });
        return ok();
      }
      case 'usermod': {
        if (this.usermodFails-- > 0) return no('usermod: user crew is currently used by process 42');
        const crew = this.users.find((u) => u.name === 'crew');
        if (crew) crew.uid = 1000;
        return ok();
      }
      case 'find':
        return ok(this.hiresContent ? '/home/crew/.bodhilander/crew/hires/h1' : '');
      case 'cat':
        return ok(this.wslConf);
      case '/mnt/c/Windows/System32/whoami.exe':
        return this.interop;
    }
    if (line.includes('/etc/wsl.conf')) return (this.wslConf = String(opts?.input ?? '')), ok();
    if (line.includes('groupdel') || line.includes('groupmod')) return ok();
    if (line.includes('node/bin/node --version') || cmd[0].endsWith('node/bin/node')) return this.shipped.node ? ok(`v${this.shipped.node}`) : no();
    if (cmd[0].endsWith('bin/claude')) return this.shipped.claude ? ok(`${this.shipped.claude} (Claude Code)`) : no();
    if (cmd[0].endsWith('bin/crew-agent')) return this.shipped.agent ? ok(this.shipped.agent) : no();
    if (line.includes('dpkg --compare-versions')) return this.aptOk ? ok() : no();
    if (line.includes('apt-get install')) return (this.aptOk = true), ok();
    if (line.includes('npm install')) return (this.shipped.claude = versions.claude.version), ok();
    if (line.includes('tar -xJf')) return (this.shipped.node = versions.node.version), ok();
    if (line.includes('crew-agent.tmp') || line.includes('crew-agent.mjs.tmp')) return (this.shipped.agent = versions.crewAgent.version), ok();
    return ok();
  };
}

function setup(d: FakeDistro, over: Partial<SetupDeps> = {}) {
  const steps: SetupStep[] = [];
  const removed: string[] = [];
  let linked = false;
  const deps: SetupDeps = {
    exec: d.exec,
    versions,
    linked: () => linked,
    link: async () => ((linked = true), true),
    download: async () => 'C:\\L\\download\\rootfs.tar.gz',
    removeFile: (f) => void removed.push(f),
    installDir: 'C:\\L\\wsl',
    shipped: { nodeTarball: 'node.tar.xz', claudePackage: 'claude.tgz', crewAgent: 'crew-agent.mjs' },
    source: { read: () => 'bytes' },
    onStep: (s) => void (steps.at(-1) === s || steps.push(s)),
    ...over,
  };
  return { deps, steps, removed };
}

const passwd = (...u: Array<[string, number, number]>) => u.map(([n, uid, gid]) => `${n}:x:${uid}:${gid}::/h:/bin/sh`).join('\n');

describe('the crew user', () => {
  test('classify: crew at 1000 is ok; nothing is absent; anything else conflicts', () => {
    expect(classifyUser(parsePasswd(passwd(['crew', 1000, 1000])))).toEqual({ state: 'ok' });
    expect(classifyUser(parsePasswd(passwd(['root', 0, 0])))).toEqual({ state: 'absent' });
    expect(classifyUser(parsePasswd(passwd(['crew', 1001, 1001])))).toEqual({ state: 'conflict', crewUid: 1001, uid1000: null });
    expect(classifyUser(parsePasswd(passwd(['dev', 1000, 1000])))).toEqual({ state: 'conflict', crewUid: null, uid1000: 'dev' });
  });

  test('a fresh rootfs loses ubuntu first, so crew gets uid 1000', async () => {
    const d = new FakeDistro();
    expect(await setupUser(d.exec)).toEqual({ ok: true });
    expect(d.users.map((u) => [u.name, u.uid])).toEqual([['root', 0], ['crew', 1000]]);
    const order = d.calls.map((c) => c[5]).filter(Boolean);
    expect(order.indexOf('userdel')).toBeLessThan(order.indexOf('useradd'));
  });

  test('re-running with crew already at 1000 changes nothing', async () => {
    const d = new FakeDistro();
    d.users = [{ name: 'root', uid: 0, gid: 0 }, { name: 'crew', uid: 1000, gid: 1000 }];
    expect(await setupUser(d.exec)).toEqual({ ok: true });
    expect(d.calls.some((c) => c.includes('useradd') || c.includes('userdel'))).toBe(false);
  });

  test('crew on another uid, or uid 1000 taken, holds with a clear message, never a useradd error', async () => {
    for (const users of [[{ name: 'crew', uid: 1001, gid: 1001 }], [{ name: 'dev', uid: 1000, gid: 1000 }]]) {
      const d = new FakeDistro();
      d.users = [{ name: 'root', uid: 0, gid: 0 }, ...users];
      const r = await setupUser(d.exec);
      expect(r).toMatchObject({ ok: false, hold: 'held:setup', message: USER_CONFLICT });
      expect(d.calls.some((c) => c.includes('useradd'))).toBe(false);
    }
  });

  test('Repair with no hires or accounts makes crew again at 1000', async () => {
    const d = new FakeDistro();
    d.users = [{ name: 'root', uid: 0, gid: 0 }, { name: 'dev', uid: 1000, gid: 1000 }, { name: 'crew', uid: 1001, gid: 1001 }];
    expect(await repairUser(d.exec)).toEqual({ ok: true });
    expect(d.users.map((u) => [u.name, u.uid])).toEqual([['root', 0], ['crew', 1000]]);
  });

  test('Repair with content fixes the uid in place, with chgrp of the old gid, and no export', async () => {
    const d = new FakeDistro();
    d.hiresContent = true;
    d.users = [{ name: 'root', uid: 0, gid: 0 }, { name: 'dev', uid: 1000, gid: 1000 }, { name: 'crew', uid: 1001, gid: 1001 }];
    expect(await repairUser(d.exec)).toEqual({ ok: true });
    expect(d.users.find((u) => u.name === 'crew')?.uid).toBe(1000);
    const lines = d.calls.map((c) => c.join(' '));
    expect(lines.some((l) => l.includes('userdel -r dev'))).toBe(true);
    expect(lines.some((l) => l.includes('usermod -u 1000 crew'))).toBe(true);
    expect(lines.some((l) => l.includes('-gid 1001 -exec chgrp -h crew'))).toBe(true);
    expect(lines.some((l) => l.includes('--export') || l.includes('--unregister'))).toBe(false);
  });

  test('a refused usermod terminates the distro once and retries', async () => {
    const d = new FakeDistro();
    d.hiresContent = true;
    d.usermodFails = 1;
    d.users = [{ name: 'root', uid: 0, gid: 0 }, { name: 'crew', uid: 1001, gid: 1001 }];
    expect(await repairUser(d.exec)).toEqual({ ok: true });
    expect(d.calls.filter((c) => c[0] === '--terminate')).toEqual([['--terminate', 'BodhiCrew']]);
  });

  test('a second refusal keeps the hold with the usermod error, so it cannot loop', async () => {
    const d = new FakeDistro();
    d.hiresContent = true;
    d.usermodFails = 5;
    d.users = [{ name: 'root', uid: 0, gid: 0 }, { name: 'crew', uid: 1001, gid: 1001 }];
    const r = await repairUser(d.exec);
    expect(r).toMatchObject({ ok: false, hold: 'held:setup', audit: { error: 'usermod: user crew is currently used by process 42' } });
    expect(d.calls.filter((c) => c[0] === '--terminate').length).toBe(1);
  });
});

describe('the interop check', () => {
  const r = (code: number | null, stderr: string, timedOut = false): WslResult => ({ code, stdout: '', stderr, timedOut });

  test('passes only on exit 1 with the vsock refusal', () => {
    expect(interopRefused(r(1, 'WSL ERROR: UtilAcceptVsock:281: accept4 failed 110'))).toBe(true);
    expect(interopRefused(r(0, 'crew-pc\\person'))).toBe(false);
    expect(interopRefused(r(127, 'whoami.exe: not found'))).toBe(false);
    expect(interopRefused(r(1, 'some other error'))).toBe(false);
    expect(interopRefused(r(1, 'UtilAcceptVsock', true))).toBe(false);
    expect(interopRefused(r(null, ''))).toBe(false);
  });

  test('a hold records the exit code, the first stderr line and wsl --version, with a 15 s limit', async () => {
    const d = new FakeDistro();
    d.interop = { code: 127, stdout: '', stderr: 'sh: whoami.exe: not found\nmore' };
    const timeouts: Array<number | undefined> = [];
    const exec: WslExec = (a, o) => (timeouts.push(o?.timeoutMs), d.exec(a, o));
    expect(await checkInterop(exec)).toEqual({
      ok: false, hold: 'held:setup', message: 'Crew setup on this PC needs repair',
      audit: { step: 'interop', exitCode: 127, stderr: 'sh: whoami.exe: not found', wslVersion: 'WSL version: 2.6.1.0' },
    });
    expect(timeouts[0]).toBe(15_000);
    expect(d.calls[0]).toEqual(['-d', 'BodhiCrew', '-u', 'crew', '--', '/mnt/c/Windows/System32/whoami.exe']);
  });

  test('a timeout holds', async () => {
    const d = new FakeDistro();
    d.interop = { code: null, stdout: '', stderr: '', timedOut: true };
    expect(await checkInterop(d.exec)).toMatchObject({ ok: false, audit: { exitCode: 'timeout' } });
  });
});

describe('the setup order', () => {
  test('a fresh PC: link, download, import, user, wsl.conf, installs, apt, interop, and ready', async () => {
    const d = new FakeDistro();
    const t = setup(d);
    expect(await runSetup(t.deps)).toEqual({ ok: true });
    expect(t.steps).toEqual(['wsl', 'link', 'download', 'import', 'user', 'wsl-conf', 'shipped', 'apt', 'interop']);
    expect(d.calls.find((c) => c[0] === '--import')).toEqual(['--import', 'BodhiCrew', 'C:\\L\\wsl', 'C:\\L\\download\\rootfs.tar.gz', '--version', '2']);
    expect(t.removed).toEqual(['C:\\L\\download\\rootfs.tar.gz']);
    expect(d.wslConf).toBe(WSL_CONF);
    const lines = d.calls.map((c) => c.join(' '));
    const useradd = lines.findIndex((l) => l.includes('useradd'));
    const conf = lines.findIndex((l) => l.includes('/etc/wsl.conf.crew'));
    expect(useradd).toBeGreaterThanOrEqual(0);
    expect(useradd).toBeLessThan(conf);
    expect(lines[conf + 1]).toBe('--terminate BodhiCrew');
  });

  test('wsl.conf turns interop off and makes crew the default user', () => {
    expect(WSL_CONF).toContain('[interop]\nenabled=false\nappendWindowsPath=false');
    expect(WSL_CONF).toContain('[user]\ndefault=crew');
    expect(WSL_CONF).toContain('[boot]\nsystemd=false');
  });

  test('a denied link stops before anything downloads', async () => {
    const d = new FakeDistro();
    let downloaded = false;
    const t = setup(d, { link: async () => false, download: async () => ((downloaded = true), 'x') });
    expect(await runSetup(t.deps)).toEqual({ ok: false, step: 'link', message: LINK_REFUSED });
    expect(downloaded).toBe(false);
    expect(d.calls.some((c) => c[0] === '--import')).toBe(false);
  });

  test('a linked PC skips the link step', async () => {
    const d = new FakeDistro();
    let asked = false;
    const t = setup(d, { linked: () => true, link: async () => ((asked = true), true) });
    await runSetup(t.deps);
    expect(asked).toBe(false);
  });

  test('a hash mismatch imports nothing', async () => {
    const d = new FakeDistro();
    const t = setup(d, { download: async () => Promise.reject(new ArtifactError('mismatch', IMAGE_MISMATCH)) });
    expect(await runSetup(t.deps)).toEqual({ ok: false, step: 'download', message: IMAGE_MISMATCH });
    expect(d.calls.some((c) => c[0] === '--import')).toBe(false);
  });

  test('an interrupted setup restarts at the first unfinished step', async () => {
    const d = new FakeDistro();
    d.listed = '  NAME  STATE  VERSION\n  BodhiCrew  Stopped  2\n';
    d.users = [{ name: 'root', uid: 0, gid: 0 }, { name: 'crew', uid: 1000, gid: 1000 }];
    d.wslConf = WSL_CONF;
    const t = setup(d);
    expect(await runSetup(t.deps)).toEqual({ ok: true });
    expect(t.steps).toEqual(['wsl', 'shipped', 'apt', 'interop']);
    expect(d.calls.some((c) => c[0] === '--import' || c.includes('useradd'))).toBe(false);
  });

  test('interop not refused leaves the PC unready, with Repair', async () => {
    const d = new FakeDistro();
    d.interop = { code: 0, stdout: 'pc\\person', stderr: '' };
    const out = await runSetup(setup(d).deps);
    expect(out).toMatchObject({ ok: false, step: 'interop', hold: 'held:setup', repair: true });
  });

  test('a build with no bundled Node or claude holds at the install step', async () => {
    const d = new FakeDistro();
    const out = await runSetup(setup(d, { shipped: { nodeTarball: null, claudePackage: null, crewAgent: 'a' } }).deps);
    expect(out).toMatchObject({ ok: false, step: 'shipped', hold: 'held:setup' });
  });
});

describe('the check before each run', () => {
  const ready = () => {
    const d = new FakeDistro();
    d.listed = '  NAME  STATE  VERSION\n  BodhiCrew  Stopped  2\n';
    d.users = [{ name: 'root', uid: 0, gid: 0 }, { name: 'crew', uid: 1000, gid: 1000 }];
    d.wslConf = WSL_CONF;
    d.shipped = { node: versions.node.version, claude: versions.claude.version, agent: versions.crewAgent.version };
    d.aptOk = true;
    return d;
  };

  test('passes on a finished setup, and never launches whoami.exe', async () => {
    const d = ready();
    expect(await machineCheck(d.exec, versions)).toEqual({ ok: true });
    expect(d.calls.some((c) => c.join(' ').includes('whoami'))).toBe(false);
  });

  test('a wsl.conf that reads back different, an older crew-agent or a missing socat holds', async () => {
    const conf = ready();
    conf.wslConf = WSL_CONF.replace('enabled=false', 'enabled=true');
    expect(await machineCheck(conf.exec, versions)).toMatchObject({ ok: false, audit: { step: 'wsl-conf' } });
    const agent = ready();
    agent.shipped.agent = '0.9.0';
    expect(await machineCheck(agent.exec, versions)).toMatchObject({ ok: false, audit: { shipped: ['crew-agent'] } });
    const apt = ready();
    apt.aptOk = false;
    expect(await machineCheck(apt.exec, versions)).toMatchObject({ ok: false, audit: { apt: ['bubblewrap', 'socat'] } });
  });

  test('a WSL1 BodhiCrew is never ready', async () => {
    const d = ready();
    d.listed = '  NAME  STATE  VERSION\n  BodhiCrew  Stopped  1\n';
    expect((await machineCheck(d.exec, versions)).ok).toBe(false);
  });
});

describe('the crew-agent install lock', () => {
  test('two runs that both see a mismatch reinstall once', async () => {
    const lock = new InstallLock();
    let installs = 0;
    let finish: (v: boolean) => void = () => {};
    const install = () => (installs++, new Promise<boolean>((r) => (finish = r)));
    const a = lock.run(install);
    const b = lock.run(install);
    finish(true);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(installs).toBe(1);
    await lock.run(async () => (installs++, true));
    expect(installs).toBe(2);
  });
});
