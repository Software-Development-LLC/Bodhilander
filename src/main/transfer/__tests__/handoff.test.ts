/**
 * The whole trip, past a stand-in relay that only ever sees bytes: what it is
 * handed, that a restore drives the ordinary importer and its remapping, that
 * a failure leaves the bundle retryable, and that "not now" outlives a launch.
 */
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { freshDb, seedSecrets, seedSourceDb, SECRET_VALUES, writeTranscript } from './db-fixture';
import { decodeBundle, looksLikeBundle, TABLES_ENTRY } from '../bundle-format';
import { HANDOFF_SEAL_OVERHEAD_BYTES } from '../handoff-crypto';
import { openHandoff } from '../handoff-crypto';
import { generateRecoveryPhrase } from '../recovery-phrase';
import type { HandoffOffer } from '../../../shared/types';

// Same stub, same shape, as the sibling import suite: the provider registry
// reaches `app.getPath` on the way in, and nothing here runs a command.
mock.module('electron', () => ({ app: { getPath: () => '/nonexistent-bodhilander-test-userdata' } }));

const {
  applyHandoff,
  declineHandoff,
  DECLINED_HANDOFF_PREF,
  fetchHandoff,
  isHandoffDeclined,
  prepareHandoff,
} = await import('../handoff');

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
let prefsPath: string;

/**
 * A relay that holds one sealed blob per account. It is given bytes and an id
 * and knows nothing else — which is the whole point of it being this small.
 */
function standInRelay(options: { failAcknowledge?: boolean } = {}) {
  let slot: { id: string; sealed: Buffer } | null = null;
  let nextId = 1;
  const counts = { uploads: 0, downloads: 0, acks: 0 };

  const offer = (): HandoffOffer => ({
    id: slot!.id,
    sourceMachineId: 'machine-old',
    sourceMachineName: 'Old Laptop',
    byteSize: slot!.sealed.length,
    createdAt: 1756080000000,
    expiresAt: 1756080000000 + 604800000,
  });

  return {
    counts,
    stored: () => slot,
    transport: {
      async upload(sealed: Buffer) {
        counts.uploads++;
        slot = { id: `handoff-${nextId++}`, sealed };
        return offer();
      },
      async peek() {
        return slot ? offer() : null;
      },
      async download() {
        counts.downloads++;
        if (!slot) throw new Error('nothing waiting');
        return { id: slot.id, sealed: slot.sealed };
      },
      async acknowledge(handoffId: string) {
        counts.acks++;
        if (options.failAcknowledge) throw new Error('relay unreachable');
        if (slot?.id === handoffId) slot = null;
      },
    },
  };
}

function prefsStore(db: Database) {
  return {
    get: (key: string) =>
      (db.query('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | null)?.value ?? null,
    set: (key: string, value: string) =>
      void db
        .query('INSERT INTO preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value),
  };
}

function exportOptions() {
  return {
    sourceAppVersion: '3.5.1',
    sourcePlatform: 'darwin',
    sourceUserData: path.join(tmp, 'src-userData'),
    legacyConfigDir: sourceLegacyDir,
  };
}

function importOptions() {
  return {
    accountsRoot: destAccountsRoot,
    legacyConfigDir: destLegacyDir,
    stagingDir: fs.mkdtempSync(path.join(tmp, 'staging-')),
    mappings: [{ from: SOURCE_ROOT, to: destProjects }],
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-handoff-'));
  sourceConfigDir = path.join(tmp, 'src-userData', 'claude-accounts', 'acct-1', '.claude');
  sourceLegacyDir = path.join(tmp, 'src-home', '.claude');
  destAccountsRoot = path.join(tmp, 'dst-userData', 'claude-accounts');
  destLegacyDir = path.join(tmp, 'dst-home', '.claude');
  destProjects = path.join(tmp, 'dst-projects');
  prefsPath = path.join(tmp, 'prefs.db');
  fs.mkdirSync(path.join(destProjects, 'Bodhilander'), { recursive: true });

  source = freshDb();
  seedSourceDb(source, { accountConfigDir: sourceConfigDir, workingDirs: [SOURCE_DIR] });
  seedSecrets(source);
  writeTranscript(sourceConfigDir, '-src-machine-Work-Repos-Bodhilander', 'conv-1', '{"type":"user"}');
  destination = freshDb();
});

afterEach(() => {
  source.close();
  destination.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function prepare(relay: ReturnType<typeof standInRelay>) {
  const prepared = await prepareHandoff(source as never, {
    transport: relay.transport,
    maxBytes: 64 * 1024 * 1024,
    export: exportOptions(),
  });
  if (!prepared) throw new Error('the fixture never declines');
  return prepared;
}

describe('preparing a handoff', () => {
  test('hands the relay sealed bytes, not the bundle', async () => {
    const relay = standInRelay();
    await prepare(relay);
    const sealed = relay.stored()!.sealed;
    expect(looksLikeBundle(sealed)).toBe(false);
    expect(sealed.subarray(0, 8).toString('ascii')).toBe('BDHLHOFF');
  });

  test('carries no key material — not the relay identity, not an API key', async () => {
    const relay = standInRelay();
    const { phrase } = await prepare(relay);
    // The bundle's TABLES entry specifically, decoded: a search of the gzipped
    // container would find nothing whatever had been put in it. Transcript
    // entries are a separate concern and are not scanned here.
    const tables = decodeBundle(openHandoff(relay.stored()!.sealed, phrase)).read(TABLES_ENTRY)!.toString('utf-8');

    for (const secret of Object.values(SECRET_VALUES)) {
      expect(tables.includes(secret)).toBe(false);
    }
    expect(tables.includes('relay.ed25519Priv')).toBe(false);
    expect(tables.includes('relay.machineId')).toBe(false);
    // A portable setting IS there, so the four assertions above are not vacuous.
    expect(tables.includes('closeToTray')).toBe(true);
  });

  test('replaces the previous bundle rather than adding to it', async () => {
    const relay = standInRelay();
    const first = await prepare(relay);
    const second = await prepare(relay);
    expect(relay.counts.uploads).toBe(2);
    expect(relay.stored()!.id).not.toBe(first.offer.id);
    expect(relay.stored()!.id).toBe(second.offer.id);
  });

  test('stops before uploading when the confirmation is declined', async () => {
    const relay = standInRelay();
    const result = await prepareHandoff(source as never, {
      transport: relay.transport,
      maxBytes: 64 * 1024 * 1024,
      confirm: async () => false,
      export: exportOptions(),
    });
    expect(result).toBeNull();
    expect(relay.counts.uploads).toBe(0);
    expect(relay.stored()).toBeNull();
  });

  test('counts what sealing adds, so a bundle that only just fits is refused', async () => {
    // The boundary here is 25 bytes wide, and an export stamps the time it ran
    // — so the clock is frozen to make successive builds byte-identical.
    setSystemTime(new Date('2026-08-26T00:00:00.000Z'));
    try {
      const relay = standInRelay();
      const { sealedBytes } = await prepare(relay);

      await expect(
        prepareHandoff(source as never, {
          transport: relay.transport,
          maxBytes: sealedBytes - 1,
          export: exportOptions(),
        }),
      ).rejects.toThrow(/relay carries up to/);

      const fits = await prepareHandoff(source as never, {
        transport: relay.transport,
        maxBytes: sealedBytes,
        export: exportOptions(),
      });
      expect(fits).not.toBeNull();
    } finally {
      setSystemTime();
    }
  });

  test('refuses a hopeless transcript volume from stat alone, before building', async () => {
    writeTranscript(sourceConfigDir, 'big-project', 'conv-big', 'x'.repeat(40_000));
    const relay = standInRelay();

    await expect(
      prepareHandoff(source as never, { transport: relay.transport, maxBytes: 512, export: exportOptions() }),
    ).rejects.toThrow(/transcripts alone are/);
    expect(relay.counts.uploads).toBe(0);
  });

  test('refuses a state larger than the relay will carry, before uploading', async () => {
    const relay = standInRelay();
    await expect(
      prepareHandoff(source as never, { transport: relay.transport, maxBytes: 16, export: exportOptions() }),
    ).rejects.toThrow(/state is \d+.*relay carries up to .*Export it to a file instead/);
    expect(relay.counts.uploads).toBe(0);
  });
});

describe('restoring on the new machine', () => {
  test('drives the ordinary importer, remapping included', async () => {
    const relay = standInRelay();
    const { phrase } = await prepare(relay);

    const opened = await fetchHandoff(relay.transport, phrase);
    const { outcome } = await applyHandoff(destination as never, opened, {
      transport: relay.transport,
      import: importOptions(),
    });

    expect(outcome.groups).toBe(1);
    expect(outcome.sessions).toBe(1);
    expect(outcome.transcripts).toBeGreaterThan(0);
    const dir = (destination.query('SELECT working_dir FROM sessions WHERE id = ?').get('s1') as { working_dir: string })
      .working_dir;
    expect(dir).toBe(path.join(destProjects, 'Bodhilander'));
    expect(outcome.needsRelink).toEqual([]);
  });

  test('releases the bundle only once the import has returned', async () => {
    const relay = standInRelay();
    const { phrase } = await prepare(relay);
    const opened = await fetchHandoff(relay.transport, phrase);
    expect(relay.stored()).not.toBeNull();

    const { acknowledged } = await applyHandoff(destination as never, opened, {
      transport: relay.transport,
      import: importOptions(),
    });
    expect(acknowledged).toBe(true);
    expect(relay.counts.acks).toBe(1);
    expect(relay.stored()).toBeNull();
  });

  test('reports the restore that happened even when the relay will not release the bundle', async () => {
    const relay = standInRelay({ failAcknowledge: true });
    const { phrase } = await prepare(relay);
    const opened = await fetchHandoff(relay.transport, phrase);

    const { outcome, acknowledged } = await applyHandoff(destination as never, opened, {
      transport: relay.transport,
      import: importOptions(),
    });

    // The import happened. A relay that will not take the acknowledgement
    // cannot turn that into a failed restore.
    expect(outcome.groups).toBe(1);
    expect(outcome.sessions).toBe(1);
    expect(acknowledged).toBe(false);
    expect(destination.query('SELECT COUNT(*) AS n FROM groups').get()).toEqual({ n: 1 });
  });

  test('leaves the bundle alone when the import throws', async () => {
    const relay = standInRelay();
    const { phrase } = await prepare(relay);
    const opened = await fetchHandoff(relay.transport, phrase);

    // A database that cannot be written to is the shortest way to a restore
    // that gets nowhere; what matters is that the bundle survives it.
    destination.close();
    await expect(
      applyHandoff(destination as never, opened, { transport: relay.transport, import: importOptions() }),
    ).rejects.toThrow();
    expect(relay.counts.acks).toBe(0);
    expect(relay.stored()).not.toBeNull();
    destination = freshDb();
  });
});

describe('a phrase that does not open it', () => {
  test('a mistyped phrase never reaches the relay at all', async () => {
    const relay = standInRelay();
    await prepare(relay);
    await expect(fetchHandoff(relay.transport, 'agent album alloy')).rejects.toThrow(/18 words/);
    expect(relay.counts.downloads).toBe(0);
    expect(relay.stored()).not.toBeNull();
  });

  test('a well-formed phrase for another bundle leaves this one intact', async () => {
    const relay = standInRelay();
    await prepare(relay);
    const before = Buffer.from(relay.stored()!.sealed);

    await expect(fetchHandoff(relay.transport, generateRecoveryPhrase())).rejects.toThrow(/does not open this bundle/);
    expect(relay.counts.acks).toBe(0);
    expect(relay.stored()!.sealed.equals(before)).toBe(true);
  });

  test('and the right phrase still works afterwards', async () => {
    const relay = standInRelay();
    const { phrase } = await prepare(relay);
    await expect(fetchHandoff(relay.transport, generateRecoveryPhrase())).rejects.toThrow();

    const opened = await fetchHandoff(relay.transport, phrase);
    const { outcome } = await applyHandoff(destination as never, opened, {
      transport: relay.transport,
      import: importOptions(),
    });
    expect(outcome.sessions).toBe(1);
  });
});

describe('declining an offer', () => {
  test('is remembered across a relaunch', () => {
    let db = new Database(prefsPath);
    db.exec('CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT)');
    declineHandoff(prefsStore(db), 'handoff-1');
    expect(isHandoffDeclined(prefsStore(db), 'handoff-1')).toBe(true);
    db.close();

    // Same file, new process would see this: the marker is on disk, not in memory.
    db = new Database(prefsPath);
    expect(isHandoffDeclined(prefsStore(db), 'handoff-1')).toBe(true);
    db.close();
  });

  test('does not silence a later bundle from the same machine', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT)');
    const prefs = prefsStore(db);
    const relay = standInRelay();

    const first = await prepare(relay);
    declineHandoff(prefs, first.offer.id);
    expect(isHandoffDeclined(prefs, first.offer.id)).toBe(true);

    const second = await prepare(relay);
    expect(isHandoffDeclined(prefs, second.offer.id)).toBe(false);
    db.close();
  });

  test('is kept where an export will not carry it to the next machine', () => {
    expect(DECLINED_HANDOFF_PREF.startsWith('relay.')).toBe(true);
  });
});
