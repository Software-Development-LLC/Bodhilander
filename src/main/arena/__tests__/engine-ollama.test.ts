/**
 * Arena engine — Ollama contestant tests (#100). global.fetch is stubbed per
 * test, covering: happy-path NDJSON streaming with token counts, the
 * no-models-pulled and HTTP-error branches, daemon-unreachable, and
 * abort-on-timeout.
 *
 * Run with: bun test src/main/arena
 */
import { describe, expect, test, mock, afterEach } from 'bun:test';
import type { ArenaUpdate } from '../../../shared/types';

mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
}));
mock.module('../../repositories/preferences', () => ({
  getPreference: () => '',
}));

const finalized: any[] = [];
mock.module('../../repositories/arena', () => ({
  createRun: () => undefined,
  createResponse: () => undefined,
  finalizeResponse: (id: string, final: any) => finalized.push({ id, ...final }),
  getRun: (id: string) => ({ id, prompt: 'p', createdAt: new Date(0), responses: [] }),
  listRuns: () => [],
}));
mock.module('../../providers', () => ({
  getProvider: () => {
    throw new Error('CLI providers not used in these tests');
  },
}));

const { ArenaEngine } = await import('../engine');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  finalized.length = 0;
});

/** A stream that never produces data and never closes; errors with AbortError on abort. */
function hungStream(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => {
        controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    },
  });
}

function ndjsonStream(lines: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(JSON.stringify(line) + '\n'));
      }
      controller.close();
    },
  });
}

function runOllamaAndSettle(engine: InstanceType<typeof ArenaEngine>): Promise<ArenaUpdate[]> {
  const updates: ArenaUpdate[] = [];
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('never settled')), 10_000);
    engine.on('update', (u: ArenaUpdate) => {
      updates.push(u);
      if (u.status !== 'running') {
        clearTimeout(t);
        resolve(updates);
      }
    });
    const run = engine.prepare('ollama-prompt', ['ollama']);
    engine.launch(run.id);
  });
}

describe('ArenaEngine — Ollama contestant', () => {
  test('streams NDJSON chunks and reports token counts', async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), { status: 200 });
      }
      return new Response(
        ndjsonStream([
          { message: { content: 'hel' }, done: false },
          { message: { content: 'lo' }, done: false },
          { message: { content: '' }, done: true, prompt_eval_count: 9, eval_count: 14 },
        ]),
        { status: 200 }
      );
    }) as typeof fetch;

    const updates = await runOllamaAndSettle(new ArenaEngine());
    const final = updates[updates.length - 1];
    expect(final.status).toBe('done');
    expect(updates.map(u => u.chunk).join('')).toBe('hello');
    expect(final.inputTokens).toBe(9);
    expect(final.outputTokens).toBe(14);
    expect(final.ttftMs).toBeGreaterThanOrEqual(0);
    expect(finalized[0].text).toBe('hello');
  });

  test('reports a clear error when no models are pulled', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: [] }), { status: 200 })) as typeof fetch;

    const updates = await runOllamaAndSettle(new ArenaEngine());
    const final = updates[updates.length - 1];
    expect(final.status).toBe('error');
    expect(final.error).toContain('no models pulled');
    // totalMs is measured from the launch attempt, not run creation.
    expect(final.totalMs!).toBeLessThan(5_000);
  });

  test('reports the HTTP status when /api/chat fails', async () => {
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), { status: 200 });
      }
      return new Response('busy', { status: 503 });
    }) as typeof fetch;

    const updates = await runOllamaAndSettle(new ArenaEngine());
    expect(updates[updates.length - 1].error).toContain('HTTP 503');
  });

  test('reports unreachable when the daemon is down', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const updates = await runOllamaAndSettle(new ArenaEngine());
    const final = updates[updates.length - 1];
    expect(final.status).toBe('error');
    expect(final.error).toContain('not reachable');
  });

  test('aborts a hung stream at the contestant timeout', async () => {
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), { status: 200 });
      }
      return new Response(hungStream(init?.signal), { status: 200 });
    }) as typeof fetch;

    const updates = await runOllamaAndSettle(new ArenaEngine(400));
    const final = updates[updates.length - 1];
    expect(final.status).toBe('error');
    expect(final.totalMs!).toBeLessThan(5_000);
  }, 10_000);
});
