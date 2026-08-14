/**
 * PtyManager launch-failure detection + install-pty lifecycle tests.
 *
 * node-pty and every DB-backed dependency are mocked; the pty is a hand-fed
 * fake whose onData/onExit callbacks the tests drive directly. Covers:
 * - the one-shot providerHint gate and its 15s window cutoff,
 * - failure signatures surviving a chatty startup (dedicated launch buffer)
 *   and pty chunk splits,
 * - createInstallSession's deferred emission, prime flush, and
 *   exit-before-prime flush,
 * - pty identity (#164): a superseded pty's late exit/output must not touch
 *   the replacement bound to its id, kill() settles off the real exit and
 *   coalesces per id, and the silent resume-failure respawn inherits the last
 *   known size instead of dropping back to 80x24,
 * - live-account publication (#165) for a provider without account support.
 *
 * Run with: bun test src/main/__tests__
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'os';
import { ProviderInstallHint } from '../../shared/types';

interface FakePty {
  pid: number;
  spawnFile: string;
  spawnArgs: string[];
  /** Options node-pty was spawned with — the initial cols/rows live here (#164). */
  spawnOpts: { cols: number; rows: number };
  dataCb: ((data: string) => void) | null;
  exitCb: ((event: { exitCode: number }) => void) | null;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

const spawned: FakePty[] = [];

function fakeSpawn(file: string, args: string[], opts: { cols: number; rows: number }): FakePty {
  const p: FakePty = {
    pid: 1000 + spawned.length,
    spawnFile: file,
    spawnArgs: args,
    spawnOpts: opts,
    dataCb: null,
    exitCb: null,
    onData(cb) { p.dataCb = cb; },
    onExit(cb) { p.exitCb = cb; },
    write() {},
    resize() {},
    kill() { p.exitCb?.({ exitCode: 0 }); },
  };
  spawned.push(p);
  return p;
}

// Mock discipline: bun's mock.module patches a specifier for the whole test
// process, so ONLY mock modules that no other test file exercises for real
// (node-pty, electron-log) or that are mocked with a compatible shape
// elsewhere (electron, preferences, accounts, shell-detector). The provider
// registry, sessions repository, and key-vault are used REAL —
// resolve.test/sessions.test/key-vault.test cover them — which works because
// these tests run codex, a passthrough provider whose capabilities are all
// false, so no DB-backed function is ever called.
mock.module('node-pty', () => ({ spawn: fakeSpawn }));
mock.module('electron-log', () => ({
  default: { info() {}, warn() {}, error() {} },
}));
mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent-bodhilander-test-userdata' },
  safeStorage: { isEncryptionAvailable: () => false },
}));
// null (not '') so the real key-vault sees "no key stored / opt-in off".
mock.module('../repositories/preferences', () => ({
  getPreference: () => null,
  setPreference: () => {},
  deletePreference: () => {},
}));
// Superset of the accounts-repo surface so account-auth.ts stays satisfied
// no matter which file's mock a given evaluation order leaves in place.
mock.module('../repositories/accounts', () => ({
  resolveAccountForSession: () => null,
  touchAccount: () => {},
  getAllAccounts: () => [],
  createAccount: (a: unknown) => a,
  updateAccount: () => undefined,
  deleteAccount: () => undefined,
  getAccount: () => null,
}));
// Any real, existing executable path works — the pty spawn is mocked.
mock.module('../shell-detector', () => ({
  detectShell: () => ({ shell: process.execPath, args: ['-l', '-i'], isWSL: false }),
}));

const { PtyManager } = await import('../pty-manager');
const { getProvider } = await import('../providers');
const codexProvider = getProvider('codex');

const realDateNow = Date.now;
const cwd = os.homedir();

beforeEach(() => {
  spawned.length = 0;
});

afterEach(() => {
  Date.now = realDateNow;
});

function createAgentSession(manager: InstanceType<typeof PtyManager>, id = 'session-1') {
  const hints: ProviderInstallHint[] = [];
  manager.on('providerHint', (hint: ProviderInstallHint) => hints.push(hint));
  manager.createSession(id, cwd, true, 'codex');
  const ptyProc = spawned[spawned.length - 1];
  return { hints, ptyProc };
}

describe('checkSpawnFailure (via session data flow)', () => {
  test('emits providerHint once for a broken-install signature, then never again', () => {
    const manager = new PtyManager();
    const { hints, ptyProc } = createAgentSession(manager);

    ptyProc.dataCb!('Error: spawn /opt/homebrew/lib/node_modules/@openai/codex/vendor/codex ENOENT\n');
    expect(hints.length).toBe(1);
    expect(hints[0]).toMatchObject({
      sessionId: 'session-1',
      providerId: 'codex',
      command: 'codex',
      kind: 'broken',
      installCommand: codexProvider.setup.installCommand!,
    });

    // Same signature again — the one-shot gate holds.
    ptyProc.dataCb!('Error: spawn /x/y ENOENT\n');
    ptyProc.dataCb!('zsh: command not found: codex\n');
    expect(hints.length).toBe(1);
  });

  test("classifies 'missing' from shell command-not-found output", () => {
    const manager = new PtyManager();
    const { hints, ptyProc } = createAgentSession(manager);

    ptyProc.dataCb!('zsh: command not found: codex\n');
    expect(hints.length).toBe(1);
    expect(hints[0].kind).toBe('missing');
  });

  test('matches a signature split across pty data chunks', () => {
    const manager = new PtyManager();
    const { hints, ptyProc } = createAgentSession(manager);

    ptyProc.dataCb!('zsh: command not fo');
    expect(hints.length).toBe(0);
    ptyProc.dataCb!('und: codex\n');
    expect(hints.length).toBe(1);
  });

  test('still fires when a chatty startup precedes the failure line (larger than the 100KB scrollback trim)', () => {
    const manager = new PtyManager();
    const { hints, ptyProc } = createAgentSession(manager);

    // 150KB of benign output — enough that scrollbackBuffer's tail trim has
    // discarded the head. The dedicated launch buffer must still catch the
    // failure line that follows.
    const chunk = 'installing dependencies .'.repeat(41); // ~1KB
    for (let i = 0; i < 150; i++) {
      ptyProc.dataCb!(chunk);
    }
    expect(hints.length).toBe(0);

    ptyProc.dataCb!('\nError: spawn /opt/homebrew/lib/node_modules/@openai/codex/vendor/codex ENOENT\n');
    expect(hints.length).toBe(1);
    expect(hints[0].kind).toBe('broken');
  });

  test('ignores failure signatures after the 15s window (agent output, not a launch failure)', () => {
    const manager = new PtyManager();
    const { hints, ptyProc } = createAgentSession(manager);

    Date.now = () => realDateNow() + 20_000;
    ptyProc.dataCb!('Error: spawn /some/tool ENOENT\n');
    expect(hints.length).toBe(0);
  });

  test('normal startup output emits nothing', () => {
    const manager = new PtyManager();
    const { hints, ptyProc } = createAgentSession(manager);

    ptyProc.dataCb!('OpenAI Codex v0.48.2\nHow can I help?\n');
    expect(hints.length).toBe(0);
  });
});

describe('createInstallSession', () => {
  test('wraps the install command in the user shell', () => {
    const manager = new PtyManager();
    manager.createInstallSession('__install-codex', 'npm install -g --force @openai/codex');

    const ptyProc = spawned[0];
    expect(ptyProc.spawnFile).toBe(process.execPath);
    expect(ptyProc.spawnArgs[ptyProc.spawnArgs.length - 1]).toBe('npm install -g --force @openai/codex');
  });

  test('defers output until primed, then streams live', () => {
    const manager = new PtyManager();
    const events: Array<{ id: string; data: string }> = [];
    manager.on('data', (e: { id: string; data: string }) => events.push(e));

    manager.createInstallSession('__install-codex', 'npm install -g x');
    const ptyProc = spawned[0];

    ptyProc.dataCb!('resolving packages...\n');
    expect(events.length).toBe(0); // held until prime

    manager.primePty('__install-codex');
    expect(events).toEqual([{ id: '__install-codex', data: 'resolving packages...\n' }]);

    ptyProc.dataCb!('added 1 package\n');
    expect(events.length).toBe(2);
    expect(events[1].data).toBe('added 1 package\n');
  });

  test('flushes buffered output when the pty exits before being primed', () => {
    const manager = new PtyManager();
    const events: Array<{ id: string; data: string }> = [];
    const exits: Array<{ id: string; exitCode: number }> = [];
    manager.on('data', (e: { id: string; data: string }) => events.push(e));
    manager.on('exit', (e: { id: string; exitCode: number }) => exits.push(e));

    manager.createInstallSession('__install-codex', 'npm install -g x');
    const ptyProc = spawned[0];

    ptyProc.dataCb!('npm ERR! network unreachable\n');
    ptyProc.exitCb!({ exitCode: 1 });

    // The fast failure is not a blank box: buffered output flushes first.
    expect(events).toEqual([{ id: '__install-codex', data: 'npm ERR! network unreachable\n' }]);
    expect(exits).toEqual([{ id: '__install-codex', exitCode: 1 }]);
    expect(manager.getSession('__install-codex')).toBeUndefined();
  });
});

describe('resize (dynamic sizing)', () => {
  test('drives the pty and fans out a resize event; skips no-op resizes', () => {
    const manager = new PtyManager();
    const { ptyProc } = createAgentSession(manager);
    const calls: Array<[number, number]> = [];
    ptyProc.resize = (c: number, r: number) => calls.push([c, r]);
    const events: Array<{ id: string; cols: number; rows: number }> = [];
    manager.on('resize', (e: { id: string; cols: number; rows: number }) => events.push(e));

    manager.resize('session-1', 100, 40);
    expect(calls).toEqual([[100, 40]]);
    expect(events).toEqual([{ id: 'session-1', cols: 100, rows: 40 }]);

    // A no-op resize (same dimensions) must not churn the pty or re-emit — other
    // viewers shouldn't get a redundant terminal:size.
    manager.resize('session-1', 100, 40);
    expect(calls.length).toBe(1);
    expect(events.length).toBe(1);

    manager.resize('session-1', 80, 24);
    expect(events.length).toBe(2);
    expect(events[1]).toEqual({ id: 'session-1', cols: 80, rows: 24 });
  });

  test('resizing an unknown session is a no-op (no throw, no event)', () => {
    const manager = new PtyManager();
    const events: unknown[] = [];
    manager.on('resize', (e) => events.push(e));
    manager.resize('does-not-exist', 100, 40);
    expect(events).toEqual([]);
  });
});

describe('pty identity (#164)', () => {
  /**
   * The restart shape that lost conversations: kill the pty, spawn a
   * replacement under the SAME id, and only then let the old process die.
   * `neutraliseKill` stops the fake dying synchronously so the test controls
   * when the late exit lands — which is the whole point of the scenario.
   */
  function killThenRespawn(manager: InstanceType<typeof PtyManager>, id = 'session-1') {
    createAgentSession(manager, id);
    const first = spawned[0];
    first.kill = () => {};
    const killed = manager.kill(id);
    manager.createSession(id, cwd, true, 'codex');
    return { first, second: spawned[1], killed };
  }

  test('a late zero-code exit from a killed pty leaves its replacement alone', async () => {
    const manager = new PtyManager();
    const exits: Array<{ id: string; exitCode: number }> = [];
    manager.on('exit', (e: { id: string; exitCode: number }) => exits.push(e));

    const { first, second, killed } = killThenRespawn(manager);
    first.exitCb!({ exitCode: 0 });

    const live = manager.getSession('session-1');
    expect(live).toBeDefined();
    expect(live!.pty).toBe(second as unknown as typeof live.pty);
    expect(exits).toEqual([]);
    expect(spawned.length).toBe(2);
    // Resolves off the real exit, not a timer — no clock is advanced here.
    await killed;
  });

  test('a late non-zero exit from a killed pty neither respawns nor emits exit', async () => {
    const manager = new PtyManager();
    const exits: Array<{ id: string; exitCode: number }> = [];
    manager.on('exit', (e: { id: string; exitCode: number }) => exits.push(e));

    const { first, second, killed } = killThenRespawn(manager);
    // Non-zero inside the resume-failure window is the branch that used to
    // clear the replacement's conversation UUID and spawn a third pty.
    first.exitCb!({ exitCode: 1 });

    expect(spawned.length).toBe(2);
    expect(manager.getSession('session-1')!.pty).toBe(second as unknown as never);
    expect(exits).toEqual([]);
    await killed;
  });

  test('stale output from a superseded pty never reaches its replacement', async () => {
    const manager = new PtyManager();
    const events: Array<{ id: string; data: string }> = [];
    manager.on('data', (e: { id: string; data: string }) => events.push(e));

    const { first, killed } = killThenRespawn(manager);
    first.dataCb!('STALE-BYTES');

    expect(events.some(e => e.data.includes('STALE-BYTES'))).toBe(false);
    expect(manager.getBuffer('session-1')).not.toContain('STALE-BYTES');

    first.exitCb!({ exitCode: 0 });
    await killed;
  });

  test('kill() coalesces so a second caller waits on the same exit', async () => {
    const manager = new PtyManager();
    createAgentSession(manager);
    const first = spawned[0];
    first.kill = () => {};

    // The renderer's restart kills from both the effect cleanup and the
    // restart effect; the second caller must join the first teardown rather
    // than see an empty map and conclude the process is already gone.
    const a = manager.kill('session-1');
    const b = manager.kill('session-1');

    let settled = 0;
    const aSettled = a.then(() => { settled++; });
    const bSettled = b.then(() => { settled++; });

    first.exitCb!({ exitCode: 0 });
    await Promise.all([aSettled, bSettled]);
    expect(settled).toBe(2);
  });

  test('the resume-failure respawn keeps the last known size', () => {
    const manager = new PtyManager();
    const exits: unknown[] = [];
    manager.on('exit', (e) => exits.push(e));
    createAgentSession(manager);
    manager.resize('session-1', 120, 40);

    // Only claude declares capabilities.resume, and reaching for it here would
    // drag in the real sessions repo + account resolver this file may not mock.
    // Flipping the flag on the live session reaches the same branch.
    const live = manager.getSession('session-1')! as unknown as { resumeAttempted: boolean };
    live.resumeAttempted = true;

    spawned[0].exitCb!({ exitCode: 1 });

    expect(spawned.length).toBe(2);
    expect(spawned[1].spawnOpts.cols).toBe(120);
    expect(spawned[1].spawnOpts.rows).toBe(40);
    expect(manager.getSize('session-1')).toEqual({ cols: 120, rows: 40 });
    // The fallback is deliberately silent — the renderer must not see a stop.
    expect(exits).toEqual([]);
  });

  test('a second create for a live session id is refused instead of orphaning the first pty', () => {
    const manager = new PtyManager();
    createAgentSession(manager);

    // Overwriting the map entry left the displaced Claude Code running with
    // nothing holding a handle to it: the identity guard swallows its exit and
    // drops its output, so it would leak silently for the life of the app.
    expect(() => manager.createSession('session-1', cwd, true, 'codex')).toThrow(/already has a running pty/);
    expect(spawned.length).toBe(1);
    expect(manager.getSession('session-1')!.pty).toBe(spawned[0] as unknown as never);
  });

  test('a resume failure keeps the conversation when its transcript was staged', () => {
    const manager = new PtyManager();
    const exits: Array<{ id: string; exitCode: number }> = [];
    manager.on('exit', (e: { id: string; exitCode: number }) => exits.push(e));
    createAgentSession(manager);

    // Same reach-in as the size test above: only claude declares
    // capabilities.accounts, and launching it here would drag in the real
    // sessions repo and account resolver this file deliberately does not mock.
    const live = manager.getSession('session-1')! as unknown as {
      resumeAttempted: boolean;
      transcriptStaged: string;
    };
    live.resumeAttempted = true;
    live.transcriptStaged = 'carried';

    spawned[0].exitCb!({ exitCode: 1 });

    // The transcript is demonstrably in the dir this pty launched under, so the
    // non-zero exit is evidence of something else — a bad key, a broken MCP
    // entry, a shell rc — and must not cost the user their conversation id.
    expect(spawned.length).toBe(1);
    expect(exits).toEqual([{ id: 'session-1', exitCode: 1 }]);
  });

  test('a resume failure whose transcript is nowhere still respawns fresh', () => {
    const manager = new PtyManager();
    const exits: unknown[] = [];
    manager.on('exit', (e) => exits.push(e));
    createAgentSession(manager);

    const live = manager.getSession('session-1')! as unknown as {
      resumeAttempted: boolean;
      transcriptStaged: string;
    };
    live.resumeAttempted = true;
    live.transcriptStaged = 'missing';

    spawned[0].exitCb!({ exitCode: 1 });

    // Searched every known config dir and found nothing: the stored id really
    // is unusable, and BDHLNDR-9's silent restart is the recovery.
    expect(spawned.length).toBe(2);
    expect(exits).toEqual([]);
  });

  test('createSession honours an explicit initial size', () => {
    const manager = new PtyManager();
    manager.createSession('s2', cwd, true, 'codex', { cols: 100, rows: 30 });

    expect(spawned[0].spawnOpts.cols).toBe(100);
    expect(spawned[0].spawnOpts.rows).toBe(30);
    expect(manager.getSize('s2')).toEqual({ cols: 100, rows: 30 });
  });
});

describe('live account bindings (#165)', () => {
  test('no binding is published for a provider without account support', () => {
    const manager = new PtyManager();
    const bindings: Array<{ id: string; binding: unknown }> = [];
    manager.on('liveAccount', (e: { id: string; binding: unknown }) => bindings.push(e));

    manager.createSession('session-1', cwd, true, 'codex');

    // codex never reads CLAUDE_CONFIG_DIR, so "running under ~/.claude" would
    // be a lie rather than a default.
    expect(manager.getLiveAccounts()).toEqual({});
    expect(bindings).toEqual([{ id: 'session-1', binding: null }]);
  });
});

describe('getSerializedBuffer (rendered-text history)', () => {
  test('returns resolved text of the scrollback, keeping content that scrolled off', async () => {
    const manager = new PtyManager();
    const { ptyProc } = createAgentSession(manager);
    ptyProc.dataCb!('\x1b[32mhello\x1b[0m world\r\n');
    for (let i = 0; i < 40; i++) ptyProc.dataCb!(`line ${i}\r\n`);

    const text = await manager.getSerializedBuffer('session-1');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('hello');
    // "line 5" scrolled off the 24-row screen — it must survive in the serialized
    // scrollback (this is the history a phone reads).
    expect(text).toContain('line 5');
  });

  test('returns empty string for an unknown session', async () => {
    const manager = new PtyManager();
    expect(await manager.getSerializedBuffer('nope')).toBe('');
  });
});
