/**
 * Arena engine tests (#100): the concurrency-sensitive paths — two-phase
 * prepare/launch, streaming + TTFT measurement, non-zero exit, timeout
 * kill, cancel, and the no-double-finalize guard. Contestants are fake
 * providers whose "CLI" is plain shell (printf/sleep), spawned through the
 * real shell-launch wrapper, so the spawn → readline → parser path is
 * exercised for real without any agent CLI installed.
 *
 * Run with: bun test src/main/arena
 */
import { describe, expect, test, mock } from 'bun:test';
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

// Vault stub (#99): only the 'keyed' contestant gets an injected env var.
mock.module('../../key-vault', () => ({
  vaultEnvFor: (id: string) =>
    id === 'keyed' ? { FAKE_PROVIDER_KEY: 'sekret-123' } : {},
}));

const { textParser } = await import('../parsers');

// Fake contestants: ordinary shell commands standing in for agent CLIs.
const FAKE_PROVIDERS: Record<string, any> = {
  echoer: {
    id: 'echoer',
    arena: {
      buildCommand: (ref: string) => `echo hello; echo ${ref}`,
      createParser: textParser,
    },
  },
  keyed: {
    id: 'keyed',
    arena: {
      buildCommand: () => 'echo "key=$FAKE_PROVIDER_KEY"',
      createParser: textParser,
    },
  },
  failer: {
    id: 'failer',
    arena: {
      buildCommand: () => 'echo oops >&2; exit 3',
      createParser: textParser,
    },
  },
  sleeper: {
    id: 'sleeper',
    arena: {
      buildCommand: () => 'sleep 30',
      createParser: textParser,
    },
  },
};
mock.module('../../providers', () => ({
  getProvider: (id: string) => {
    const p = FAKE_PROVIDERS[id];
    if (!p) throw new Error(`Unknown session provider: ${id}`);
    return p;
  },
}));

const { ArenaEngine } = await import('../engine');

function collectUntilSettled(engine: InstanceType<typeof ArenaEngine>, expectedFinals: number, timeoutMs = 20_000) {
  const updates: ArenaUpdate[] = [];
  let settled = 0;
  const done = new Promise<ArenaUpdate[]>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`settled ${settled}/${expectedFinals}`)), timeoutMs);
    engine.on('update', (u: ArenaUpdate) => {
      updates.push(u);
      if (u.status !== 'running') {
        settled += 1;
        if (settled >= expectedFinals) {
          clearTimeout(t);
          resolve(updates);
        }
      }
    });
  });
  return done;
}

describe('ArenaEngine', () => {
  test('prepare creates the run without launching; launch streams and finishes', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();
    const settled = collectUntilSettled(engine, 1);

    const run = engine.prepare('arena-prompt-text', ['echoer']);
    expect(run.id.length).toBeGreaterThan(0);

    // Nothing spawned yet: give the loop a beat and confirm silence.
    await new Promise((r) => setTimeout(r, 150));
    expect(finalized.length).toBe(0);

    engine.launch(run.id);
    const updates = await settled;

    const final = updates[updates.length - 1];
    expect(final.status).toBe('done');
    expect(final.totalMs).toBeGreaterThan(0);
    expect(final.ttftMs).toBeGreaterThan(0);
    expect(final.ttftMs!).toBeLessThanOrEqual(final.totalMs!);

    const text = updates.map((u) => u.chunk).join('');
    expect(text).toContain('hello');
    // The prompt reached the CLI through the environment, not the command string.
    expect(text).toContain('arena-prompt-text');
    expect(finalized.length).toBe(1);
    expect(finalized[0].status).toBe('done');
  }, 25_000);

  test('non-zero exit surfaces stderr as an error column', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();
    const settled = collectUntilSettled(engine, 1);
    const run = engine.prepare('p', ['failer']);
    engine.launch(run.id);
    const updates = await settled;
    const final = updates[updates.length - 1];
    expect(final.status).toBe('error');
    expect(final.error).toContain('oops');
    expect(finalized[0].status).toBe('error');
  }, 25_000);

  test('timeout kills the process tree and settles as error', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine(500); // 0.5s contestant timeout
    const settled = collectUntilSettled(engine, 1);
    const run = engine.prepare('p', ['sleeper']);
    engine.launch(run.id);
    const updates = await settled;
    const final = updates[updates.length - 1];
    expect(final.status).toBe('error');
    expect(final.totalMs!).toBeLessThan(10_000);
    expect(finalized.length).toBe(1);
  }, 25_000);

  test('cancelRun settles as Cancelled and never double-finalizes', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();
    const settled = collectUntilSettled(engine, 1);
    const run = engine.prepare('p', ['sleeper']);
    engine.launch(run.id);
    await new Promise((r) => setTimeout(r, 300)); // let it spawn
    engine.cancelRun(run.id);
    const updates = await settled;
    const final = updates[updates.length - 1];
    expect(final.status).toBe('error');
    expect(final.error).toBe('Cancelled');
    // The killed child's close event must not finalize a second time.
    await new Promise((r) => setTimeout(r, 500));
    expect(finalized.length).toBe(1);
  }, 25_000);

  test('vault env is merged into the contestant spawn and wins over ambient env (#99)', async () => {
    finalized.length = 0;
    // An ambient value must lose to the vault-injected one (merge order).
    process.env.FAKE_PROVIDER_KEY = 'ambient-value';
    try {
      const engine = new ArenaEngine();
      const settled = collectUntilSettled(engine, 1);
      const run = engine.prepare('p', ['keyed']);
      engine.launch(run.id);
      const updates = await settled;
      const text = updates.map((u) => u.chunk).join('');
      expect(text).toContain('key=sekret-123');
    } finally {
      delete process.env.FAKE_PROVIDER_KEY;
    }
  }, 25_000);

  test('contestants without vault opt-in get no injected env (#99)', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();
    const settled = collectUntilSettled(engine, 1);
    const run = engine.prepare('p', ['echoer']);
    engine.launch(run.id);
    const updates = await settled;
    const text = updates.map((u) => u.chunk).join('');
    expect(text.includes('sekret-123')).toBe(false);
  }, 25_000);

  test('unknown contestant fails fast without spawning', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();
    const settled = collectUntilSettled(engine, 1);
    const run = engine.prepare('p', ['nope']);
    engine.launch(run.id);
    const updates = await settled;
    expect(updates[updates.length - 1].error).toContain('Unknown contestant');
  }, 10_000);
});
