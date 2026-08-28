/**
 * The exporter's two formats and the importer's routing between them, driven
 * through scripted dialogs. What is pinned here is the choice, the size shown
 * before a byte is written, and the root question an import has to ask.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { freshDb, seedSourceDb, writeTranscript } from '../transfer/__tests__/db-fixture';

let db: Database;
let tmp: string;
let userDataDir: string;
let legacyDir: string;

const messageBoxes: { message?: string; detail?: string }[] = [];
const openDialogs: { title?: string }[] = [];
let messageBoxResponses: number[] = [];
let openDialogPaths: (string | null)[] = [];
let saveDialogPath: string | null = null;

// Superset of the `{ app }` stub the provider and pty suites register, plus the
// three dialogs this module drives. Nothing here is exercised for real.
mock.module('electron', () => ({
  app: {
    getVersion: () => '3.5.1-beta.6',
    getPath: (name: string) => (name === 'documents' ? path.join(tmp, 'docs') : userDataDir),
    // Hook registration resolves its script relative to this.
    getAppPath: () => path.join(tmp, 'app'),
  },
  dialog: {
    showMessageBox: async (opts: { message?: string; detail?: string }) => {
      messageBoxes.push(opts);
      return { response: messageBoxResponses.shift() ?? 0 };
    },
    showOpenDialog: async (opts: { title?: string }) => {
      openDialogs.push(opts);
      const next = openDialogPaths.shift();
      return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
    },
    showSaveDialog: async () =>
      saveDialogPath ? { canceled: false, filePath: saveDialogPath } : { canceled: true, filePath: undefined },
  },
}));
mock.module('../database', () => ({ getDatabase: () => db }));

const { exportGroupsAndSessions, importGroupsAndSessions } = await import('../group-import-export');
const { decodeBundle, looksLikeBundle } = await import('../transfer/bundle-format');

/**
 * No proposal for any root. The real suggester walks the home directory of
 * whoever runs the suite — left alone it found this repo's own checkout and
 * proposed it, which is the feature working and a test that cannot be trusted.
 */
const noSuggestions = () => [];

const SOURCE_ROOT = '/src-machine/Work/Repos';
const SOURCE_DIR = `${SOURCE_ROOT}/Bodhilander`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-cmd-'));
  userDataDir = path.join(tmp, 'userData');
  // Passed explicitly: os.homedir() is fixed at process start under bun, so a
  // default would walk the developer's own ~/.claude transcripts.
  legacyDir = path.join(tmp, 'home', '.claude');
  fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
  messageBoxes.length = 0;
  openDialogs.length = 0;
  messageBoxResponses = [];
  openDialogPaths = [];
  saveDialogPath = null;

  // The hook script registerHooks refuses to register without.
  fs.mkdirSync(path.join(tmp, 'app', 'dist', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'app', 'dist', 'hooks', 'bodhilander-hook.js'), '', 'utf-8');

  db = freshDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedWithTranscript(): void {
  const configDir = path.join(userDataDir, 'claude-accounts', 'acct-1', '.claude');
  seedSourceDb(db, { accountConfigDir: configDir, workingDirs: [SOURCE_DIR] });
  writeTranscript(configDir, '-src-machine-Work-Repos-Bodhilander', 'conv-1', '{"type":"user"}\n');
}

describe('export', () => {
  test('writes a transfer bundle and shows its size before the file exists', async () => {
    seedWithTranscript();
    saveDialogPath = path.join(tmp, 'out.bodhilander-bundle');
    messageBoxResponses = [0, 0]; // "Everything on this machine", then "Save Bundle"

    const result = await exportGroupsAndSessions(legacyDir);

    expect(result.success).toBe(true);
    expect(result.sizeLabel).toMatch(/^\d+(\.\d)? (B|KB|MB)$/);
    expect(messageBoxes[1].message).toBe(`This bundle will be ${result.sizeLabel}.`);

    const bytes = fs.readFileSync(saveDialogPath);
    expect(looksLikeBundle(bytes)).toBe(true);
    expect(decodeBundle(bytes).manifest.workingDirRoots).toEqual([SOURCE_DIR]);
  });

  test('the size is quoted before the save dialog is reached', async () => {
    seedWithTranscript();
    messageBoxResponses = [0, 1]; // declined at the size prompt

    const result = await exportGroupsAndSessions(legacyDir);

    expect(result.success).toBe(false);
    expect(messageBoxes).toHaveLength(2);
    expect(messageBoxes[1].message).toMatch(/^This bundle will be /);
  });

  test('the portable JSON is still what the other choice writes', async () => {
    seedWithTranscript();
    saveDialogPath = path.join(tmp, 'out.json');
    messageBoxResponses = [1]; // "Groups & sessions only"

    const result = await exportGroupsAndSessions(legacyDir);

    expect(result.success).toBe(true);
    const written = JSON.parse(fs.readFileSync(saveDialogPath, 'utf-8'));
    expect(written.version).toBe(1);
    expect(written.sessions[0].workingDir).toBe(SOURCE_DIR);
  });

  test('cancelling the format question writes nothing', async () => {
    seedWithTranscript();
    messageBoxResponses = [2];

    expect(await exportGroupsAndSessions(legacyDir)).toEqual({ success: false, error: 'Export cancelled' });
    expect(fs.readdirSync(path.join(tmp, 'docs'))).toEqual([]);
  });
});

describe('import', () => {
  async function exportedBundle(): Promise<string> {
    seedWithTranscript();
    saveDialogPath = path.join(tmp, 'bundle.bodhilander-bundle');
    messageBoxResponses = [0, 0];
    await exportGroupsAndSessions(legacyDir);

    db.close();
    db = freshDb();
    messageBoxes.length = 0;
    openDialogs.length = 0;
    return saveDialogPath;
  }

  test('asks about every root and applies the folder the user picks', async () => {
    const bundle = await exportedBundle();
    // The manifest's only root IS the session's folder, so the mapping is exact.
    const here = path.join(tmp, 'here');
    fs.mkdirSync(here, { recursive: true });

    openDialogPaths = [bundle, here];
    messageBoxResponses = [0]; // "Choose Folder…" for the single root

    const result = await importGroupsAndSessions(legacyDir, noSuggestions);

    expect(result.success).toBe(true);
    expect(messageBoxes[0].message).toBe(SOURCE_DIR);
    expect(result.groupCount).toBe(1);
    expect(result.sessionCount).toBe(1);
    expect(result.transcriptCount).toBe(1);
    expect(result.needsRelinkCount).toBe(0);

    const row = db.prepare('SELECT working_dir, state FROM sessions WHERE id = ?').get('s1') as any;
    expect(row.working_dir).toBe(here);
    expect(row.state).toBe('stopped');
    expect(fs.existsSync(row.working_dir)).toBe(true);
  });

  test('a restored account gets its hooks registered, not on the next launch', async () => {
    const bundle = await exportedBundle();
    const here = path.join(tmp, 'here');
    fs.mkdirSync(here, { recursive: true });
    openDialogPaths = [bundle, here];
    messageBoxResponses = [0];

    await importGroupsAndSessions(legacyDir, noSuggestions);

    // Without this the restored account reports no state until a restart.
    const settings = path.join(userDataDir, 'claude-accounts', 'acct-1', '.claude', 'settings.json');
    expect(fs.existsSync(settings)).toBe(true);
    expect(fs.readFileSync(settings, 'utf-8')).toContain('bodhilander-hook.js');
  });

  test('leaving a root as it was parks the sessions under it', async () => {
    const bundle = await exportedBundle();
    openDialogPaths = [bundle];
    messageBoxResponses = [1]; // "Leave As Is"

    const result = await importGroupsAndSessions(legacyDir, noSuggestions);

    expect(result.success).toBe(true);
    expect(result.needsRelinkCount).toBe(1);
    const row = db.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('s1') as any;
    expect(fs.existsSync(row.working_dir)).toBe(false);
  });

  test('cancelling at a root leaves the database untouched', async () => {
    const bundle = await exportedBundle();
    openDialogPaths = [bundle];
    messageBoxResponses = [2]; // "Cancel Import"

    expect(await importGroupsAndSessions(legacyDir, noSuggestions)).toEqual({ success: false, error: 'Import cancelled' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n).toBe(0);
  });

  test('a portable JSON still takes the older path, with no root questions', async () => {
    const file = path.join(tmp, 'legacy.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      sourceApp: 'bodhilander',
      exportedAt: '2026-01-01T00:00:00.000Z',
      groups: [{ id: 'g9', name: 'Old', color: '#888', workingDir: tmp, parentId: null, collapsed: false, order: 0, createdAt: '2026-01-01T00:00:00.000Z' }],
      sessions: [{ id: 's9', groupId: 'g9', name: 'Old', workingDir: tmp, shellType: 'claude', claudeSessionId: null, order: 0, createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z' }],
    }), 'utf-8');
    openDialogPaths = [file];

    const result = await importGroupsAndSessions(legacyDir, noSuggestions);

    expect(result.success).toBe(true);
    expect(result.groupCount).toBe(1);
    expect(messageBoxes).toHaveLength(0);
  });

  test('a portable JSON this exporter just wrote imports again', async () => {
    seedWithTranscript();
    saveDialogPath = path.join(tmp, 'roundtrip.json');
    messageBoxResponses = [1]; // "Groups & sessions only"
    expect((await exportGroupsAndSessions(legacyDir)).success).toBe(true);

    db.close();
    db = freshDb();
    openDialogPaths = [saveDialogPath];

    const result = await importGroupsAndSessions(legacyDir, noSuggestions);

    expect(result.success).toBe(true);
    expect(result.groupCount).toBe(1);
    expect(result.sessionCount).toBe(1);
    const row = db.prepare('SELECT claude_session_id FROM sessions').get() as any;
    expect(row.claude_session_id).toBe('conv-1');
  });

  test('cancelling the file picker changes nothing', async () => {
    openDialogPaths = [];
    expect(await importGroupsAndSessions(legacyDir, noSuggestions)).toEqual({ success: false, error: 'Import cancelled' });
  });
});
