import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import { createContext, serve } from '../index';
import { httpSend, readFileOrNull } from '../api-client';
import { NOT_ENABLED_MESSAGE } from '../../shared/claude-desktop';

function harness() {
  const input = new PassThrough();
  const written: string[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });
  const ctx = createContext({
    send: httpSend,
    readFile: readFileOrNull,
    userDataDirs: [path.join(os.tmpdir(), 'bodhi-no-such-user-data')],
    timeoutMs: 1000,
  });
  serve({ input, write: (l) => written.push(l), log: () => {}, done: resolveDone }, ctx);
  return { input, written, done };
}

describe('serve', () => {
  test('answers each request on its own line and finishes once input ends', async () => {
    const { input, written, done } = harness();
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_sessions","arguments":{}}}\n');
    await done;

    const replies = written.map((l) => JSON.parse(l));
    expect(written.every((l) => l.endsWith('\n'))).toBe(true);
    expect(replies.map((r) => r.id).sort()).toEqual([1, 2]);
    const call = replies.find((r) => r.id === 2);
    expect(call.result).toEqual({ content: [{ type: 'text', text: NOT_ENABLED_MESSAGE }], isError: true });
  });

  test('a real context reports what this machine is', () => {
    const ctx = createContext();
    expect(ctx.platform).toBe(process.platform);
    expect(ctx.dirExists(os.tmpdir())).toBe(true);
    expect(ctx.dirExists(path.join(os.tmpdir(), 'bodhi-definitely-missing'))).toBe(false);
  });
});
