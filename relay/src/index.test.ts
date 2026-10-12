/**
 * The server the entry point actually builds. `server.test.ts` proves the
 * options are right; this proves the program uses them — the request-body
 * ceiling regressed once in exactly the gap between those two statements.
 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main } from './index';

let running: { stop: () => Promise<void> } | null = null;
const KEYS = ['NODE_ENV', 'PORT', 'DB_PATH', 'PUBLIC_URL', 'SESSION_SECRET', 'LOG_LEVEL', 'HANDOFF_DIR', 'RELAY_BUILD_COMMIT'] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(async () => {
  await running?.stop();
  running = null;
  // `main()` configures itself from the environment, so put it back: sibling
  // suites in this process read it too.
  for (const key of KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

/** Past the old 1 MiB ceiling, well inside the shipped one. */
const OVER_THE_OLD_CEILING = 4 * 1024 * 1024;

test('the entry point serves at the shipped body ceiling', async () => {
  // Below BOTH platforms' dynamic port ranges, which is the whole point of
  // the number: Linux hands out 32768-60999 and Windows 49152-65535, so the
  // old 40000-59999 window sat inside Linux's. CI makes enough outbound
  // connections that one of them held the port this test then tried to bind,
  // and the failure looked like the change under review rather than the
  // runner. `PORT=0` would be stricter still, but `loadConfig` rejects it on
  // purpose - a deployment that typos the port should not silently listen
  // somewhere nobody can find it.
  const port = 20000 + Math.floor(Math.random() * 10000);
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: String(port),
    DB_PATH: ':memory:',
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: 'test-only-secret',
    LOG_LEVEL: 'error',
    HANDOFF_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-entry-')),
  });

  running = main();
  const origin = `http://127.0.0.1:${port}`;
  expect((await fetch(`${origin}/health`)).status).toBe(200);

  const res = await fetch(`${origin}/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(OVER_THE_OLD_CEILING),
  });

  // A body Bun refuses at the socket comes back with nothing in it. Reading a
  // reason here is only possible because the request reached the router, which
  // is the whole claim: this server carries the ceiling a handoff needs.
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: 'payload_too_large' });
});

test('the startup log line carries the commit', async () => {
  // The deploy docs send operators to `docker logs | grep 'relay listening'`
  // when a container is restart-looping and there is no /health to curl, so
  // the field is an interface and not just a convenience.
  const port = 20000 + Math.floor(Math.random() * 10000);
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: String(port),
    DB_PATH: ':memory:',
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: 'test-only-secret',
    LOG_LEVEL: 'info',
    HANDOFF_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'relay-entry-')),
    RELAY_BUILD_COMMIT: '7d5cb5d',
  });

  const lines: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    running = main();
  } finally {
    process.stdout.write = realWrite;
  }

  const listening = lines.find((l) => l.includes('"msg":"relay listening"'));
  expect(listening).toBeDefined();
  expect(JSON.parse(listening as string).commit).toBe('7d5cb5d');
});
