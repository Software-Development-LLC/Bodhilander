/**
 * The statusline sink: installing it without breaking a user's statusLine, and
 * what the script does with each turn. Run with: bun test <this file>
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { spawn, spawnSync } from 'child_process';

import {
  installStatuslineSink,
  SinkLaunch,
  sinkCommand,
  sinkLaunchFor,
  sinkReconciler,
  uninstallStatuslineSink,
} from '../statusline-sink';
import { chainEnv, readChainedCommand, recordRateLimits, runChainedCommand, runStatusline, shellPid, StatuslineDeps } from '../../hooks/bodhilander-statusline';
import { findGitBash } from '../git-bash';

const SCRIPT = '/opt/Bodhilander/dist/hooks/bodhilander-statusline.js';
const LAUNCH: SinkLaunch = { scriptPath: SCRIPT, execPath: '/opt/Bodhilander/Bodhilander', platform: 'darwin' };
let dir: string;
let ambient: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-sink-'));
  ambient = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-ambient-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(ambient, { recursive: true, force: true });
});

const settings = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
const writeSettings = (value: unknown) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(value));

describe('installStatuslineSink', () => {
  test('installs into a dir with no statusLine, keeping other settings', () => {
    writeSettings({ model: 'opus', hooks: { Stop: [] } });
    expect(installStatuslineSink(dir, LAUNCH)).toBe('installed');
    expect(settings()).toEqual({
      model: 'opus',
      hooks: { Stop: [] },
      statusLine: { type: 'command', command: sinkCommand(LAUNCH, dir) },
    });
    expect(readChainedCommand(dir)).toBeNull();
  });

  test('a user statusLine is chained to, and its padding kept', () => {
    writeSettings({ statusLine: { type: 'command', command: 'bash ~/.claude/line.sh', padding: 2 } });
    expect(installStatuslineSink(dir, LAUNCH)).toBe('installed');
    expect(settings().statusLine).toEqual({ type: 'command', command: sinkCommand(LAUNCH, dir), padding: 2 });
    expect(readChainedCommand(dir)).toBe('bash ~/.claude/line.sh');
  });

  test('the user’s other statusLine settings survive', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine', refreshInterval: 5, hideVimModeIndicator: true } });
    installStatuslineSink(dir, LAUNCH);
    expect(settings().statusLine).toEqual({
      type: 'command', command: sinkCommand(LAUNCH, dir), refreshInterval: 5, hideVimModeIndicator: true,
    });
  });

  test('a second install writes nothing and keeps the chain', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    installStatuslineSink(dir, LAUNCH);
    const mtime = fs.statSync(path.join(dir, 'settings.json')).mtimeMs;
    expect(installStatuslineSink(dir, LAUNCH)).toBe('unchanged');
    expect(fs.statSync(path.join(dir, 'settings.json')).mtimeMs).toBe(mtime);
    expect(readChainedCommand(dir)).toBe('echo mine');
  });

  test('a moved install updates the path without losing the chain', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    installStatuslineSink(dir, LAUNCH);
    const moved = { ...LAUNCH, scriptPath: '/Applications/Bodhilander.app/dist/hooks/bodhilander-statusline.js' };
    expect(installStatuslineSink(dir, moved)).toBe('updated');
    expect(settings().statusLine.command).toBe(sinkCommand(moved, dir));
    expect(readChainedCommand(dir)).toBe('echo mine');
  });

  test('a chain file outlives a settings.json rewritten without any statusLine', () => {
    installStatuslineSink(dir, LAUNCH);
    const byHand = '{"chain":{"command":"hand-line"}}';
    fs.writeFileSync(path.join(dir, 'bodhilander-statusline.json'), byHand);
    writeSettings({ model: 'opus' });
    expect(installStatuslineSink(dir, LAUNCH)).toBe('installed');
    expect(fs.readFileSync(path.join(dir, 'bodhilander-statusline.json'), 'utf-8')).toBe(byHand);
    expect(readChainedCommand(dir)).toBe('hand-line');
  });

  test('a settings.json saved with a byte-order mark is installed into, not refused', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '\uFEFF{"statusLine":{"type":"command","command":"echo mine"}}');
    expect(installStatuslineSink(dir, LAUNCH)).toBe('installed');
    expect(settings().statusLine.command).toBe(sinkCommand(LAUNCH, dir));
    expect(readChainedCommand(dir)).toBe('echo mine');
  });

  test('an empty settings.json is installed into', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '');
    expect(installStatuslineSink(dir, LAUNCH)).toBe('installed');
    expect(settings().statusLine.command).toBe(sinkCommand(LAUNCH, dir));
  });

  test('a statusLine the user set after ours becomes the new chain', () => {
    installStatuslineSink(dir, LAUNCH);
    writeSettings({ statusLine: { type: 'command', command: 'echo newer' } });
    expect(installStatuslineSink(dir, LAUNCH)).toBe('installed');
    expect(readChainedCommand(dir)).toBe('echo newer');
  });
});

describe('installStatuslineSink on a settings.json it cannot read', () => {
  test.each([['torn JSON', '{"model": "opus",'], ['an array', '[]'], ['a string', '"x"']])('%s is left untouched, chain and all', (_name, body) => {
    fs.writeFileSync(path.join(dir, 'bodhilander-statusline.json'), '{"chain":{"type":"command","command":"mine"}}');
    fs.writeFileSync(path.join(dir, 'settings.json'), body);
    expect(installStatuslineSink(dir, LAUNCH)).toBe('error');
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe(body);
    expect(readChainedCommand(dir)).toBe('mine');
  });

  test('a missing settings.json is created', () => {
    expect(installStatuslineSink(dir, LAUNCH)).toBe('installed');
    expect(settings().statusLine.command).toBe(sinkCommand(LAUNCH, dir));
  });
});

describe('uninstallStatuslineSink', () => {
  const chainFile = () => path.join(dir, 'bodhilander-statusline.json');

  test('puts back the statusLine it chained to, padding and all, and drops the record', () => {
    const mine = { type: 'command', command: 'bash ~/.claude/line.sh', padding: 2 };
    writeSettings({ model: 'opus', statusLine: mine });
    installStatuslineSink(dir, LAUNCH);
    expect(uninstallStatuslineSink(dir, ambient)).toBe('restored');
    expect(settings()).toEqual({ model: 'opus', statusLine: mine });
    expect(fs.existsSync(chainFile())).toBe(false);
  });

  test('a chained entry that names no type goes back as a command', () => {
    installStatuslineSink(dir, LAUNCH);
    fs.writeFileSync(chainFile(), '{"chain":{"command":"hand-line","padding":1}}');
    expect(uninstallStatuslineSink(dir, ambient)).toBe('restored');
    expect(settings().statusLine).toEqual({ type: 'command', command: 'hand-line', padding: 1 });
  });

  test('a chain file saved with a byte-order mark is read by the script and by uninstall', () => {
    installStatuslineSink(dir, LAUNCH);
    fs.writeFileSync(chainFile(), '\uFEFF{"chain":{"type":"command","command":"hand-line"}}');
    expect(readChainedCommand(dir)).toBe('hand-line');
    expect(uninstallStatuslineSink(dir, ambient)).toBe('restored');
    expect(settings().statusLine).toEqual({ type: 'command', command: 'hand-line' });
  });

  describe('from a dir that was showing the ambient statusLine', () => {
    const writeAmbient = (value: unknown) => fs.writeFileSync(path.join(ambient, 'settings.json'), JSON.stringify(value));

    test('the whole ambient entry is copied in, as a command', () => {
      writeAmbient({ statusLine: { command: 'ambient-line', padding: 2, refreshInterval: 5 } });
      writeSettings({ model: 'opus' });
      installStatuslineSink(dir, LAUNCH);
      expect(uninstallStatuslineSink(dir, ambient)).toBe('adopted');
      expect(settings()).toEqual({
        model: 'opus',
        statusLine: { type: 'command', command: 'ambient-line', padding: 2, refreshInterval: 5 },
      });
    });

    test('the copy is the dir\u2019s own from then on: turning the sink back on chains it', () => {
      writeAmbient({ statusLine: { type: 'command', command: 'ambient-line', padding: 2 } });
      installStatuslineSink(dir, LAUNCH);
      uninstallStatuslineSink(dir, ambient);
      expect(installStatuslineSink(dir, LAUNCH)).toBe('installed');
      expect(readChainedCommand(dir)).toBe('ambient-line');
      expect(uninstallStatuslineSink(dir, ambient)).toBe('restored');
      expect(settings().statusLine).toEqual({ type: 'command', command: 'ambient-line', padding: 2 });
    });

    test('a chain file is restored from as it stands, whatever the ambient dir holds', () => {
      writeAmbient({ statusLine: { type: 'command', command: 'ambient-line' } });
      writeSettings({ statusLine: { type: 'command', command: 'mine' } });
      installStatuslineSink(dir, LAUNCH);
      expect(uninstallStatuslineSink(dir, ambient)).toBe('restored');
      expect(settings().statusLine).toEqual({ type: 'command', command: 'mine' });
    });

    test('a chain file that names no command keeps the ambient entry out', () => {
      writeAmbient({ statusLine: { type: 'command', command: 'ambient-line' } });
      installStatuslineSink(dir, LAUNCH);
      fs.writeFileSync(chainFile(), '{"chain":null}');
      expect(uninstallStatuslineSink(dir, ambient)).toBe('removed');
      expect(settings().statusLine).toBeUndefined();
    });

    test.each([
      ['no statusLine', { model: 'opus' }],
      ['a blank command', { statusLine: { type: 'command', command: ' ' } }],
      ['a statusLine with no command', { statusLine: { type: 'command', padding: 2 } }],
      ['the sink itself', { statusLine: { type: 'command', command: sinkCommand(LAUNCH, '/elsewhere') } }],
    ])('an ambient dir with %s leaves the account with none', (_name, value) => {
      writeAmbient(value);
      installStatuslineSink(dir, LAUNCH);
      expect(uninstallStatuslineSink(dir, ambient)).toBe('removed');
      expect(settings().statusLine).toBeUndefined();
    });

    test('left to its default, the ambient dir is the home dir\u2019s .claude', () => {
      fs.mkdirSync(path.join(ambient, '.claude'));
      fs.writeFileSync(path.join(ambient, '.claude', 'settings.json'), '{"statusLine":{"type":"command","command":"from-home"}}');
      installStatuslineSink(dir, LAUNCH);
      const probe = path.join(ambient, 'probe.ts');
      const sink = path.join(__dirname, '..', 'statusline-sink.ts');
      fs.writeFileSync(probe, `import { uninstallStatuslineSink } from ${JSON.stringify(sink)};\nprocess.stdout.write(uninstallStatuslineSink(${JSON.stringify(dir)}));\n`);
      const run = spawnSync(process.execPath, [probe], {
        encoding: 'utf-8',
        env: { ...process.env, HOME: ambient, USERPROFILE: ambient },
      });
      expect(run.stdout.trim().split(/\s+/).pop()).toBe('adopted');
      expect(settings().statusLine).toEqual({ type: 'command', command: 'from-home' });
    });
  });

  test('with nothing chained, the statusLine is removed', () => {
    writeSettings({ model: 'opus' });
    installStatuslineSink(dir, LAUNCH);
    expect(uninstallStatuslineSink(dir, ambient)).toBe('removed');
    expect(settings()).toEqual({ model: 'opus' });
  });

  test('a statusLine that is not ours is left alone', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8');
    expect(uninstallStatuslineSink(dir, ambient)).toBe('unchanged');
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe(before);
  });

  test('an unreadable record of the user entry keeps ours rather than lose theirs', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    installStatuslineSink(dir, LAUNCH);
    fs.writeFileSync(chainFile(), '{"chain":');
    expect(uninstallStatuslineSink(dir, ambient)).toBe('error');
    expect(settings().statusLine.command).toBe(sinkCommand(LAUNCH, dir));
  });

  test('an unparseable settings.json is untouched', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"model": "opus",');
    expect(uninstallStatuslineSink(dir, ambient)).toBe('error');
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe('{"model": "opus",');
  });
});

describe('sinkReconciler', () => {
  test('turning it off, or losing the script, restores the user entry', () => {
    const mine = { type: 'command', command: 'echo mine' };
    for (const [launch, enabled] of [[LAUNCH, false], [null, true]] as const) {
      writeSettings({ statusLine: mine });
      expect(sinkReconciler(LAUNCH, () => true, ambient)(dir)).toBe('installed');
      expect(sinkReconciler(launch, () => enabled, ambient)(dir)).toBe('restored');
      expect(settings().statusLine).toEqual(mine);
    }
  });

  test('the preference is read on every reconcile, not captured once', () => {
    let enabled = true;
    const reconcile = sinkReconciler(LAUNCH, () => enabled, ambient);
    expect(reconcile(dir)).toBe('installed');
    enabled = false;
    expect(reconcile(dir)).toBe('removed');
  });
});

describe('the statusline script', () => {
  const turn = JSON.stringify({
    model: { id: 'claude-opus' },
    rate_limits: { five_hour: { used_percentage: 64, resets_at: 1790000000 } },
  });

  const writeAmbient = (value: unknown) => fs.writeFileSync(path.join(ambient, 'settings.json'), JSON.stringify(value));
  const chainFile = () => path.join(dir, 'bodhilander-statusline.json');
  const printing = (seen: string[]): StatuslineDeps => ({
    now: () => 1,
    ambientDir: ambient,
    runChain: async (command) => { seen.push(command); return `ran ${command}`; },
  });

  test('records rate_limits with the time it saw them', () => {
    expect(recordRateLimits(dir, turn, 1234)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'bodhilander-usage.json'), 'utf-8'))).toEqual({
      observedAt: 1234,
      rate_limits: { five_hour: { used_percentage: 64, resets_at: 1790000000 } },
    });
  });

  test('a turn without rate_limits, or garbage, writes nothing', () => {
    expect(recordRateLimits(dir, '{"model":{}}', 1)).toBe(false);
    expect(recordRateLimits(dir, 'not json', 1)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'bodhilander-usage.json'))).toBe(false);
  });

  test('passes the user command the same stdin and prints its output', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'my-line' } });
    installStatuslineSink(dir, LAUNCH);
    const seen: string[] = [];
    const out = await runStatusline(dir, turn, { now: () => 1, ambientDir: ambient, runChain: async (command, input) => { seen.push(command, input); return 'opus | 64%'; } });
    expect(out).toBe('opus | 64%');
    expect(seen).toEqual(['my-line', turn]);
  });

  test('with no user command it prints nothing', async () => {
    installStatuslineSink(dir, LAUNCH);
    expect(await runStatusline(dir, turn, { now: () => 1, ambientDir: ambient, runChain: async () => 'unexpected' })).toBe('');
  });

  test('a dir that had no statusLine of its own shows the ambient one', async () => {
    writeAmbient({ statusLine: { type: 'command', command: 'bash "$HOME/.claude/statusline.sh"' } });
    writeSettings({ model: 'opus' });
    expect(installStatuslineSink(dir, LAUNCH)).toBe('installed');
    expect(fs.existsSync(chainFile())).toBe(false);
    const seen: string[] = [];
    expect(await runStatusline(dir, turn, printing(seen))).toBe('ran bash "$HOME/.claude/statusline.sh"');
    expect(seen).toEqual(['bash "$HOME/.claude/statusline.sh"']);
  });

  test('the dir’s own chained command wins over the ambient one', async () => {
    writeAmbient({ statusLine: { type: 'command', command: 'ambient-line' } });
    writeSettings({ statusLine: { type: 'command', command: 'my-line' } });
    installStatuslineSink(dir, LAUNCH);
    expect(await runStatusline(dir, turn, printing([]))).toBe('ran my-line');
  });

  test('a chain file written by hand is used as it stands and survives a reconcile', async () => {
    writeAmbient({ statusLine: { type: 'command', command: 'ambient-line' } });
    installStatuslineSink(dir, LAUNCH);
    const byHand = '{"chain":{"command":"hand-line"}}';
    fs.writeFileSync(chainFile(), byHand);
    expect(installStatuslineSink(dir, LAUNCH)).toBe('unchanged');
    expect(fs.readFileSync(chainFile(), 'utf-8')).toBe(byHand);
    expect(await runStatusline(dir, turn, printing([]))).toBe('ran hand-line');
  });

  test('a chain file that names no command silences the ambient one', async () => {
    writeAmbient({ statusLine: { type: 'command', command: 'ambient-line' } });
    installStatuslineSink(dir, LAUNCH);
    fs.writeFileSync(chainFile(), '{"chain":null}');
    expect(await runStatusline(dir, turn, printing([]))).toBe('');
  });

  test('a torn chain file prints nothing rather than the ambient line', async () => {
    writeAmbient({ statusLine: { type: 'command', command: 'ambient-line' } });
    installStatuslineSink(dir, LAUNCH);
    fs.writeFileSync(chainFile(), '{"chain":');
    expect(await runStatusline(dir, turn, printing([]))).toBe('');
  });

  test('an ambient settings.json saved with a byte-order mark is still read', async () => {
    fs.writeFileSync(path.join(ambient, 'settings.json'), '\uFEFF{"statusLine":{"type":"command","command":"ambient-line"}}');
    installStatuslineSink(dir, LAUNCH);
    expect(await runStatusline(dir, turn, printing([]))).toBe('ran ambient-line');
  });

  test('run as its own process, it reads the ambient statusLine from the home dir and runs it', () => {
    fs.mkdirSync(path.join(ambient, '.claude'));
    fs.writeFileSync(path.join(ambient, '.claude', 'settings.json'), '{"statusLine":{"type":"command","command":"echo from-home"}}');
    installStatuslineSink(dir, LAUNCH);
    const script = path.join(__dirname, '..', '..', 'hooks', 'bodhilander-statusline.ts');
    const run = spawnSync(process.execPath, [script, dir], {
      input: turn,
      encoding: 'utf-8',
      env: { ...process.env, HOME: ambient, USERPROFILE: ambient },
    });
    expect({ status: run.status, stdout: run.stdout.trim() }).toEqual({ status: 0, stdout: 'from-home' });
    expect(fs.existsSync(path.join(dir, 'bodhilander-usage.json'))).toBe(true);
  });

  // Under node, as the app runs it: bun's spawnSync never waited on the pipe a grandchild held.
  const runBundled = () => {
    const bundle = path.join(ambient, 'bodhilander-statusline.js');
    const options = {
      entryPoints: [path.join(__dirname, '..', '..', 'hooks', 'bodhilander-statusline.ts')],
      bundle: true, platform: 'node', target: 'node18', format: 'cjs', outfile: bundle, logLevel: 'silent',
    };
    // esbuild's buildSync needs a worker thread, which bun cannot host.
    const build = spawnSync('node', ['-e', `require(${JSON.stringify(require.resolve('esbuild'))}).buildSync(${JSON.stringify(options)})`], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect({ status: build.status, stderr: build.stderr }).toEqual({ status: 0, stderr: '' });
    const started = Date.now();
    const run = spawnSync('node', [bundle, dir], {
      input: turn,
      encoding: 'utf-8',
      env: { ...process.env, HOME: ambient, USERPROFILE: ambient },
      timeout: 60_000,
    });
    return { status: run.status, stdout: run.stdout, elapsed: Date.now() - started };
  };

  test('run as its own process, a chained command that outlives the timeout is cut off and the reading kept', () => {
    fs.writeFileSync(chainFile(), '{"chain":{"type":"command","command":"sleep 30; echo late"}}');
    const { status, stdout, elapsed } = runBundled();
    expect({ status, stdout }).toEqual({ status: 0, stdout: '' });
    expect(elapsed).toBeGreaterThanOrEqual(5_000);
    expect(elapsed).toBeLessThan(18_000);
    expect(fs.existsSync(path.join(dir, 'bodhilander-usage.json'))).toBe(true);
  }, 70_000);

  test.skipIf(process.platform !== 'win32')('run as its own process, a native grandchild the kill misses does not hold it open', () => {
    const chain = { chain: { type: 'command', command: 'echo first; cmd //c "ping -n 30 127.0.0.1 >nul"; echo x' } };
    fs.writeFileSync(chainFile(), JSON.stringify(chain));
    const { status, stdout, elapsed } = runBundled();
    expect({ status, stdout }).toEqual({ status: 0, stdout: 'first\n' });
    expect(elapsed).toBeLessThan(18_000);
  }, 70_000);

  test('a torn ambient settings.json prints nothing', async () => {
    fs.writeFileSync(path.join(ambient, 'settings.json'), '{"statusLine":');
    installStatuslineSink(dir, LAUNCH);
    expect(await runStatusline(dir, turn, printing([]))).toBe('');
  });

  test.each([
    ['no settings.json', null],
    ['no statusLine', { model: 'opus' }],
    ['a blank command', { statusLine: { type: 'command', command: ' ' } }],
    ['the sink itself', { statusLine: { type: 'command', command: sinkCommand(LAUNCH, '/elsewhere') } }],
  ])('an ambient dir with %s gives no status line', async (_name, value) => {
    if (value) writeAmbient(value);
    installStatuslineSink(dir, LAUNCH);
    const seen: string[] = [];
    expect(await runStatusline(dir, turn, printing(seen))).toBe('');
    expect(seen).toEqual([]);
  });


  test('a failing user command costs the status line, not the reading', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'boom' } });
    installStatuslineSink(dir, LAUNCH);
    const out = await runStatusline(dir, turn, { now: () => 5, ambientDir: ambient, runChain: () => { throw new Error('boom'); } });
    expect(out).toBe('');
    expect(fs.existsSync(path.join(dir, 'bodhilander-usage.json'))).toBe(true);
  });
});

describe('the chained command, run for real', () => {
  const posixPath = (name: string) => path.join(dir, name).split(path.sep).join('/');
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test('gets the turn on stdin and its stdout is the status line', async () => {
    expect(await runChainedCommand('cat', 'opus | 64%', 5_000)).toBe('opus | 64%');
  }, 10_000);

  test('on timeout it shows the lines already finished, not a torn one', async () => {
    expect(await runChainedCommand('printf "opus | 64%%\nhalf"; sleep 30', '', 3_000)).toBe('opus | 64%\n');
  }, 20_000);

  test('on timeout everything it started is killed, not left behind', async () => {
    const [ran, late] = ['ran', 'late'].map(posixPath);
    const started = Date.now();
    const out = await runChainedCommand(`bash -c 'echo > "${ran}"; sleep 12; echo > "${late}"'; echo early`, '', 3_000);
    expect(out).toBe('');
    expect(Date.now() - started).toBeLessThan(10_000);
    await sleep(Math.max(0, started + 14_000 - Date.now()));
    expect({ ran: fs.existsSync(ran), late: fs.existsSync(late) }).toEqual({ ran: true, late: false });
  }, 25_000);

  test('a background job with its output sent elsewhere is left to finish', async () => {
    const marker = posixPath('refreshed');
    const out = await runChainedCommand(`echo line; (sleep 4; echo > "${marker}") >/dev/null &`, '', 2_000);
    expect(out).toBe('line\n');
    for (let waited = 0; waited < 12_000 && !fs.existsSync(marker); waited += 250) await sleep(250);
    expect(fs.existsSync(marker)).toBe(true);
  }, 20_000);

  test('the shell pid is only ever a whole first line of stderr', () => {
    expect(shellPid('4242\n')).toBe('4242');
    expect(shellPid('4242\r\nmore')).toBe('4242');
    for (const stderr of ['4242', '4242junk\n', 'warning\n4242\n', ' 4242\n', '1\n', '0\n', '']) {
      expect(shellPid(stderr)).toBeUndefined();
    }
  });

  test.skipIf(process.platform !== 'win32')('a junk first line on stderr never picks the group that gets killed', async () => {
    const bash = findGitBash(process.env);
    expect(bash).not.toBeNull();
    const bystander = spawn(bash as string, ['-c', 'echo $$; sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const pid = await new Promise<string>((resolve) => bystander.stdout?.once('data', (chunk) => resolve(String(chunk).trim())));
    const bashEnv = path.join(dir, 'bash-env.sh');
    fs.writeFileSync(bashEnv, `echo "${pid}junk" >&2\n`);
    const saved = process.env.BASH_ENV;
    process.env.BASH_ENV = bashEnv.split(path.sep).join('/');
    try {
      expect(await runChainedCommand('sleep 5', '', 1_500)).toBe('');
      await sleep(1_000);
      expect({ exitCode: bystander.exitCode, signalCode: bystander.signalCode }).toEqual({ exitCode: null, signalCode: null });
    } finally {
      if (saved === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = saved;
      spawnSync(bash as string, ['-c', `kill -9 -- -${pid}`], { stdio: 'ignore', windowsHide: true });
    }
  }, 20_000);
});

test('the chained user command does not run in Node mode', () => {
  expect(chainEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
});

describe('the sink command', () => {
  test('runs this app’s binary in Node mode, guarded on the script existing', () => {
    expect(sinkCommand(LAUNCH, '/cfg/work')).toBe(
      "if [ -f '/opt/Bodhilander/dist/hooks/bodhilander-statusline.js' ]; then "
        + "ELECTRON_RUN_AS_NODE=1 '/opt/Bodhilander/Bodhilander' '/opt/Bodhilander/dist/hooks/bodhilander-statusline.js' '/cfg/work'; fi",
    );
  });

  test('on Windows the paths are written for Git Bash, with forward slashes', () => {
    const launch: SinkLaunch = {
      scriptPath: String.raw`C:\Program Files\Bodhilander\resources\hooks\bodhilander-statusline.js`,
      execPath: String.raw`C:\Program Files\Bodhilander\Bodhilander.exe`,
      platform: 'win32',
    };
    const command = sinkCommand(launch, String.raw`C:\Users\me\claude-accounts\a`);
    expect(command).toContain("'C:/Program Files/Bodhilander/Bodhilander.exe'");
    expect(command).toContain("'C:/Users/me/claude-accounts/a'");
    expect(command).not.toContain('\\');
  });

  test('a launch needs the script', () => {
    const host = { execPath: '/opt/b/Bodhilander', platform: 'darwin' as const, gitBash: () => null };
    expect(sinkLaunchFor(null, host)).toBeNull();
    expect(sinkLaunchFor(SCRIPT, host)).toEqual({ scriptPath: SCRIPT, execPath: '/opt/b/Bodhilander', platform: 'darwin' });
  });

  test('on Windows it needs Git Bash, since the CLI runs statusLine under PowerShell without it', () => {
    const host = { execPath: String.raw`C:\b\Bodhilander.exe`, platform: 'win32' as const };
    const bash = String.raw`C:\Program Files\Git\bin\bash.exe`;
    expect(sinkLaunchFor(SCRIPT, { ...host, gitBash: () => null })).toBeNull();
    expect(sinkLaunchFor(SCRIPT, { ...host, gitBash: () => bash })).toEqual({ scriptPath: SCRIPT, ...host });
  });

  test('with no launch, a sink already installed is taken out and the user entry restored', () => {
    const mine = { type: 'command', command: 'echo mine' };
    writeSettings({ statusLine: mine });
    installStatuslineSink(dir, LAUNCH);
    const launch = sinkLaunchFor(SCRIPT, { execPath: 'x', platform: 'win32', gitBash: () => null });
    expect(sinkReconciler(launch, () => true, ambient)(dir)).toBe('restored');
    expect(settings().statusLine).toEqual(mine);
  });

  test.skipIf(process.platform === 'win32')('quotes survive a path with spaces and a quote, and a missing script is a no-op', () => {
    const odd = path.join(dir, "it's here");
    fs.mkdirSync(odd);
    const script = path.join(odd, 'bodhilander-statusline.js');
    fs.writeFileSync(script, 'printf "%s|%s" "$ELECTRON_RUN_AS_NODE" "$1"');
    const launch: SinkLaunch = { scriptPath: script, execPath: '/bin/sh', platform: process.platform };
    const run = () => spawnSync('/bin/sh', ['-c', sinkCommand(launch, odd)], { encoding: 'utf-8' });

    expect(run()).toMatchObject({ status: 0, stdout: `1|${odd}` });
    fs.rmSync(script);
    expect(run()).toMatchObject({ status: 0, stdout: '' });
  });
});
