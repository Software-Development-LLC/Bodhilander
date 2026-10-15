import { describe, expect, test } from 'bun:test';
import { handleMessage, lineReader, RpcMessage } from '../rpc';
import { TOOLS } from '../tools';

const deps = {
  version: '9.9.9',
  callTool: async (name: string, args: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ name, args }) }],
  }),
};

describe('handleMessage', () => {
  test('initialize echoes the client protocol and names the server', async () => {
    const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, deps);
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'bodhilander', version: '9.9.9' } },
    });
  });

  test('tools/list answers with every tool', async () => {
    const res = await handleMessage({ id: 'a', method: 'tools/list' }, deps) as { result: { tools: unknown } };
    expect(res.result.tools).toEqual(TOOLS);
  });

  test('tools/call passes the name and arguments through', async () => {
    const res = await handleMessage({ id: 2, method: 'tools/call', params: { name: 'list_sessions', arguments: { x: 1 } } }, deps) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(res.result.content[0].text)).toEqual({ name: 'list_sessions', args: { x: 1 } });
  });

  test('tools/call without a name is an invalid-params error', async () => {
    const res = await handleMessage({ id: 3, method: 'tools/call', params: {} }, deps) as { error: { code: number } };
    expect(res.error.code).toBe(-32602);
  });

  test('notifications are never answered', async () => {
    expect(await handleMessage({ method: 'notifications/initialized' }, deps)).toBeNull();
  });

  test('an unknown method is method-not-found', async () => {
    const res = await handleMessage({ id: 4, method: 'resources/list' }, deps) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });
});

test('lineReader splits chunks on newlines and skips what is not JSON', () => {
  const seen: RpcMessage[] = [];
  const feed = lineReader((m) => seen.push(m));
  feed('{"id":1,"meth');
  feed('od":"ping"}\nnot json\n\n{"id":2}\n{"id":3');
  expect(seen).toEqual([{ id: 1, method: 'ping' }, { id: 2 }]);
});
