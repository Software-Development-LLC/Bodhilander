/**
 * What the exporter puts in the archive, and what it does not. The exclusion
 * assertions read the PRODUCED bytes: a filter that is correct and unwired
 * looks identical from the inside. Run with: bun test src/main/transfer
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodeBundle, LEGACY_ACCOUNT_KEY, TABLES_ENTRY, TRANSCRIPT_PREFIX } from '../bundle-format';
import { buildTransferBundle } from '../bundle-export';
import { freshDb, SECRET_VALUES, seedSecrets, seedSourceDb, writeTranscript } from './db-fixture';

let db: Database;
let tmp: string;
let accountConfigDir: string;
let legacyConfigDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-export-'));
  accountConfigDir = path.join(tmp, 'userData', 'claude-accounts', 'acct-1', '.claude');
  legacyConfigDir = path.join(tmp, 'home', '.claude');
  db = freshDb();
  seedSourceDb(db, { accountConfigDir });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function build() {
  return buildTransferBundle(db as never, {
    sourceAppVersion: '3.5.1-beta.6',
    sourcePlatform: 'darwin',
    sourceUserData: path.join(tmp, 'userData'),
    legacyConfigDir,
  });
}

/** Every byte a reader can get at: the header plus every decompressed entry. */
function readableText(bytes: Buffer): string {
  const bundle = decodeBundle(bytes);
  const parts = bundle.entryNames().map((name) => bundle.read(name)!.toString('utf-8'));
  return [bytes.toString('utf-8'), JSON.stringify(bundle.manifest), ...parts].join('\n');
}

describe('the manifest', () => {
  test('records where and when the export came from', () => {
    const { manifest, bytes } = build();

    expect(manifest.formatVersion).toBe(2);
    expect(manifest.sourceApp).toBe('bodhilander');
    expect(manifest.sourceAppVersion).toBe('3.5.1-beta.6');
    expect(manifest.sourcePlatform).toBe('darwin');
    expect(manifest.sourceUserData).toBe(path.join(tmp, 'userData'));
    expect(Date.parse(manifest.exportedAt)).not.toBeNaN();
    expect(bytes.length).toBeGreaterThan(0);
  });

  test('surfaces the distinct working-directory roots across groups and sessions', () => {
    db.close();
    db = freshDb();
    seedSourceDb(db, {
      accountConfigDir: path.join(tmp, 'other'),
      workingDirs: ['/Users/will/Work/Repos/A', '/Users/will/Work/Repos/B', '/opt/scratch/C'],
    });

    expect(build().manifest.workingDirRoots).toEqual(['/Users/will/Work/Repos', '/opt/scratch/C']);
  });

  test('counts what travelled', () => {
    writeTranscript(accountConfigDir, '-Users-will-Work-Repos-Bodhilander', 'conv-1', '{"type":"user"}\n');
    const { manifest } = build();

    expect(manifest.counts).toMatchObject({
      groups: 1,
      sessions: 1,
      sessionEvents: 1,
      chatEvents: 1,
      arenaRuns: 1,
      arenaResponses: 1,
      accounts: 1,
      transcripts: 1,
    });
  });
});

describe('the tables entry', () => {
  test('carries every portable table', () => {
    const bundle = decodeBundle(build().bytes);
    const tables = JSON.parse(bundle.read(TABLES_ENTRY)!.toString('utf-8'));

    expect(tables.version).toBe(2);
    expect(tables.groups[0]).toMatchObject({ id: 'g1', name: 'Repos', workingDir: '/Users/will/Work/Repos/Bodhilander' });
    expect(tables.sessions[0]).toMatchObject({ id: 's1', claudeSessionId: 'conv-1', claudeAccountId: 'acct-1' });
    expect(tables.sessionEvents[0]).toMatchObject({ id: 'ev1', sessionId: 's1', eventType: 'session_start' });
    expect(tables.chatEvents[0]).toMatchObject({ id: 'ce1', sessionId: 's1', type: 'assistant_text' });
    expect(tables.arenaRuns[0]).toMatchObject({ id: 'run1' });
    expect(tables.arenaResponses[0]).toMatchObject({ id: 'resp1', runId: 'run1', round: 0 });
    expect(tables.accounts[0]).toMatchObject({ id: 'acct-1', label: 'Work', isDefault: true });
  });

  test('is shaped so the v1 fields are still exactly where v1 put them', () => {
    const bundle = decodeBundle(build().bytes);
    const tables = JSON.parse(bundle.read(TABLES_ENTRY)!.toString('utf-8'));

    expect(Object.keys(tables)).toEqual(expect.arrayContaining(['version', 'sourceApp', 'exportedAt', 'groups', 'sessions']));
    expect(tables.sourceApp).toBe('bodhilander');
  });

  test('never carries an account config_dir, which is a source-machine path', () => {
    const bundle = decodeBundle(build().bytes);
    const tables = JSON.parse(bundle.read(TABLES_ENTRY)!.toString('utf-8'));

    expect(tables.accounts[0]).not.toHaveProperty('configDir');
    expect(readableText(build().bytes)).not.toContain(accountConfigDir);
  });
});

describe('what must never reach the archive', () => {
  beforeEach(() => seedSecrets(db));

  test('no safeStorage-sealed value appears anywhere in the produced file', () => {
    const text = readableText(build().bytes);

    expect(text).not.toContain(SECRET_VALUES.providerApiKey);
    expect(text).not.toContain(SECRET_VALUES.teamsTokens);
    expect(text).not.toContain(SECRET_VALUES.relayPrivateKey);
    expect(text).not.toContain('providerApiKey.anthropic');
    expect(text).not.toContain('teamsTokens');
    expect(text).not.toContain('relay.ed25519Priv');
  });

  test('the relay namespace is absent in full, not only its private halves', () => {
    expect(readableText(build().bytes)).not.toContain('relay.machineId');
  });

  test('push subscriptions and the relay sharing tables are absent', () => {
    const text = readableText(build().bytes);

    expect(text).not.toContain(SECRET_VALUES.pushEndpoint);
    expect(text).not.toContain(SECRET_VALUES.grantCertificate);
    expect(text).not.toContain('push_subscriptions');
    expect(text).not.toContain('relay_grants');
  });

  test('machine-local preferences are absent', () => {
    const text = readableText(build().bytes);

    expect(text).not.toContain(SECRET_VALUES.windowBounds);
    expect(text).not.toContain(SECRET_VALUES.customShellPath);
    expect(text).not.toContain(SECRET_VALUES.preferredEditor);
    expect(text).not.toContain(SECRET_VALUES.soundPath);
  });

  test('the ordinary preferences still travel', () => {
    const bundle = decodeBundle(build().bytes);
    const tables = JSON.parse(bundle.read(TABLES_ENTRY)!.toString('utf-8'));
    const keys = tables.preferences.map((p: { key: string }) => p.key);

    expect(keys).toContain('theme');
    expect(keys).toContain('closeToTray');
    expect(keys).toHaveLength(2);
  });
});

describe('transcripts', () => {
  test('travel keyed by account id, not by absolute path', () => {
    writeTranscript(accountConfigDir, '-Users-will-Work-Repos-Bodhilander', 'conv-1', '{"type":"user"}\n');
    const bundle = decodeBundle(build().bytes);

    const name = `${TRANSCRIPT_PREFIX}acct-1/-Users-will-Work-Repos-Bodhilander/conv-1.jsonl`;
    expect(bundle.entryNames()).toContain(name);
    expect(bundle.read(name)!.toString('utf-8')).toBe('{"type":"user"}\n');
  });

  test('the pre-accounts legacy tree travels under its own key', () => {
    writeTranscript(legacyConfigDir, '-Users-will-old', 'conv-legacy', '{"type":"user"}\n');
    const bundle = decodeBundle(build().bytes);

    expect(bundle.entryNames()).toContain(`${TRANSCRIPT_PREFIX}${LEGACY_ACCOUNT_KEY}/-Users-will-old/conv-legacy.jsonl`);
  });

  test('files that are not transcripts stay behind', () => {
    fs.mkdirSync(path.join(accountConfigDir, 'projects', 'slug'), { recursive: true });
    fs.writeFileSync(path.join(accountConfigDir, '.credentials.json'), 'SEALED-CREDENTIALS', 'utf-8');
    fs.writeFileSync(path.join(accountConfigDir, 'projects', 'slug', 'notes.md'), 'SEALED-NOTES', 'utf-8');

    const text = readableText(build().bytes);
    expect(text).not.toContain('SEALED-CREDENTIALS');
    expect(text).not.toContain('SEALED-NOTES');
  });

  test('an account whose config dir is gone does not fail the export', () => {
    fs.rmSync(accountConfigDir, { recursive: true, force: true });
    expect(build().manifest.counts.transcripts).toBe(0);
  });
});
