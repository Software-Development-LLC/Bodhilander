/**
 * Restoring onto a machine that did not write the bundle: paths rewritten,
 * config dirs rebuilt, a missing folder parked rather than launched, a
 * half-failed import leaving nothing. Run with: bun test src/main/transfer
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BUNDLE_FORMAT_VERSION, encodeBundle, LEGACY_ACCOUNT_KEY, TABLES_ENTRY, TRANSCRIPT_PREFIX, type TransferManifest } from '../bundle-format';
import { buildTransferBundle } from '../bundle-export';
import { freshDb, seedSecrets, seedSourceDb, writeTranscript } from './db-fixture';

// The provider registry's import chain reaches electron (providers/claude.ts
// calls app.getPath at buildCommand time). Same stub, same shape, as
// providers/__tests__/resolve.test.ts — buildCommand is never run here.
mock.module('electron', () => ({ app: { getPath: () => '/nonexistent-bodhilander-test-userdata' } }));

const { readBundleManifest, restoreTransferBundle } = await import('../bundle-import');

const SOURCE_ROOT = '/src-machine/Work/Repos';
const SOURCE_DIR = `${SOURCE_ROOT}/Bodhilander`;

let source: Database;
let destination: Database;
let tmp: string;
let sourceConfigDir: string;
let sourceLegacyDir: string;
let destAccountsRoot: string;
let destLegacyDir: string;
let destProjects: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-import-'));
  sourceConfigDir = path.join(tmp, 'src-userData', 'claude-accounts', 'acct-1', '.claude');
  sourceLegacyDir = path.join(tmp, 'src-home', '.claude');
  destAccountsRoot = path.join(tmp, 'dst-userData', 'claude-accounts');
  destLegacyDir = path.join(tmp, 'dst-home', '.claude');
  destProjects = path.join(tmp, 'dst-projects');
  fs.mkdirSync(path.join(destProjects, 'Bodhilander'), { recursive: true });

  source = freshDb();
  seedSourceDb(source, { accountConfigDir: sourceConfigDir, workingDirs: [SOURCE_DIR] });
  destination = freshDb();
});

afterEach(() => {
  source.close();
  destination.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function exportBytes(): Buffer {
  return buildTransferBundle(source as never, {
    sourceAppVersion: '3.5.1',
    sourcePlatform: 'darwin',
    sourceUserData: path.join(tmp, 'src-userData'),
    legacyConfigDir: sourceLegacyDir,
  }).bytes;
}

function restore(bytes: Buffer, mappings: { from: string; to: string }[] = []) {
  return restoreTransferBundle(destination as never, bytes, {
    accountsRoot: destAccountsRoot,
    legacyConfigDir: destLegacyDir,
    stagingDir: path.join(tmp, 'staging'),
    mappings,
  });
}

const NO_MAPPING = [{ from: SOURCE_ROOT, to: '' }];

function mappedToDest() {
  return [{ from: SOURCE_ROOT, to: destProjects }];
}

describe('what comes back', () => {
  test('restores every portable table', async () => {
    const outcome = await restore(exportBytes(), mappedToDest());

    expect(outcome.groups).toBe(1);
    expect(outcome.sessions).toBe(1);
    expect(outcome.sessionEvents).toBe(1);
    expect(outcome.chatEvents).toBe(1);
    expect(outcome.arenaRuns).toBe(1);
    expect(outcome.arenaResponses).toBe(1);
    expect(outcome.accounts).toBe(1);

    const counts = (table: string) =>
      (destination.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(counts('groups')).toBe(1);
    expect(counts('sessions')).toBe(1);
    expect(counts('session_events')).toBe(1);
    expect(counts('chat_events')).toBe(1);
    expect(counts('arena_runs')).toBe(1);
    expect(counts('arena_responses')).toBe(1);
    expect(counts('claude_accounts')).toBe(1);
  });

  test('restores the portable preferences and leaves the excluded ones out', async () => {
    seedSecrets(source);
    await restore(exportBytes(), mappedToDest());

    const keys = (destination.prepare('SELECT key FROM preferences').all() as { key: string }[]).map((r) => r.key);
    expect(keys).toContain('fontSize');
    expect(keys).not.toContain('teamsTokens');
    expect(keys).not.toContain('windowBounds');
  });

  test('keeps the session bound to its restored account', async () => {
    await restore(exportBytes(), mappedToDest());
    const row = destination.prepare('SELECT claude_account_id FROM sessions WHERE id = ?').get('s1') as any;
    expect(row.claude_account_id).toBe('acct-1');
  });
});

describe('account config dirs', () => {
  test('are rebuilt under this machine, never the source machine', async () => {
    await restore(exportBytes(), mappedToDest());
    const row = destination.prepare('SELECT config_dir FROM claude_accounts WHERE id = ?').get('acct-1') as any;

    expect(row.config_dir).toBe(path.join(destAccountsRoot, 'acct-1', '.claude'));
    expect(row.config_dir).not.toContain('src-userData');
  });

  test('the restored account is made default when this machine has none', async () => {
    await restore(exportBytes(), mappedToDest());
    const row = destination.prepare('SELECT is_default FROM claude_accounts WHERE id = ?').get('acct-1') as any;
    expect(row.is_default).toBe(1);
  });

  test('an existing default on this machine is not displaced', async () => {
    destination.prepare(
      `INSERT INTO claude_accounts (id, label, config_dir, is_default, created_at)
       VALUES ('local', 'Mine', '/dst/local/.claude', 1, '2026-01-01T00:00:00.000Z')`,
    ).run();
    await restore(exportBytes(), mappedToDest());

    const rows = destination.prepare('SELECT id, is_default FROM claude_accounts ORDER BY id').all() as any[];
    expect(rows).toEqual([
      { id: 'acct-1', is_default: 0 },
      { id: 'local', is_default: 1 },
    ]);
  });
});

describe('working directories', () => {
  test('are rewritten through the mapping the user supplied', async () => {
    await restore(exportBytes(), mappedToDest());

    const session = destination.prepare('SELECT working_dir, state FROM sessions WHERE id = ?').get('s1') as any;
    expect(session.working_dir).toBe(path.join(destProjects, 'Bodhilander'));
    expect(session.state).toBe('stopped');

    const group = destination.prepare('SELECT working_dir FROM groups WHERE id = ?').get('g1') as any;
    expect(group.working_dir).toBe(path.join(destProjects, 'Bodhilander'));
  });

  test('an unmapped root leaves the path alone and parks the session', async () => {
    const outcome = await restore(exportBytes(), NO_MAPPING);

    const session = destination.prepare('SELECT working_dir, state FROM sessions WHERE id = ?').get('s1') as any;
    expect(session.working_dir).toBe(SOURCE_DIR);
    expect(fs.existsSync(session.working_dir)).toBe(false);
    expect(outcome.needsRelink).toEqual(['s1']);
  });

  test('a mapping onto a folder that does not exist also parks the session', async () => {
    const outcome = await restore(exportBytes(), [{ from: SOURCE_ROOT, to: path.join(tmp, 'nowhere') }]);

    const session = destination.prepare('SELECT working_dir, state FROM sessions WHERE id = ?').get('s1') as any;
    expect(session.working_dir).toBe(path.join(tmp, 'nowhere', 'Bodhilander'));
    expect(fs.existsSync(session.working_dir)).toBe(false);
    expect(outcome.needsRelink).toEqual(['s1']);
  });

  test('a restored session lands stopped, never in a state that spawns on its own', async () => {
    await restore(exportBytes(), mappedToDest());
    const row = destination.prepare('SELECT state FROM sessions WHERE id = ?').get('s1') as any;
    expect(row.state).toBe('stopped');
  });

  test('being parked is derived from the directory, not written into state', async () => {
    const outcome = await restore(exportBytes(), NO_MAPPING);

    // Deliberately identical to the reachable case: nothing distinguishes the
    // two in the row, because a bulk state reset would erase the difference.
    const row = destination.prepare('SELECT state FROM sessions WHERE id = ?').get('s1') as any;
    expect(row.state).toBe('stopped');
    expect(outcome.needsRelink).toEqual(['s1']);
  });
});

describe('the manifest an import shows before it runs', () => {
  test('names every root the user has to answer for', async () => {
    const manifest = readBundleManifest(exportBytes()) as TransferManifest;
    expect(manifest.workingDirRoots).toEqual([SOURCE_DIR]);
    expect(manifest.sourcePlatform).toBe('darwin');
  });

  test('is null for a v1 file, which carries no manifest', async () => {
    const v1 = Buffer.from(JSON.stringify({ version: 1, sourceApp: 'bodhilander', exportedAt: 'x', groups: [], sessions: [] }));
    expect(readBundleManifest(v1)).toBeNull();
  });
});

describe('transactional', () => {
  test('a failure part-way leaves the existing database untouched', async () => {
    const tables = {
      version: BUNDLE_FORMAT_VERSION,
      sourceApp: 'bodhilander',
      exportedAt: '2026-08-25T00:00:00.000Z',
      groups: [{ id: 'g1', name: 'Repos', color: '#fff', workingDir: destProjects, parentId: null, collapsed: false, order: 0, createdAt: '2026-01-01T00:00:00.000Z' }],
      sessions: [{ id: 's1', groupId: 'g1', name: 'S', workingDir: destProjects, shellType: 'claude', claudeSessionId: null, order: 0, createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z' }],
      sessionEvents: [],
      chatEvents: [],
      arenaRuns: [],
      // No matching run, so the foreign key fires after the rows above landed.
      arenaResponses: [{ id: 'r1', runId: 'missing-run', provider: 'claude', status: 'done', responseText: '', ttftMs: null, totalMs: null, inputTokens: null, outputTokens: null, costUsd: null, error: null, round: 0, prompt: null, sessionRef: null }],
      preferences: [{ key: 'fontSize', value: '14' }],
      accounts: [],
    };
    const manifest: TransferManifest = {
      formatVersion: BUNDLE_FORMAT_VERSION,
      sourceApp: 'bodhilander',
      sourceAppVersion: '3.5.1',
      sourcePlatform: 'darwin',
      sourceUserData: '/src',
      exportedAt: '2026-08-25T00:00:00.000Z',
      workingDirRoots: [destProjects],
      counts: { groups: 1, sessions: 1, sessionEvents: 0, chatEvents: 0, arenaRuns: 0, arenaResponses: 1, preferences: 1, accounts: 0, transcripts: 0 },
    };
    const bytes = encodeBundle(manifest, [{ name: TABLES_ENTRY, data: Buffer.from(JSON.stringify(tables)) }]);

    destination.prepare(
      `INSERT INTO groups (id, name, color, working_dir, "order", created_at) VALUES ('mine', 'Mine', '#000', '/x', 0, '2026-01-01T00:00:00.000Z')`,
    ).run();

    await expect(restore(bytes)).rejects.toThrow();

    const groups = destination.prepare('SELECT id FROM groups').all() as { id: string }[];
    expect(groups).toEqual([{ id: 'mine' }]);
    expect((destination.prepare('SELECT COUNT(*) AS n FROM sessions').get() as any).n).toBe(0);
    expect((destination.prepare('SELECT COUNT(*) AS n FROM preferences').get() as any).n).toBe(0);
  });
});

describe('older files', () => {
  test('a v1 portable JSON still imports', async () => {
    const v1 = Buffer.from(
      JSON.stringify({
        version: 1,
        sourceApp: 'bodhilander',
        exportedAt: '2026-01-01T00:00:00.000Z',
        groups: [{ id: 'gv1', name: 'Old', color: '#888', workingDir: destProjects, parentId: null, collapsed: false, order: 0, createdAt: '2026-01-01T00:00:00.000Z' }],
        sessions: [{ id: 'sv1', groupId: 'gv1', name: 'Old session', workingDir: destProjects, shellType: 'claude', claudeSessionId: 'conv-old', order: 0, createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z' }],
      }),
      'utf-8',
    );

    const outcome = await restore(v1);
    expect(outcome.manifest).toBeNull();
    expect(outcome.groups).toBe(1);
    expect(outcome.sessions).toBe(1);

    const row = destination.prepare('SELECT claude_session_id, provider FROM sessions WHERE id = ?').get('sv1') as any;
    expect(row.claude_session_id).toBe('conv-old');
    expect(row.provider).toBe('claude');
  });

  test('an unknown provider in a v1 file is defaulted rather than stored', async () => {
    const v1 = Buffer.from(
      JSON.stringify({
        version: 1,
        sourceApp: 'other',
        exportedAt: '2026-01-01T00:00:00.000Z',
        groups: [{ id: 'g', name: 'g', color: '#888', workingDir: destProjects, parentId: null, collapsed: false, order: 0, createdAt: '2026-01-01T00:00:00.000Z' }],
        sessions: [{ id: 's', groupId: 'g', name: 's', workingDir: destProjects, shellType: 'claude', claudeSessionId: null, order: 0, createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z', provider: 'not-a-provider' }],
      }),
      'utf-8',
    );

    await restore(v1);
    expect((destination.prepare('SELECT provider FROM sessions WHERE id = ?').get('s') as any).provider).toBe('claude');
  });

  test('a file that is neither is refused with a readable message', async () => {
    await expect(restore(Buffer.from('not json at all'))).rejects.toThrow(/not a Bodhilander transfer bundle/i);
  });
});

describe('idempotence', () => {
  test('a settings change made after the first import survives the second', async () => {
    seedSecrets(source);
    const bytes = exportBytes();
    await restore(bytes, mappedToDest());
    destination.prepare("UPDATE preferences SET value = '18' WHERE key = 'fontSize'").run();

    await restore(bytes, mappedToDest());

    const row = destination.prepare('SELECT value FROM preferences WHERE key = ?').get('fontSize') as any;
    expect(row.value).toBe('18');
  });

  test('re-importing the same bundle duplicates nothing', async () => {
    const bytes = exportBytes();
    await restore(bytes, mappedToDest());
    const second = await restore(bytes, mappedToDest());

    const counts = (table: string) =>
      (destination.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(counts('groups')).toBe(1);
    expect(counts('sessions')).toBe(1);
    expect(counts('session_events')).toBe(1);
    expect(counts('chat_events')).toBe(1);
    expect(counts('arena_responses')).toBe(1);
    expect(counts('claude_accounts')).toBe(1);
    expect(second.skippedGroups).toBe(1);
    expect(second.skippedSessions).toBe(1);
  });

  test('a second import does not undo a relink the user already did', async () => {
    const bytes = exportBytes();
    await restore(bytes, NO_MAPPING);
    destination.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(destProjects, 's1');

    await restore(bytes, NO_MAPPING);
    const row = destination.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('s1') as any;
    expect(row.working_dir).toBe(destProjects);
  });
});

describe('transcripts', () => {
  test('land under the rewritten config dir', async () => {
    writeTranscript(sourceConfigDir, '-Users-will-Work-Repos-Bodhilander', 'conv-1', '{"type":"user"}\n');
    const outcome = await restore(exportBytes(), mappedToDest());

    const landed = path.join(destAccountsRoot, 'acct-1', '.claude', 'projects', '-Users-will-Work-Repos-Bodhilander', 'conv-1.jsonl');
    expect(fs.existsSync(landed)).toBe(true);
    expect(fs.readFileSync(landed, 'utf-8')).toBe('{"type":"user"}\n');
    expect(outcome.transcripts).toBe(1);
  });

  test('the legacy tree lands in this machine\'s legacy dir', async () => {
    writeTranscript(sourceLegacyDir, '-Users-will-old', 'conv-legacy', '{"type":"user"}\n');
    await restore(exportBytes(), mappedToDest());

    expect(fs.existsSync(path.join(destLegacyDir, 'projects', '-Users-will-old', 'conv-legacy.jsonl'))).toBe(true);
  });

  test('an account dir that already holds history is added to, not replaced', async () => {
    writeTranscript(sourceConfigDir, '-Users-will-Work-Repos-Bodhilander', 'conv-1', '{"type":"user"}\n');
    const destConfig = path.join(destAccountsRoot, 'acct-1', '.claude');
    writeTranscript(destConfig, '-existing', 'already-here', '{"type":"user"}\n');

    await restore(exportBytes(), mappedToDest());

    expect(fs.existsSync(path.join(destConfig, 'projects', '-existing', 'already-here.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(destConfig, 'projects', '-Users-will-Work-Repos-Bodhilander', 'conv-1.jsonl'))).toBe(true);
  });

  test('an entry naming a path outside its account is refused', async () => {
    const bytes = exportBytes();
    const escape = `${TRANSCRIPT_PREFIX}acct-1/../../../evil/conv-x.jsonl`;
    const tables = { version: BUNDLE_FORMAT_VERSION, sourceApp: 'bodhilander', exportedAt: 'x', groups: [], sessions: [], sessionEvents: [], chatEvents: [], arenaRuns: [], arenaResponses: [], preferences: [], accounts: [] };
    const manifest = readBundleManifest(bytes) as TransferManifest;
    const hostile = encodeBundle(manifest, [
      { name: TABLES_ENTRY, data: Buffer.from(JSON.stringify(tables)) },
      { name: escape, data: Buffer.from('{"type":"user"}\n') },
    ]);

    await restore(hostile, mappedToDest());
    expect(fs.existsSync(path.join(tmp, 'evil'))).toBe(false);
  });

  test('an account id shaped like a traversal is refused, and nothing is written', async () => {
    const bytes = exportBytes();
    const manifest = readBundleManifest(bytes) as TransferManifest;
    const tables = {
      version: BUNDLE_FORMAT_VERSION, sourceApp: 'bodhilander', exportedAt: 'x',
      groups: [], sessions: [], sessionEvents: [], chatEvents: [], arenaRuns: [], arenaResponses: [],
      preferences: [],
      // Where this lands without the guard: `<accountsRoot>/../../evil/.claude`,
      // and registerRestoredAccountHooks then writes settings.json into it —
      // the file that wires up hook execution for the real Claude Code CLI.
      accounts: [{ id: '../../evil', label: 'Hostile', email: null, color: '#888888', createdAt: 'x', lastUsedAt: null }],
    };
    const hostile = encodeBundle(manifest, [
      { name: TABLES_ENTRY, data: Buffer.from(JSON.stringify(tables)) },
    ]);

    await expect(restore(hostile, mappedToDest())).rejects.toThrow(/unusable account id/);

    expect(fs.existsSync(path.join(path.dirname(path.dirname(destAccountsRoot)), 'evil'))).toBe(false);
    expect((destination.prepare('SELECT COUNT(*) AS n FROM claude_accounts').get() as any).n).toBe(0);
  });

  test('a separator in an account id is refused too', async () => {
    const bytes = exportBytes();
    const manifest = readBundleManifest(bytes) as TransferManifest;
    for (const id of ['a/b', 'a\\b', '..', '.hidden', '']) {
      const tables = {
        version: BUNDLE_FORMAT_VERSION, sourceApp: 'bodhilander', exportedAt: 'x',
        groups: [], sessions: [], sessionEvents: [], chatEvents: [], arenaRuns: [], arenaResponses: [],
        preferences: [],
        accounts: [{ id, label: 'Hostile', email: null, color: '#888888', createdAt: 'x', lastUsedAt: null }],
      };
      const hostile = encodeBundle(manifest, [
        { name: TABLES_ENTRY, data: Buffer.from(JSON.stringify(tables)) },
      ]);
      await expect(restore(hostile, mappedToDest())).rejects.toThrow(/unusable account id/);
    }
  });

  test('the uuid the app actually mints is still accepted', async () => {
    const bytes = exportBytes();
    const manifest = readBundleManifest(bytes) as TransferManifest;
    const id = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    const tables = {
      version: BUNDLE_FORMAT_VERSION, sourceApp: 'bodhilander', exportedAt: 'x',
      groups: [], sessions: [], sessionEvents: [], chatEvents: [], arenaRuns: [], arenaResponses: [],
      preferences: [],
      accounts: [{ id, label: 'Real', email: null, color: '#888888', createdAt: 'x', lastUsedAt: null }],
    };
    const benign = encodeBundle(manifest, [
      { name: TABLES_ENTRY, data: Buffer.from(JSON.stringify(tables)) },
    ]);

    await restore(benign, mappedToDest());

    const row = destination.prepare('SELECT config_dir FROM claude_accounts WHERE id = ?').get(id) as any;
    expect(row.config_dir).toBe(path.join(destAccountsRoot, id, '.claude'));
  });

  test('the staging area does not survive the import', async () => {
    writeTranscript(sourceConfigDir, '-slug', 'conv-1', '{"type":"user"}\n');
    await restore(exportBytes(), mappedToDest());
    expect(fs.existsSync(path.join(tmp, 'staging'))).toBe(false);
  });

  test('the legacy key never lands anywhere but the legacy dir', async () => {
    writeTranscript(sourceLegacyDir, '-slug', 'conv-legacy', '{"type":"user"}\n');
    await restore(exportBytes(), mappedToDest());
    expect(fs.existsSync(path.join(destAccountsRoot, LEGACY_ACCOUNT_KEY))).toBe(false);
  });
});
