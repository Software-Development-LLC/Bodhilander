/**
 * The container and the preference exclusion policy — the export-side gate on
 * secrets, and a version check that runs before anything is decompressed.
 * Run with: bun test src/main/transfer
 */
import { describe, expect, test } from 'bun:test';
import {
  BUNDLE_FORMAT_VERSION,
  decodeBundle,
  encodeBundle,
  formatBytes,
  isPortablePreferenceKey,
  TABLES_ENTRY,
  type TransferManifest,
} from '../bundle-format';

function manifest(): TransferManifest {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    sourceApp: 'bodhilander',
    sourceAppVersion: '3.5.1',
    sourcePlatform: 'darwin',
    sourceUserData: '/Users/will/Library/Application Support/bodhilander',
    exportedAt: '2026-08-25T00:00:00.000Z',
    workingDirRoots: ['/Users/will/Work/Repos'],
    counts: {
      groups: 1,
      sessions: 2,
      sessionEvents: 3,
      chatEvents: 4,
      arenaRuns: 0,
      arenaResponses: 0,
      preferences: 5,
      accounts: 1,
      transcripts: 1,
    },
  };
}

describe('the container', () => {
  test('round-trips the manifest and every entry', () => {
    const entries = [
      { name: TABLES_ENTRY, data: Buffer.from('{"version":2}', 'utf-8') },
      { name: 'transcripts/acct/slug/uuid.jsonl', data: Buffer.from('{"role":"user"}\n', 'utf-8') },
    ];
    const bundle = decodeBundle(encodeBundle(manifest(), entries));

    expect(bundle.manifest).toEqual(manifest());
    expect(bundle.entryNames()).toEqual(entries.map((e) => e.name));
    expect(bundle.read(TABLES_ENTRY)?.toString('utf-8')).toBe('{"version":2}');
    expect(bundle.read('transcripts/acct/slug/uuid.jsonl')?.toString('utf-8')).toBe('{"role":"user"}\n');
  });

  test('an absent entry reads as null rather than throwing', () => {
    const bundle = decodeBundle(encodeBundle(manifest(), []));
    expect(bundle.read('transcripts/nope.jsonl')).toBeNull();
  });

  test('entry payloads are compressed', () => {
    const raw = Buffer.from('a'.repeat(64 * 1024), 'utf-8');
    const encoded = encodeBundle(manifest(), [{ name: 'transcripts/a/b/c.jsonl', data: raw }]);
    expect(encoded.length).toBeLessThan(raw.length / 4);
    expect(decodeBundle(encoded).read('transcripts/a/b/c.jsonl')).toEqual(raw);
  });

  test('a file that is not a bundle is refused', () => {
    expect(() => decodeBundle(Buffer.from('{"version":1}', 'utf-8'))).toThrow(/not a Bodhilander transfer bundle/i);
  });

  test('a newer format version is refused before anything is decompressed', () => {
    const encoded = encodeBundle({ ...manifest(), formatVersion: 99 as never }, []);
    expect(() => decodeBundle(encoded)).toThrow(/newer version/i);
  });

  test('a truncated archive is refused rather than read past its end', () => {
    const encoded = encodeBundle(manifest(), [{ name: TABLES_ENTRY, data: Buffer.from('x'.repeat(4096)) }]);
    expect(() => decodeBundle(encoded.subarray(0, encoded.length - 32))).toThrow(/truncated/i);
  });
});

describe('the preference exclusion policy', () => {
  test('keeps the ordinary settings a user would want back', () => {
    for (const key of ['theme', 'closeToTray', 'soundEnabled', 'betaChannel', 'apiPort']) {
      expect(isPortablePreferenceKey(key)).toBe(true);
    }
  });

  test('refuses every safeStorage-sealed key', () => {
    for (const key of [
      'providerApiKey.anthropic',
      'providerApiKeyUse.anthropic',
      'teamsTokens',
      'relay.ed25519Priv',
      'relay.x25519Priv',
    ]) {
      expect(isPortablePreferenceKey(key)).toBe(false);
    }
  });

  test('refuses the whole relay namespace, not just the private halves', () => {
    for (const key of ['relay.ed25519Pub', 'relay.machineId', 'relay.ownerUserId', 'relay.enabled']) {
      expect(isPortablePreferenceKey(key)).toBe(false);
    }
  });

  test('refuses the machine-local settings', () => {
    for (const key of [
      'windowBounds',
      'customShellPath',
      'preferredEditor',
      'soundWaitingCustomPath',
      'soundErrorCustomPath',
      'soundStartCustomPath',
      'soundCompleteCustomPath',
    ]) {
      expect(isPortablePreferenceKey(key)).toBe(false);
    }
  });
});

describe('an entry that expands far beyond its compressed size', () => {
  /** ~5 MB of zeros compresses to a few KB — the shape of a zip bomb. */
  function bomb(): Buffer {
    return encodeBundle(manifest(), [
      { name: TABLES_ENTRY, data: Buffer.alloc(5 * 1024 * 1024, 0) },
    ]);
  }

  test('is refused rather than decompressed, because import is untrusted input', () => {
    const bytes = bomb();
    // Compressed, it is small enough to look harmless in a file listing.
    expect(bytes.length).toBeLessThan(256 * 1024);

    const decoded = decodeBundle(bytes, { maxEntryBytes: 1024 * 1024 });
    expect(() => decoded.read(TABLES_ENTRY)).toThrow(/expands past the size/);
  });

  test('an entry under the ceiling still reads back whole', () => {
    const decoded = decodeBundle(bomb(), { maxEntryBytes: 8 * 1024 * 1024 });
    expect(decoded.read(TABLES_ENTRY)?.length).toBe(5 * 1024 * 1024);
  });

  test('the shipped ceiling passes anything this app writes', () => {
    const decoded = decodeBundle(bomb());
    expect(decoded.read(TABLES_ENTRY)?.length).toBe(5 * 1024 * 1024);
  });
});

describe('formatBytes', () => {
  test('reports a size a person can read', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});
