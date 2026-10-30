/**
 * The hook script run as Claude Code runs it: a real process with the payload
 * on stdin, posting to a local server that records what arrives.
 * Run with: bun test --isolate src/hooks/__tests__/bodhilander-hook.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

const SCRIPT = path.join(import.meta.dir, '..', 'bodhilander-hook.ts');

let server: http.Server;
let apiUrl = '';
let posts: { url: string; body: Record<string, unknown> }[] = [];

beforeAll(() => new Promise<void>((resolve) => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      posts.push({ url: req.url ?? '', body: JSON.parse(raw) });
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
  });
  server.listen(0, '127.0.0.1', () => {
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  });
}));

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  posts = [];
});

async function runHook(hookType: string, payload: Record<string, unknown>, tabId: string | null): Promise<number> {
  const env: Record<string, string | undefined> = { ...process.env, BODHILANDER_API_URL: apiUrl };
  delete env.BODHILANDER_SESSION_ID;
  if (tabId !== null) env.BODHILANDER_SESSION_ID = tabId;
  const child = Bun.spawn([process.execPath, SCRIPT, hookType], {
    env,
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return child.exited;
}

describe('SessionStart', () => {
  test('posts the tab from the env and the conversation from the payload', async () => {
    const code = await runHook('SessionStart', { session_id: 'conv-2', source: 'resume' }, 'tab-1');

    expect(code).toBe(0);
    expect(posts).toEqual([
      {
        url: '/api/v1/hooks/session-start',
        body: { session_id: 'tab-1', claude_session_id: 'conv-2', source: 'resume' },
      },
    ]);
  });

  test('posts nothing for a Claude that Bodhilander did not launch', async () => {
    const code = await runHook('SessionStart', { session_id: 'conv-2', source: 'resume' }, null);

    expect(code).toBe(0);
    expect(posts).toEqual([]);
  });
});
