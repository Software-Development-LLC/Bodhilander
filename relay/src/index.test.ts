/**
 * The server the entry point actually builds. `server.test.ts` proves the
 * options are right; this proves the program uses them — the request-body
 * ceiling regressed once in exactly the gap between those two statements.
 */
import { afterEach, expect, test } from 'bun:test';
import { main } from './index';

let running: { stop: () => Promise<void> } | null = null;
const KEYS = ['NODE_ENV', 'PORT', 'DB_PATH', 'PUBLIC_URL', 'SESSION_SECRET', 'LOG_LEVEL'] as const;
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
  const port = 40000 + Math.floor(Math.random() * 20000);
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: String(port),
    DB_PATH: ':memory:',
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    SESSION_SECRET: 'test-only-secret',
    LOG_LEVEL: 'error',
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
