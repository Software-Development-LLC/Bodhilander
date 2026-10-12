import { describe, expect, test } from 'bun:test';
import {
  type ChannelFile,
  channelDirFor,
  encodeDecision,
  HOOK_ANSWER_BY_SECONDS,
  HOOK_TIMEOUT_SECONDS,
  hookSettingsText,
  isWaiting,
  mcpConfigText,
  PERMISSION_TOOL,
  readChannel,
  replyFileName,
  requestFileName,
} from '../permission-channel';

const request = (toolUseId: string, body: Record<string, unknown>): ChannelFile => ({
  name: requestFileName(toolUseId),
  text: JSON.stringify(body),
});

const ASK = {
  toolName: 'Bash',
  input: { command: 'rm -rf build', description: 'Clean' },
  askedAt: '2026-09-14T11:41:45.000Z',
};

describe('what a gate is waiting on', () => {
  test('an unanswered request is what a person is shown', () => {
    const reading = readChannel([request('toolu_01', ASK)]);
    expect(reading.pending).toEqual([
      {
        toolUseId: 'toolu_01',
        toolName: 'Bash',
        input: { command: 'rm -rf build', description: 'Clean' },
        askedAt: '2026-09-14T11:41:45.000Z',
      },
    ]);
    expect(reading.unreadable).toEqual([]);
    expect(isWaiting(reading)).toBe(true);
  });

  test('the tool input is carried whole, not summarised', () => {
    // A person approving a Bash call is approving its command line. Showing
    // them a shortened version would be asking them to agree to something
    // they had not read, so nothing here may narrow it.
    const deep = { command: 'x', nested: { list: [1, 2, { keep: 'me' }] } };
    const reading = readChannel([request('toolu_01', { ...ASK, input: deep })]);
    expect(reading.pending[0].input).toEqual(deep);
  });

  test('a request with a reply beside it is finished', () => {
    const reading = readChannel([
      request('toolu_01', ASK),
      { name: replyFileName('toolu_01'), text: '{"behavior":"allow"}' },
    ]);
    expect(reading.pending).toEqual([]);
    expect(isWaiting(reading)).toBe(false);
  });

  test('one answered request does not clear another', () => {
    // The whole point of keying by tool_use_id. A gate can have asked twice.
    const reading = readChannel([
      request('toolu_01', ASK),
      { name: replyFileName('toolu_01'), text: '{"behavior":"allow"}' },
      request('toolu_02', { ...ASK, toolName: 'Edit' }),
    ]);
    expect(reading.pending.map((p) => p.toolUseId)).toEqual(['toolu_02']);
  });

  test('the oldest request is shown first', () => {
    const reading = readChannel([
      request('toolu_late', { ...ASK, askedAt: '2026-09-14T12:00:00.000Z' }),
      request('toolu_early', { ...ASK, askedAt: '2026-09-14T11:00:00.000Z' }),
    ]);
    expect(reading.pending.map((p) => p.toolUseId)).toEqual(['toolu_early', 'toolu_late']);
  });

  test('requests asked in the same instant still have an order', () => {
    // Two reads of the same channel must show the same thing. Without the
    // id tiebreak the order would depend on how the directory was listed.
    const together = { ...ASK, askedAt: '2026-09-14T11:41:45.000Z' };
    const reading = readChannel([request('toolu_b', together), request('toolu_a', together)]);
    expect(reading.pending.map((p) => p.toolUseId)).toEqual(['toolu_a', 'toolu_b']);
  });

  test('an empty channel is not waiting on anybody', () => {
    expect(isWaiting(readChannel([]))).toBe(false);
  });

  test('a stray file cannot park a run', () => {
    // The directory is the engine's own, but an editor backup or a half
    // written temp file must not be readable as a request.
    const reading = readChannel([
      { name: 'toolu_01.request.json.bak', text: 'nonsense' },
      { name: 'notes.txt', text: 'nonsense' },
      { name: '.request.json', text: JSON.stringify(ASK) },
    ]);
    expect(reading).toEqual({ pending: [], unreadable: [] });
    expect(isWaiting(reading)).toBe(false);
  });
});

describe('a request that cannot be understood', () => {
  test('is reported rather than skipped', () => {
    // The gate is blocked on this id whatever the file says. Dropping it
    // would hang the run on something no screen would ever show, which is
    // the exact failure this channel exists to end.
    const reading = readChannel([{ name: requestFileName('toolu_01'), text: 'not json' }]);
    expect(reading.pending).toEqual([]);
    expect(reading.unreadable).toEqual([
      { toolUseId: 'toolu_01', reason: 'the request file is not JSON' },
    ]);
    expect(isWaiting(reading)).toBe(true);
  });

  test('a file that could not be read at all is still somebody’s problem', () => {
    const reading = readChannel([{ name: requestFileName('toolu_01'), text: null }]);
    expect(reading.unreadable[0].reason).toBe('the request file could not be read');
    expect(isWaiting(reading)).toBe(true);
  });

  test.each([
    ['[]', 'the request file is not an object'],
    ['null', 'the request file is not an object'],
    ['{"input":{},"askedAt":"2026-09-14T11:41:45.000Z"}', 'the request names no tool'],
    ['{"toolName":"","input":{},"askedAt":"2026-09-14T11:41:45.000Z"}', 'the request names no tool'],
    ['{"toolName":"Bash","input":{}}', 'the request says when nothing was asked'],
    ['{"toolName":"Bash","askedAt":"2026-09-14T11:41:45.000Z"}', 'the request carries no tool input'],
  ])('%s is unreadable: %s', (text, reason) => {
    const reading = readChannel([{ name: requestFileName('toolu_01'), text }]);
    expect(reading.unreadable).toEqual([{ toolUseId: 'toolu_01', reason }]);
  });

  test('a null tool input is a real answer, not a missing one', () => {
    // `in` rather than a truthiness check, because a tool whose input is
    // literally null has still told us what it wants to do.
    const reading = readChannel([
      { name: requestFileName('toolu_01'), text: '{"toolName":"Bash","input":null,"askedAt":"2026-09-14T11:41:45.000Z"}' },
    ]);
    expect(reading.unreadable).toEqual([]);
    expect(reading.pending[0].input).toBeNull();
  });

  test('an unreadable request does not hide a readable one', () => {
    const reading = readChannel([
      { name: requestFileName('toolu_bad'), text: 'not json' },
      request('toolu_good', ASK),
    ]);
    expect(reading.pending.map((p) => p.toolUseId)).toEqual(['toolu_good']);
    expect(reading.unreadable.map((u) => u.toolUseId)).toEqual(['toolu_bad']);
  });

  test('an unreadable request that was answered anyway is finished', () => {
    // A person can unblock a gate whose request file is corrupt, and the
    // channel must let them: the reply is what the broker reads, not this.
    const reading = readChannel([
      { name: requestFileName('toolu_01'), text: 'not json' },
      { name: replyFileName('toolu_01'), text: '{"behavior":"deny","message":"no"}' },
    ]);
    expect(isWaiting(reading)).toBe(false);
  });
});

describe('the answer a person gives', () => {
  test('an approval is the shape the CLI grants on', () => {
    // Measured against claude 2.1.270: this exact text in the tool's content
    // let a Bash call through that was otherwise waiting.
    expect(encodeDecision({ behavior: 'allow' })).toBe('{"behavior":"allow"}');
  });

  test('a refusal carries words for the model', () => {
    // The CLI passes `message` through to the model, which is the difference
    // between a gate that knows it was refused and one that only knows it
    // failed. A refusal with nothing in it teaches an owner to retry.
    expect(encodeDecision({ behavior: 'deny', message: 'not on production data' })).toBe(
      '{"behavior":"deny","message":"not on production data"}',
    );
  });

  test('the two files for one request agree on its id', () => {
    expect(requestFileName('toolu_01')).toBe('toolu_01.request.json');
    expect(replyFileName('toolu_01')).toBe('toolu_01.reply.json');
  });
});

describe('how the gate is told where to ask', () => {
  test('the tool name and the config agree on the server', () => {
    // The failure this pins is the worst-shaped one available: a mismatch
    // between these two is ACCEPTED by the CLI, no server ever answers, and
    // the gate blocks exactly as it did before the channel existed.
    const config = JSON.parse(mcpConfigText('C:/app/scripts/permission-broker.js', 'C:/chan/s1'));
    const server = PERMISSION_TOOL.split('__')[1];
    expect(Object.keys(config.mcpServers)).toEqual([server]);
  });

  test('the broker is launched on the channel it is meant to serve', () => {
    const config = JSON.parse(mcpConfigText('C:/app/scripts/permission-broker.js', 'C:/chan/s1'));
    expect(config.mcpServers.bodhi_permissions).toEqual({
      command: 'node',
      args: ['C:/app/scripts/permission-broker.js', 'C:/chan/s1'],
    });
  });

  test('each gate gets its own directory, under a key its caller chose', () => {
    // A channel nobody can find again is a gate nobody can unblock, so the
    // key belongs to whoever has to look it up, not to this module.
    expect(channelDirFor('C:/chan', 'run-1-g2-a1')).toBe('C:/chan/run-1-g2-a1');
  });

  test('a retry does not inherit the attempt it is retrying', () => {
    // Same run, same gate, second attempt. Sharing a directory would let a
    // stale request read as the new one's, and a person would answer a
    // question the running gate never asked.
    expect(channelDirFor('C:/chan', 'run-1-g2-a2')).not.toBe(channelDirFor('C:/chan', 'run-1-g2-a1'));
  });
});

describe('how a background gate is told where to ask', () => {
  test('the hook runs the broker in hook mode on the same channel', () => {
    // Same broker, same directory, same request shape: the reader, the
    // console and the inbox must not be able to tell which route a request
    // took. --permission-prompt-tool is not consulted for a --bg gate, so
    // this is the only route such a gate has.
    const settings = JSON.parse(hookSettingsText('C:/app/scripts/permission-broker.js', 'C:/chan/run-g2-a1'));
    const [rule] = settings.hooks.PreToolUse;
    expect(rule.hooks).toHaveLength(1);
    expect(rule.hooks[0].type).toBe('command');
    expect(rule.hooks[0].command).toBe(
      `node "C:/app/scripts/permission-broker.js" --hook "C:/chan/run-g2-a1" ${HOOK_ANSWER_BY_SECONDS}`,
    );
  });

  test('every tool is matched, because deciding which are dangerous is not this module’s', () => {
    const settings = JSON.parse(hookSettingsText('b', 'c'));
    expect(settings.hooks.PreToolUse[0].matcher).toBe('');
  });

  test('the broker answers before the CLI would kill the hook', () => {
    // A killed hook neither allows nor denies: the call falls through to an
    // interactive prompt a background gate has nobody at. Measured. So the
    // broker's own deadline must sit strictly inside the hook timeout, with
    // room for the answer to be written and read.
    const settings = JSON.parse(hookSettingsText('b', 'c'));
    expect(settings.hooks.PreToolUse[0].hooks[0].timeout).toBe(HOOK_TIMEOUT_SECONDS);
    expect(HOOK_ANSWER_BY_SECONDS).toBeLessThan(HOOK_TIMEOUT_SECONDS);
    expect(HOOK_TIMEOUT_SECONDS - HOOK_ANSWER_BY_SECONDS).toBeGreaterThanOrEqual(60);
  });

  test('the hook timeout is in the range a person needs', () => {
    // Measured honoured at 3600 for a 70s hold. Anything under the reconcile
    // cadences would make waitingPermission a state a run can only leave by
    // being refused.
    expect(HOOK_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(1800);
  });
});
