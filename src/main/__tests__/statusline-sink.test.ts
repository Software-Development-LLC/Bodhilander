/**
 * The statusline sink: installing it without breaking a user's statusLine, and
 * what the script does with each turn. Run with: bun test <this file>
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { spawnSync } from 'child_process';

import {
  installStatuslineSink,
  SinkLaunch,
  sinkCommand,
  sinkLaunchFor,
  sinkReconciler,
  uninstallStatuslineSink,
} from '../statusline-sink';
import { chainEnv, readChainedCommand, recordRateLimits, runStatusline } from '../../hooks/bodhilander-statusline';

const SCRIPT = '/opt/Bodhilander/dist/hooks/bodhilander-statusline.js';
const LAUNCH: SinkLaunch = { scriptPath: SCRIPT, execPath: '/opt/Bodhilander/Bodhilander', platform: 'darwin' };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-sink-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
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
    expect(uninstallStatuslineSink(dir)).toBe('restored');
    expect(settings()).toEqual({ model: 'opus', statusLine: mine });
    expect(fs.existsSync(chainFile())).toBe(false);
  });

  test('with nothing chained, the statusLine is removed', () => {
    writeSettings({ model: 'opus' });
    installStatuslineSink(dir, LAUNCH);
    expect(uninstallStatuslineSink(dir)).toBe('removed');
    expect(settings()).toEqual({ model: 'opus' });
  });

  test('a statusLine that is not ours is left alone', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    const before = fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8');
    expect(uninstallStatuslineSink(dir)).toBe('unchanged');
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe(before);
  });

  test('an unreadable record of the user entry keeps ours rather than lose theirs', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    installStatuslineSink(dir, LAUNCH);
    fs.writeFileSync(chainFile(), '{"chain":');
    expect(uninstallStatuslineSink(dir)).toBe('error');
    expect(settings().statusLine.command).toBe(sinkCommand(LAUNCH, dir));
  });

  test('an unparseable settings.json is untouched', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"model": "opus",');
    expect(uninstallStatuslineSink(dir)).toBe('error');
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe('{"model": "opus",');
  });
});

describe('sinkReconciler', () => {
  test('turning it off, or losing the script, restores the user entry', () => {
    const mine = { type: 'command', command: 'echo mine' };
    for (const [launch, enabled] of [[LAUNCH, false], [null, true]] as const) {
      writeSettings({ statusLine: mine });
      expect(sinkReconciler(LAUNCH, () => true)(dir)).toBe('installed');
      expect(sinkReconciler(launch, () => enabled)(dir)).toBe('restored');
      expect(settings().statusLine).toEqual(mine);
    }
  });

  test('the preference is read on every reconcile, not captured once', () => {
    let enabled = true;
    const reconcile = sinkReconciler(LAUNCH, () => enabled);
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

  test('passes the user command the same stdin and prints its output', () => {
    writeSettings({ statusLine: { type: 'command', command: 'my-line' } });
    installStatuslineSink(dir, LAUNCH);
    const seen: string[] = [];
    const out = runStatusline(dir, turn, { now: () => 1, runChain: (command, input) => { seen.push(command, input); return 'opus | 64%'; } });
    expect(out).toBe('opus | 64%');
    expect(seen).toEqual(['my-line', turn]);
  });

  test('with no user command it prints nothing', () => {
    expect(runStatusline(dir, turn, { now: () => 1, runChain: () => 'unexpected' })).toBe('');
  });

  test('a failing user command costs the status line, not the reading', () => {
    writeSettings({ statusLine: { type: 'command', command: 'boom' } });
    installStatuslineSink(dir, LAUNCH);
    const out = runStatusline(dir, turn, { now: () => 5, runChain: () => { throw new Error('boom'); } });
    expect(out).toBe('');
    expect(fs.existsSync(path.join(dir, 'bodhilander-usage.json'))).toBe(true);
  });
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
    expect(sinkReconciler(launch, () => true)(dir)).toBe('restored');
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
