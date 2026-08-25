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

// In-memory stand-in mirroring the repo's semantics (round ordering,
// session_ref persistence) so prepareFollowUp can be exercised for real. It
// mirrors the repo's FULL export shape: in a shared-registry run a partial
// mock namespace reads as "Export named '…' not found" to any later importer.
const finalized: any[] = [];
const store = {
  runs: new Map<string, any>(),
  responses: [] as any[],
};
mock.module('../../repositories/arena', () => ({
  createRun: (id: string, prompt: string, workingDir: string | null = null) => {
    store.runs.set(id, { id, prompt, workingDir, createdAt: new Date(0) });
  },
  createResponse: (id: string, runId: string, provider: string, round = 0, prompt: string | null = null) => {
    store.responses.push({
      id, runId, provider, round, prompt,
      sessionRef: null, status: 'running', text: '',
      ttftMs: null, totalMs: null, inputTokens: null, outputTokens: null, costUsd: null, error: null,
    });
  },
  finalizeResponse: (id: string, final: any) => {
    finalized.push({ id, ...final });
    const row = store.responses.find((r) => r.id === id);
    if (row) {
      Object.assign(row, {
        status: final.status,
        text: final.text,
        sessionRef: final.sessionRef,
        error: final.error,
      });
    }
  },
  settleInterruptedResponses: () => {
    let settled = 0;
    for (const row of store.responses) {
      if (row.status === 'running') {
        row.status = 'error';
        row.error = 'Interrupted by app restart';
        settled += 1;
      }
    }
    return settled;
  },
  getRun: (id: string) => {
    const run = store.runs.get(id);
    if (!run) return null;
    const responses = store.responses
      .filter((r) => r.runId === id)
      .sort((a, b) => a.round - b.round || a.provider.localeCompare(b.provider));
    return { ...run, responses };
  },
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
  pwder: {
    id: 'pwder',
    arena: {
      buildCommand: () => 'pwd',
      createParser: textParser,
    },
  },
  stdinReader: {
    id: 'stdinReader',
    arena: {
      // `cat` reads stdin to EOF — exactly what codex exec does headlessly.
      // If the engine leaves the stdin pipe open this never exits.
      buildCommand: () => 'cat; echo after-stdin-eof',
      createParser: textParser,
    },
  },
  resumer: {
    id: 'resumer',
    arena: {
      buildCommand: (ref: string, sid: string) => `echo start:${sid}; echo ${ref}`,
      buildResumeCommand: (ref: string, sid: string) => `echo resumed:${sid}; echo ${ref}`,
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

  test('shell metacharacters in the prompt are never executed (#106)', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();
    const settled = collectUntilSettled(engine, 1);
    // If the env-ref path ever re-parsed the prompt, the substitution would
    // run and the literal `$(echo ...)` wrapper would vanish from output.
    const hostile = 'hi"; $(echo EXECUTED_MARKER); `echo BACKTICK_MARKER`; & echo AMP "bye';
    const run = engine.prepare(hostile, ['echoer']);
    engine.launch(run.id);
    const updates = await settled;
    const text = updates.map((u) => u.chunk).join('');
    expect(updates[updates.length - 1].status).toBe('done');
    expect(text).toContain('$(echo EXECUTED_MARKER)');
    expect(text).toContain('`echo BACKTICK_MARKER`');
  }, 25_000);

  test('a scoped run spawns contestants inside the working directory', async () => {
    finalized.length = 0;
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-cwd-'));
    try {
      const engine = new ArenaEngine();
      const settled = collectUntilSettled(engine, 1);
      const run = engine.prepare('p', ['pwder'], dir);
      engine.launch(run.id);
      const updates = await settled;
      expect(updates[updates.length - 1].status).toBe('done');
      const text = updates.map((u) => u.chunk).join('');
      // realpath: the shell resolves symlinked tmpdirs (/tmp → /private/tmp).
      expect(text).toContain(fs.realpathSync(dir));
    } finally {
      fs.rmdirSync(dir);
    }
  }, 25_000);

  test('an unscoped run keeps the engine process cwd behavior', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();
    const settled = collectUntilSettled(engine, 1);
    const run = engine.prepare('p', ['pwder']);
    engine.launch(run.id);
    const updates = await settled;
    expect(updates[updates.length - 1].status).toBe('done');
  }, 25_000);

  test('stdin is closed at spawn so stdin-to-EOF CLIs cannot hang (codex exec)', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();
    const settled = collectUntilSettled(engine, 1, 10_000);
    const run = engine.prepare('p', ['stdinReader']);
    engine.launch(run.id);
    const updates = await settled;
    const final = updates[updates.length - 1];
    expect(final.status).toBe('done');
    expect(updates.map((u) => u.chunk).join('')).toContain('after-stdin-eof');
  }, 15_000);

  test('follow-up round resumes the persisted session ref and records the new prompt', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();

    const settled1 = collectUntilSettled(engine, 1);
    const run = engine.prepare('first question', ['resumer']);
    engine.launch(run.id);
    await settled1;
    const sessionRef = finalized[0].sessionRef;
    expect(sessionRef).toBeTruthy();

    // Registered after round 0 settled, so it only observes round 1.
    const settled2 = collectUntilSettled(engine, 1);
    const updated = engine.prepareFollowUp(run.id, 'follow-up question');
    expect(updated.responses.length).toBe(2);
    expect(updated.responses[1].round).toBe(1);
    expect(updated.responses[1].prompt).toBe('follow-up question');

    engine.launch(run.id);
    await settled2;

    expect(finalized.length).toBe(2);
    expect(finalized[1].status).toBe('done');
    // The resume command line ran, against the round-0 session ref, and the
    // follow-up prompt travelled through the environment.
    expect(finalized[1].text).toContain(`resumed:${sessionRef}`);
    expect(finalized[1].text).toContain('follow-up question');
    // Session ref carries forward so a third round can resume again.
    expect(finalized[1].sessionRef).toBe(sessionRef);
  }, 25_000);

  test('follow-up refuses a run whose only contestant errored', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();
    const settled = collectUntilSettled(engine, 1);
    const run = engine.prepare('p', ['failer']);
    engine.launch(run.id);
    await settled;
    expect(() => engine.prepareFollowUp(run.id, 'follow')).toThrow(/resumed/);
  }, 25_000);

  test('follow-up skips providers without a resume command', async () => {
    finalized.length = 0;
    const engine = new ArenaEngine();
    const settled = collectUntilSettled(engine, 1);
    const run = engine.prepare('p', ['echoer']); // echoer has no buildResumeCommand
    engine.launch(run.id);
    await settled;
    expect(() => engine.prepareFollowUp(run.id, 'follow')).toThrow(/resumed/);
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
