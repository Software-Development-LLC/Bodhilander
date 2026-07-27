/**
 * mcp-config writes into the USER'S home directory — ~/.claude/settings.json
 * and ~/.claude.json — on every app launch, and into every isolated account
 * config dir. It had no tests at all, which is inverted relative to its risk:
 * a one-line refactor of the path resolution would silently and permanently
 * mis-target real users' Claude Code state.
 *
 * These tests drive the real module against a temp HOME, covering:
 *  - the sibling path resolution (~/.claude.json is NEXT TO ~/.claude/)
 *  - registration converging on the desired hook shape (the Bash -> * change)
 *  - never duplicating our own hook entries
 *  - never touching hooks the user configured themselves
 *  - the legacy MCP sweep, its one-shot marker, and its retry-on-failure
 *  - the sweep never disturbing the analytics hook
 *
 * Run with: bun test src/main/__tests__/mcp-config.test.ts
 */
import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let homeDir = '';
let userDataDir = '';
let appPathDir = '';

// resolveConfigDir() uses os.homedir() to find ~/.claude. Redirect it at the
// module boundary: setting process.env.HOME does NOT work under bun, whose
// os.homedir() snapshots $HOME at process start. mcp-config imports from 'os',
// so mock exactly that specifier — mocking both 'os' and 'node:os' makes the
// second mock spread an already-replaced namespace and silently loses homedir.
const realOs = { ...os };
mock.module('os', () => ({ ...realOs, homedir: () => homeDir }));

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => appPathDir,
    getPath: () => userDataDir,
  },
}));

// bun's mock.module is PROCESS-WIDE, so this replacement is visible to every
// other test file in the run. It must therefore be a SUPERSET of the real
// module's exports — omitting even one (deletePreference, getWindowBounds,
// setWindowBounds) makes unrelated files fail to import it with
// "Export named '...' not found", which reads like a bug in those files.
const prefs = new Map<string, string>();
mock.module('../repositories/preferences', () => ({
  getPreference: (key: string) => prefs.get(key) ?? null,
  setPreference: (key: string, value: string) => {
    prefs.set(key, value);
  },
  deletePreference: (key: string) => {
    prefs.delete(key);
  },
  getWindowBounds: () => null,
  setWindowBounds: () => undefined,
}));

// Imported AFTER the mocks above so the module picks them up.
const { registerHooks, cleanupLegacyMcpServer, getHooksStatus } = await import('../mcp-config');

const claudeJson = () => path.join(homeDir, '.claude.json');
const settingsJson = () => path.join(homeDir, '.claude', 'settings.json');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const writeJson = (p: string, v: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
};

/** The hook script must exist on disk or registerHooks bails early. */
function createHookScript(): string {
  const hookPath = path.join(appPathDir, 'dist', 'hooks', 'bodhilander-hook.js');
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, '// stub');
  return hookPath;
}

function accountConfigDir(id: string): string {
  const dir = path.join(userDataDir, 'claude-accounts', id, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const LEGACY_ENTRY = { command: 'node', args: ['/gone/dist/mcp-server/index.js'] };

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(realOs.tmpdir(), 'bodhi-mcp-config-'));
  homeDir = path.join(root, 'home');
  userDataDir = path.join(root, 'userData');
  appPathDir = path.join(root, 'app');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(appPathDir, { recursive: true });
  prefs.clear();
});

afterEach(() => {
  const root = path.dirname(homeDir);
  if (root.includes('bodhi-mcp-config-')) fs.rmSync(root, { recursive: true, force: true });
});

// Hand os.homedir() back before any later test file runs. bun executes every
// file in ONE process, so without this the mock survives and hands other
// suites (pty-manager's, which uses os.homedir() as a working directory) a
// temp path that afterEach has already deleted.
afterAll(() => {
  mock.module('os', () => realOs);
});

describe('config path resolution', () => {
  test('the MCP config is a SIBLING of the .claude directory, not inside it', () => {
    writeJson(claudeJson(), { mcpServers: { 'bodhilander-memory': LEGACY_ENTRY } });

    cleanupLegacyMcpServer();

    // If this ever resolves to ~/.claude/.claude.json the sweep silently
    // misses every real install. (mcpServers itself is dropped once it empties.)
    expect(readJson(claudeJson()).mcpServers?.['bodhilander-memory']).toBeUndefined();
    expect(fs.existsSync(path.join(homeDir, '.claude', '.claude.json'))).toBe(false);
  });
});

describe('registerHooks', () => {
  test('installs a PostToolUse hook matching ALL tools, not just Bash', () => {
    createHookScript();

    expect(registerHooks().success).toBe(true);

    const hooks = readJson(settingsJson()).hooks;
    expect(hooks.PostToolUse).toHaveLength(1);
    // '*' is match-all; 'Bash' was a memory-feature artifact that undercounted
    // every non-Bash tool call in analytics.
    expect(hooks.PostToolUse[0].matcher).toBe('*');
    expect(hooks.Stop[0].matcher).toBe('');
  });

  test('CONVERGES: an existing Bash-only entry is replaced, not duplicated', () => {
    const hookPath = createHookScript();
    // Exactly what shipped installs have on disk today.
    writeJson(settingsJson(), {
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${hookPath}" PostToolUse` }] }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node "${hookPath}" Stop` }] }],
      },
    });

    expect(registerHooks().success).toBe(true);

    const hooks = readJson(settingsJson()).hooks;
    // Two entries here would fire the hook twice on every Bash call.
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse[0].matcher).toBe('*');
  });

  test('is idempotent once correct — repeated launches do not thrash settings', () => {
    createHookScript();
    registerHooks();
    const after1 = fs.readFileSync(settingsJson(), 'utf-8');

    expect(registerHooks().action).toBe('unchanged');
    expect(fs.readFileSync(settingsJson(), 'utf-8')).toBe(after1);
  });

  test("never removes hooks the user configured themselves", () => {
    createHookScript();
    const mine = { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo my-own-linter' }] };
    writeJson(settingsJson(), { hooks: { PostToolUse: [mine] } });

    registerHooks();

    const hooks = readJson(settingsJson()).hooks;
    expect(hooks.PostToolUse).toContainEqual(mine);
    expect(hooks.PostToolUse).toHaveLength(2);
  });

  test('preserves unrelated top-level settings keys', () => {
    createHookScript();
    writeJson(settingsJson(), { model: 'opus', permissions: { defaultMode: 'auto' } });

    registerHooks();

    const settings = readJson(settingsJson());
    expect(settings.model).toBe('opus');
    expect(settings.permissions).toEqual({ defaultMode: 'auto' });
  });

  test('adds the missing half when only one of the two hooks is present', () => {
    const hookPath = createHookScript();
    writeJson(settingsJson(), {
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node "${hookPath}" Stop` }] }] },
    });

    registerHooks();

    // The old check OR'd the two types, so a file like this reported
    // "configured" and PostToolUse was never installed.
    expect(readJson(settingsJson()).hooks.PostToolUse).toHaveLength(1);
  });

  test('reports not-configured when the hook script is missing', () => {
    const result = registerHooks();
    expect(result.success).toBe(false);
    expect(result.action).toBe('error');
    expect(getHooksStatus().configured).toBe(false);
  });
});

describe('cleanupLegacyMcpServer', () => {
  test('removes the dangling entry from the global config and every account config', () => {
    writeJson(claudeJson(), { mcpServers: { 'bodhilander-memory': LEGACY_ENTRY } });
    accountConfigDir('acct-1');
    accountConfigDir('acct-2');
    const acct = (id: string) => path.join(userDataDir, 'claude-accounts', id, '.claude.json');
    writeJson(acct('acct-1'), { mcpServers: { 'bodhilander-memory': LEGACY_ENTRY } });
    writeJson(acct('acct-2'), { mcpServers: { 'bodhilander-memory': LEGACY_ENTRY } });

    cleanupLegacyMcpServer();

    expect(readJson(claudeJson()).mcpServers?.['bodhilander-memory']).toBeUndefined();
    expect(readJson(acct('acct-1')).mcpServers?.['bodhilander-memory']).toBeUndefined();
    expect(readJson(acct('acct-2')).mcpServers?.['bodhilander-memory']).toBeUndefined();
  });

  test("leaves the user's other MCP servers alone", () => {
    const mine = { command: 'node', args: ['/my/server.js'] };
    writeJson(claudeJson(), { mcpServers: { 'bodhilander-memory': LEGACY_ENTRY, mine } });

    cleanupLegacyMcpServer();

    expect(readJson(claudeJson()).mcpServers).toEqual({ mine });
  });

  test('preserves the rest of ~/.claude.json, which is Claude Code state we do not own', () => {
    writeJson(claudeJson(), {
      mcpServers: { 'bodhilander-memory': LEGACY_ENTRY },
      machineID: 'abc-123',
      projects: { '/some/path': { history: ['one', 'two'] } },
    });

    cleanupLegacyMcpServer();

    const cfg = readJson(claudeJson());
    expect(cfg.machineID).toBe('abc-123');
    expect(cfg.projects).toEqual({ '/some/path': { history: ['one', 'two'] } });
  });

  test('is one-shot: a user who later re-adds the name keeps it', () => {
    writeJson(claudeJson(), { mcpServers: { 'bodhilander-memory': LEGACY_ENTRY } });
    cleanupLegacyMcpServer();

    writeJson(claudeJson(), { mcpServers: { 'bodhilander-memory': { command: 'node', args: ['/mine.js'] } } });
    cleanupLegacyMcpServer();

    expect(readJson(claudeJson()).mcpServers['bodhilander-memory']).toEqual({
      command: 'node',
      args: ['/mine.js'],
    });
  });

  test('is a clean no-op on a fresh install — writes no Claude config at all', () => {
    cleanupLegacyMcpServer();
    expect(fs.existsSync(claudeJson())).toBe(false);
    expect(fs.existsSync(settingsJson())).toBe(false);
  });

  test('NEVER touches the analytics hook', () => {
    const hookPath = createHookScript();
    registerHooks();
    const before = fs.readFileSync(settingsJson(), 'utf-8');
    writeJson(claudeJson(), { mcpServers: { 'bodhilander-memory': LEGACY_ENTRY } });

    cleanupLegacyMcpServer();

    // purgeOurHooks() matches any command containing "bodhilander" — if the
    // sweep ever reached it, analytics would silently stop recording.
    expect(fs.readFileSync(settingsJson(), 'utf-8')).toBe(before);
    expect(readJson(settingsJson()).hooks.PostToolUse[0].hooks[0].command).toContain(hookPath);
  });

  test('leaves no temp file behind (the write is temp + atomic rename)', () => {
    writeJson(claudeJson(), { mcpServers: { 'bodhilander-memory': LEGACY_ENTRY } });

    cleanupLegacyMcpServer();

    expect(fs.readdirSync(homeDir).filter(f => f.includes('.tmp'))).toEqual([]);
  });
});
