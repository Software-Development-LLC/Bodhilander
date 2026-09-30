/**
 * The statusline sink: installing it into a managed config dir without
 * breaking a statusLine the user already had, and what the script itself does
 * with each turn's status JSON.
 *
 * Run with: bun test src/main/__tests__/statusline-sink.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { installStatuslineSink, sinkCommand } from '../statusline-sink';
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
