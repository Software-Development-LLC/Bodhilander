/**
 * The statusline sink: installing it without breaking a user's statusLine, and
 * what the script does with each turn. Run with: bun test <this file>
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  installStatuslineSink,
  nodeOnPath,
  reconcileStatuslineSink,
  sinkCommand,
  uninstallStatuslineSink,
} from '../statusline-sink';
import { findGitBash, readChainedCommand, recordRateLimits, runStatusline } from '../../hooks/bodhilander-statusline';

const SCRIPT = '/opt/Bodhilander/dist/hooks/bodhilander-statusline.js';
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
    expect(installStatuslineSink(dir, SCRIPT)).toBe('installed');
    expect(settings()).toEqual({
      model: 'opus',
      hooks: { Stop: [] },
      statusLine: { type: 'command', command: sinkCommand(SCRIPT, dir) },
    });
    expect(readChainedCommand(dir)).toBeNull();
  });

  test('a user statusLine is chained to, and its padding kept', () => {
    writeSettings({ statusLine: { type: 'command', command: 'bash ~/.claude/line.sh', padding: 2 } });
    expect(installStatuslineSink(dir, SCRIPT)).toBe('installed');
    expect(settings().statusLine).toEqual({ type: 'command', command: sinkCommand(SCRIPT, dir), padding: 2 });
    expect(readChainedCommand(dir)).toBe('bash ~/.claude/line.sh');
  });

  test('a second install writes nothing and keeps the chain', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    installStatuslineSink(dir, SCRIPT);
    const mtime = fs.statSync(path.join(dir, 'settings.json')).mtimeMs;
    expect(installStatuslineSink(dir, SCRIPT)).toBe('unchanged');
    expect(fs.statSync(path.join(dir, 'settings.json')).mtimeMs).toBe(mtime);
    expect(readChainedCommand(dir)).toBe('echo mine');
  });

  test('a moved install updates the path without losing the chain', () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo mine' } });
    installStatuslineSink(dir, SCRIPT);
    const moved = '/Applications/Bodhilander.app/dist/hooks/bodhilander-statusline.js';
    expect(installStatuslineSink(dir, moved)).toBe('updated');
    expect(settings().statusLine.command).toBe(sinkCommand(moved, dir));
    expect(readChainedCommand(dir)).toBe('echo mine');
  });

  test('a statusLine the user set after ours becomes the new chain', () => {
    installStatuslineSink(dir, SCRIPT);
    writeSettings({ statusLine: { type: 'command', command: 'echo newer' } });
    expect(installStatuslineSink(dir, SCRIPT)).toBe('installed');
    expect(readChainedCommand(dir)).toBe('echo newer');
  });
});

describe('installStatuslineSink on a settings.json it cannot read', () => {
  test.each([['torn JSON', '{"model": "opus",'], ['an array', '[]'], ['a string', '"x"']])('%s is left untouched, chain and all', (_name, body) => {
    fs.writeFileSync(path.join(dir, 'bodhilander-statusline.json'), '{"chain":{"type":"command","command":"mine"}}');
    fs.writeFileSync(path.join(dir, 'settings.json'), body);
    expect(installStatuslineSink(dir, SCRIPT)).toBe('error');
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe(body);
    expect(readChainedCommand(dir)).toBe('mine');
  });

  test('a missing settings.json is created', () => {
    expect(installStatuslineSink(dir, SCRIPT)).toBe('installed');
    expect(settings().statusLine.command).toBe(sinkCommand(SCRIPT, dir));
  });
});

describe('uninstallStatuslineSink', () => {
  const chainFile = () => path.join(dir, 'bodhilander-statusline.json');

  test('puts back the statusLine it chained to, padding and all, and drops the record', () => {
    const mine = { type: 'command', command: 'bash ~/.claude/line.sh', padding: 2 };
    writeSettings({ model: 'opus', statusLine: mine });
    installStatuslineSink(dir, SCRIPT);
    expect(uninstallStatuslineSink(dir)).toBe('restored');
    expect(settings()).toEqual({ model: 'opus', statusLine: mine });
    expect(fs.existsSync(chainFile())).toBe(false);
  });

  test('with nothing chained, the statusLine is removed', () => {
    writeSettings({ model: 'opus' });
    installStatuslineSink(dir, SCRIPT);
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
    installStatuslineSink(dir, SCRIPT);
    fs.writeFileSync(chainFile(), '{"chain":');
    expect(uninstallStatuslineSink(dir)).toBe('error');
    expect(settings().statusLine.command).toBe(sinkCommand(SCRIPT, dir));
  });

  test('an unparseable settings.json is untouched', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"model": "opus",');
    expect(uninstallStatuslineSink(dir)).toBe('error');
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe('{"model": "opus",');
  });
});

describe('reconcileStatuslineSink', () => {
  test('turning it off, or losing the script, restores the user entry', () => {
    const mine = { type: 'command', command: 'echo mine' };
    for (const [scriptPath, enabled] of [[SCRIPT, false], [null, true]] as const) {
      writeSettings({ statusLine: mine });
      expect(reconcileStatuslineSink(dir, SCRIPT, true)).toBe('installed');
      expect(reconcileStatuslineSink(dir, scriptPath, enabled)).toBe('restored');
      expect(settings().statusLine).toEqual(mine);
    }
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
    installStatuslineSink(dir, SCRIPT);
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
    installStatuslineSink(dir, SCRIPT);
    const out = runStatusline(dir, turn, { now: () => 5, runChain: () => { throw new Error('boom'); } });
    expect(out).toBe('');
    expect(fs.existsSync(path.join(dir, 'bodhilander-usage.json'))).toBe(true);
  });
});

describe('findGitBash', () => {
  test('the override the CLI itself honours wins', () => {
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:/tools/bash.exe' }, () => true)).toBe('D:/tools/bash.exe');
  });

  test('derives bash from a Git entry on PATH', () => {
    const found = findGitBash({ PATH: String.raw`C:\Windows;D:\Git\cmd` }, p => p.toLowerCase().startsWith('d:'));
    expect(found).toBe(String.raw`D:\Git\bin\bash.exe`);
  });

  test('nothing on disk is null, so the default shell is used', () => {
    expect(findGitBash({ PATH: '' }, () => false)).toBeNull();
  });
});

describe('nodeOnPath', () => {
  test('finds node.exe on a Windows PATH', () => {
    const env = { Path: String.raw`C:\Windows;C:\Program Files\nodejs` };
    expect(nodeOnPath(env, 'win32', p => p === String.raw`C:\Program Files\nodejs\node.exe`)).toBe(true);
  });

  test('finds node on a POSIX PATH', () => {
    expect(nodeOnPath({ PATH: '/usr/bin:/opt/homebrew/bin' }, 'darwin', p => p === '/opt/homebrew/bin/node')).toBe(true);
  });

  test('no node anywhere is false', () => {
    expect(nodeOnPath({ PATH: '/usr/bin' }, 'linux', () => false)).toBe(false);
    expect(nodeOnPath({}, 'linux', () => true)).toBe(false);
  });
});
