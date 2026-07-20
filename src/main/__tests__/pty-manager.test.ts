/**
 * PtyManager launch-failure detection + install-pty lifecycle tests.
 *
 * node-pty and every DB-backed dependency are mocked; the pty is a hand-fed
 * fake whose onData/onExit callbacks the tests drive directly. Covers:
 * - the one-shot providerHint gate and its 15s window cutoff,
 * - failure signatures surviving a chatty startup (dedicated launch buffer)
 *   and pty chunk splits,
 * - createInstallSession's deferred emission, prime flush, and
 *   exit-before-prime flush.
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
  dataCb: ((data: string) => void) | null;
  exitCb: ((event: { exitCode: number }) => void) | null;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

const spawned: FakePty[] = [];

function fakeSpawn(file: string, args: string[]): FakePty {
  const p: FakePty = {
    pid: 1000 + spawned.length,
    spawnFile: file,
    spawnArgs: args,
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
// (node-pty, electron-log, memory/injector) or that are mocked with a
// compatible shape elsewhere (electron, preferences, accounts,
// shell-detector). The provider registry, sessions repository, and key-vault
// are used REAL — resolve.test/sessions.test/key-vault.test cover them —
// which works because these tests run codex, a passthrough provider whose
// capabilities are all false, so no DB-backed function is ever called.
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
mock.module('../memory/injector', () => ({
  writeMemoryFile: () => {},
  getMemoryInjectionContent: () => null,
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
  manager.createSession(id, cwd, true, null, 'codex');
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
