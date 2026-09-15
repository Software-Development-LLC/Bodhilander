/**
 * The broker, run as the real program it is.
 *
 * `scripts/permission-broker.js` is plain node -- it cannot be part of the
 * app, because the app's native modules are built for Electron's ABI -- so
 * the only honest way to test it is to spawn it the way the CLI does: hook
 * mode gets a payload on stdin and must print a decision; MCP mode gets
 * JSON-RPC lines and must answer them. Both file requests into the same
 * directory, and the reader in `permission-channel.ts` must not be able to
 * tell which route a request took.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readChannel, requestFileName, replyFileName } from '../permission-channel';

const BROKER = path.resolve(__dirname, '../../../../scripts/permission-broker.js');

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function channel(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'broker-'));
  made.push(dir);
  return dir;
}

/** Run the broker in hook mode with one payload, and collect what it printed. */
function hook(dir: string, payload: unknown, answerBySeconds: number): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BROKER, '--hook', dir, String(answerBySeconds)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.on('close', (code) => resolve({ out, code }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const PAYLOAD = {
  hook_event_name: 'PreToolUse',
  tool_use_id: 'toolu_01',
  tool_name: 'Bash',
  tool_input: { command: 'git push', description: 'Push' },
  session_id: 's',
};

describe('hook mode', () => {
  test('files the request in the shape the reader expects, then returns the reply', async () => {
    const dir = await channel();
    const done = hook(dir, PAYLOAD, 30);

    // The request appears before any answer exists. That is the whole point:
    // a person reads it from the channel while the gate waits.
    let files: string[] = [];
    for (let i = 0; i < 40 && !files.includes(requestFileName('toolu_01')); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      files = await fs.readdir(dir);
    }
    const reading = readChannel(
      await Promise.all(files.map(async (name) => ({ name, text: await fs.readFile(path.join(dir, name), 'utf8') }))),
    );
    expect(reading.pending).toEqual([
      expect.objectContaining({ toolUseId: 'toolu_01', toolName: 'Bash', input: PAYLOAD.tool_input }),
    ]);

    await fs.writeFile(path.join(dir, replyFileName('toolu_01')), '{"behavior":"allow"}');
    const { out, code } = await done;
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
  });

  test('a refusal carries its message to the model', async () => {
    const dir = await channel();
    const done = hook(dir, PAYLOAD, 30);
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(
      path.join(dir, replyFileName('toolu_01')),
      '{"behavior":"deny","message":"not on this branch"}',
    );
    const { out } = await done;
    expect(JSON.parse(out).hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'not on this branch',
    });
  });

  test('nobody answering is an explicit refusal that says so, not a hang', async () => {
    // A hook the CLI kills does not deny and does not allow: the call falls
    // through to an interactive prompt a background gate has nobody at.
    // Measured. So the broker answers before the CLI would, and says why.
    const dir = await channel();
    const started = Date.now();
    const { out, code } = await hook(dir, PAYLOAD, 1);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(code).toBe(0);
    const decision = JSON.parse(out).hookSpecificOutput;
    expect(decision.permissionDecision).toBe('deny');
    expect(decision.permissionDecisionReason).toContain('nobody answered');
    expect(decision.permissionDecisionReason).toContain('within 1s');
  });

  test('a half-written reply is waited on, not read as an answer', async () => {
    const dir = await channel();
    const done = hook(dir, PAYLOAD, 30);
    await new Promise((r) => setTimeout(r, 300));
    // Not yet JSON. Then complete it.
    await fs.writeFile(path.join(dir, replyFileName('toolu_01')), '{"behavior":"al');
    await new Promise((r) => setTimeout(r, 700));
    await fs.writeFile(path.join(dir, replyFileName('toolu_01')), '{"behavior":"allow"}');
    const { out } = await done;
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('a payload with no tool_use_id is refused, because it cannot be routed to anyone', async () => {
    const dir = await channel();
    const { out } = await hook(dir, { tool_name: 'Bash', tool_input: {} }, 30);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test('an unreadable payload is refused rather than guessed at', async () => {
    const dir = await channel();
    const { out } = await hook(dir, 'this is not json', 30);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('MCP mode', () => {
  test('still answers tools/list, so the print route is unchanged', async () => {
    const dir = await channel();
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [BROKER, dir], { stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d.toString('utf8'); });
      child.on('close', () => resolve(buf));
      child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    });
    const message = JSON.parse(out.trim().split('\n')[0]);
    expect(message.result.tools.map((t: { name: string }) => t.name)).toEqual(['ask']);
  });
});
