/**
 * The Electron half of a handoff: the questions it asks, and what it reports
 * back to the window. The answers a person sees are the whole product here —
 * "cancelled" and "that did not open" must not arrive as the same failure.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { freshDb, seedSourceDb } from '../transfer/__tests__/db-fixture';
import { buildTransferBundle } from '../transfer/bundle-export';
import { sealHandoff } from '../transfer/handoff-crypto';
import { generateRecoveryPhrase } from '../transfer/recovery-phrase';
import type { HandoffOffer } from '../../shared/types';
import type { HandoffTransport } from '../transfer/handoff';

let db: Database;
let tmp: string;
let userDataDir: string;
let legacyDir: string;
let messageBoxResponses: number[] = [];
let openDialogPaths: (string | null)[] = [];

// Superset of the `{ app }` stub the sibling suites register, plus the dialogs
// this module drives. Nothing here is exercised for real.
mock.module('electron', () => ({
  app: {
    getVersion: () => '3.5.1',
    getPath: (name: string) => (name === 'documents' ? path.join(tmp, 'docs') : userDataDir),
    getAppPath: () => path.join(tmp, 'app'),
  },
  dialog: {
    showMessageBox: async () => ({ response: messageBoxResponses.shift() ?? 0 }),
    showOpenDialog: async () => {
      const next = openDialogPaths.shift();
      return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
    },
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  },
}));
mock.module('../database', () => ({ getDatabase: () => db }));

const { declineMachineHandoff, prepareMachineHandoff, readHandoffOffer, restoreMachineHandoff } = await import(
  '../machine-handoff'
);

const SOURCE_ROOT = '/src-machine/Work/Repos';

function offerFor(sealed: Buffer): HandoffOffer {
  return {
    id: 'handoff-1',
    sourceMachineId: 'machine-old',
    sourceMachineName: 'Old Laptop',
    byteSize: sealed.length,
    createdAt: 1756080000000,
    expiresAt: 1756684800000,
  };
}

/** A relay holding one prepared bundle, and a record of what was asked of it. */
function standIn(sealed: Buffer | null) {
  const acks: string[] = [];
  const transport: HandoffTransport = {
    async upload(bytes) {
      sealed = bytes;
      return offerFor(bytes);
    },
    async peek() {
      return sealed ? offerFor(sealed) : null;
    },
    async download() {
      if (!sealed) throw new Error('nothing waiting');
      return { id: 'handoff-1', sealed };
    },
    async acknowledge(id) {
      acks.push(id);
      sealed = null;
    },
  };
  return { transport, acks, stored: () => sealed };
}

/** A bundle a source machine prepared, sealed as the relay would hold it. */
function preparedElsewhere() {
  const source = freshDb();
  seedSourceDb(source, {
    accountConfigDir: path.join(tmp, 'src', 'acct-1', '.claude'),
    workingDirs: [`${SOURCE_ROOT}/Bodhilander`],
  });
  const { bytes } = buildTransferBundle(source as never, {
    sourceAppVersion: '3.5.1',
    sourcePlatform: 'darwin',
    sourceUserData: path.join(tmp, 'src'),
    legacyConfigDir: path.join(tmp, 'src-home', '.claude'),
  });
  source.close();
  return sealHandoff(bytes);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bodhi-driver-'));
  userDataDir = path.join(tmp, 'userData');
  legacyDir = path.join(tmp, 'home', '.claude');
  messageBoxResponses = [];
  openDialogPaths = [];
  db = freshDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('before this machine is linked', () => {
  test('every step says so rather than failing obscurely', async () => {
    expect(await prepareMachineHandoff(null, legacyDir)).toEqual({
      success: false,
      error: 'Link this machine to a relay account before moving it.',
    });
    expect(await restoreMachineHandoff(null, 'anything', legacyDir)).toEqual({
      success: false,
      error: 'Link this machine to a relay account before moving it.',
    });
    expect(await readHandoffOffer(null)).toEqual({ offer: null, declined: false });
  });
});

describe('preparing one', () => {
  test('reports the phrase and what the bundle holds once it is confirmed', async () => {
    seedSourceDb(db, { accountConfigDir: path.join(tmp, 'acct', '.claude') });
    const relay = standIn(null);
    messageBoxResponses = [0];

    const result = await prepareMachineHandoff(relay.transport, legacyDir);
    expect(result.success).toBe(true);
    expect(result.phrase!.split(' ')).toHaveLength(18);
    expect(result.groupCount).toBe(1);
    expect(result.sizeLabel).toMatch(/\d/);
    expect(relay.stored()).not.toBeNull();
  });

  test('uploads nothing when the confirmation is declined', async () => {
    seedSourceDb(db, { accountConfigDir: path.join(tmp, 'acct', '.claude') });
    const relay = standIn(null);
    messageBoxResponses = [1];

    expect(await prepareMachineHandoff(relay.transport, legacyDir)).toEqual({
      success: false,
      error: 'Handoff cancelled',
    });
    expect(relay.stored()).toBeNull();
  });
});

describe('reading the offer', () => {
  test('names the source machine and sizes it for the prompt', async () => {
    const relay = standIn(Buffer.alloc(4096, 1));
    const state = await readHandoffOffer(relay.transport);
    expect(state.offer!.sourceMachineName).toBe('Old Laptop');
    expect(state.sizeLabel).toBe('4.0 KB');
    expect(state.declined).toBe(false);
  });

  test('remembers a bundle this machine turned down', async () => {
    const relay = standIn(Buffer.alloc(64, 1));
    declineMachineHandoff('handoff-1');
    expect((await readHandoffOffer(relay.transport)).declined).toBe(true);
  });

  test('says nothing is waiting rather than interrupting a launch with a relay error', async () => {
    const unreachable: HandoffTransport = {
      upload: async () => {
        throw new Error('offline');
      },
      peek: async () => {
        throw new Error('offline');
      },
      download: async () => {
        throw new Error('offline');
      },
      acknowledge: async () => {
        throw new Error('offline');
      },
    };
    expect(await readHandoffOffer(unreachable)).toEqual({ offer: null, declined: false });
  });
});

describe('restoring one', () => {
  test('asks where each root lives now, then restores against the answer', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes);
    // One session means one root, so the folder chosen for it IS the new
    // working directory — which is what makes the answer visible below.
    const chosen = path.join(tmp, 'dst-projects', 'Bodhilander');
    fs.mkdirSync(chosen, { recursive: true });
    messageBoxResponses = [0];
    openDialogPaths = [chosen];

    const result = await restoreMachineHandoff(relay.transport, phrase, legacyDir);
    expect(result.success).toBe(true);
    expect(result.groupCount).toBe(1);
    expect(result.needsRelinkCount).toBe(0);
    const dir = (db.query('SELECT working_dir FROM sessions WHERE id = ?').get('s1') as { working_dir: string })
      .working_dir;
    expect(dir).toBe(chosen);
    expect(relay.acks).toEqual(['handoff-1']);
  });

  test('a wrong phrase is reported as one, and the bundle stays put', async () => {
    const { bytes } = preparedElsewhere();
    const relay = standIn(bytes);

    const result = await restoreMachineHandoff(relay.transport, generateRecoveryPhrase(), legacyDir);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not open this bundle/);
    expect(relay.acks).toEqual([]);
    expect(relay.stored()).not.toBeNull();
  });

  test('a mistyped phrase names the mistake instead of a decryption failure', async () => {
    const relay = standIn(preparedElsewhere().bytes);
    const result = await restoreMachineHandoff(relay.transport, 'agent album alloy', legacyDir);
    expect(result.error).toMatch(/18 words/);
    expect(relay.stored()).not.toBeNull();
  });

  test('abandoning the root question leaves everything as it was', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes);
    messageBoxResponses = [2];

    expect(await restoreMachineHandoff(relay.transport, phrase, legacyDir)).toEqual({
      success: false,
      error: 'Import cancelled',
    });
    expect(relay.acks).toEqual([]);
    expect(db.query('SELECT COUNT(*) AS n FROM groups').get()).toEqual({ n: 0 });
  });
});
