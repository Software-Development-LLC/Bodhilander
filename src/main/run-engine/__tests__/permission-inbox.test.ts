import { describe, expect, test } from 'bun:test';
import type { RunGateRow } from '../../repositories/runs';
import { channelKeyFor } from '../gate-spawner';
import { requestFileName } from '../permission-channel';
import { channelDirForGate, pendingRequests, writeDecision, type ChannelIo } from '../permission-inbox';

const ROOT = 'C:/perm';
const GATE: RunGateRow = {
  id: 'g', runId: 'run-1', gate: 2, agent: 'bodhilander-lead', attempt: 1, bgSessionId: 'abc', claudeSessionId: 'abc-0',
  status: 'running', verdictJson: null, posture: 'manual', startedAt: '2026-09-15 02:50:00',
};

/** A fake channel over an in-memory map keyed by full path. */
function fakeIo(files: Record<string, string>): { io: ChannelIo; files: Record<string, string> } {
  const io: ChannelIo = {
    join: (...parts) => parts.join('/'),
    list: (dir) =>
      Object.keys(files)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1)),
    read: (p) => (p in files ? files[p] : null),
    write: (p, text) => { files[p] = text; },
  };
  return { io, files };
}

const dir = `${ROOT}/${channelKeyFor('run-1', 2, 'bodhilander-lead', 1)}`;
const ASK = JSON.stringify({
  toolName: 'Bash', input: { command: 'rm -rf build' }, askedAt: '2026-09-15T02:55:00Z',
});

describe('which channel a run’s gate uses', () => {
  test('is keyed by run, gate, role and attempt', () => {
    expect(channelDirForGate(ROOT, 'run-1', GATE)).toBe(dir);
  });

  test('no gate in flight is no channel', () => {
    expect(channelDirForGate(ROOT, 'run-1', null)).toBeNull();
  });
});

describe('what a run is waiting for permission on', () => {
  test('the pending requests, whole', () => {
    const { io } = fakeIo({ [`${dir}/${requestFileName('toolu_01')}`]: ASK });
    const pending = pendingRequests(ROOT, 'run-1', GATE, io);
    expect(pending).toEqual([
      { toolUseId: 'toolu_01', toolName: 'Bash', input: { command: 'rm -rf build' }, askedAt: '2026-09-15T02:55:00Z' },
    ]);
  });

  test('no gate in flight means nothing to answer', () => {
    const { io } = fakeIo({});
    expect(pendingRequests(ROOT, 'run-1', null, io)).toEqual([]);
  });
});

describe('carrying a person’s decision', () => {
  test('allow writes the grant the hook is polling for', () => {
    const { io, files } = fakeIo({ [`${dir}/${requestFileName('toolu_01')}`]: ASK });
    expect(writeDecision(ROOT, 'run-1', GATE, 'toolu_01', 'allow', '', io)).toBe(true);
    expect(files[`${dir}/toolu_01.reply.json`]).toBe('{"behavior":"allow"}');
  });

  test('deny carries a message, and an empty one is given words rather than sent bare', () => {
    // The CLI passes the message to the model; a refusal it cannot read
    // teaches an owner to retry.
    const { io, files } = fakeIo({ [`${dir}/${requestFileName('toolu_01')}`]: ASK });
    writeDecision(ROOT, 'run-1', GATE, 'toolu_01', 'deny', '  ', io);
    expect(JSON.parse(files[`${dir}/toolu_01.reply.json`])).toEqual({
      behavior: 'deny', message: 'declined by a person from the inbox',
    });
  });

  test('a supplied deny message is kept', () => {
    const { io, files } = fakeIo({ [`${dir}/${requestFileName('toolu_01')}`]: ASK });
    writeDecision(ROOT, 'run-1', GATE, 'toolu_01', 'deny', 'not on production data', io);
    expect(JSON.parse(files[`${dir}/toolu_01.reply.json`]).message).toBe('not on production data');
  });

  test('answering a request that is not pending writes nothing', () => {
    // Already answered, or never asked: a reply for it would be a stray file
    // the broker's next launch could misread.
    const { io, files } = fakeIo({
      [`${dir}/${requestFileName('toolu_01')}`]: ASK,
      [`${dir}/toolu_01.reply.json`]: '{"behavior":"allow"}',
    });
    expect(writeDecision(ROOT, 'run-1', GATE, 'toolu_01', 'deny', 'x', io)).toBe(false);
    // The existing reply is untouched.
    expect(files[`${dir}/toolu_01.reply.json`]).toBe('{"behavior":"allow"}');
  });

  test('answering with no gate in flight is a no-op, not a crash', () => {
    const { io } = fakeIo({});
    expect(writeDecision(ROOT, 'run-1', null, 'toolu_01', 'allow', '', io)).toBe(false);
  });
});
