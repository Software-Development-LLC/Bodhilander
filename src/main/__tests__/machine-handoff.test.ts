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

/**
 * No proposal for any root, which is what the machine says when it cannot
 * find one. The real suggester walks the home directory of whoever is running
 * the suite, so a test that let it run would ask a different question
 * depending on the machine.
 */
const noSuggestions = () => [];

const { dismissArrival, readArrival, resolveRelink } = await import('../arrival');

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
function standIn(sealed: Buffer | null, options: { failAcknowledge?: boolean } = {}) {
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
      if (options.failAcknowledge) throw new Error('relay unreachable');
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
    declineMachineHandoff(relay.transport, 'handoff-1');
    expect((await readHandoffOffer(relay.transport)).declined).toBe(true);
  });

  test('will not bury a bundle on behalf of a machine that has been unlinked', async () => {
    const relay = standIn(Buffer.alloc(64, 1));
    // The dialog was drawn, then the machine was unlinked underneath it. That
    // offer is stale, and recording it would lose a bundle that is still real.
    declineMachineHandoff(null, 'handoff-1');
    expect((await readHandoffOffer(relay.transport)).declined).toBe(false);
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

    const result = await restoreMachineHandoff(relay.transport, phrase, legacyDir, noSuggestions);
    expect(result.success).toBe(true);
    expect(result.groupCount).toBe(1);
    expect(result.needsRelinkCount).toBe(0);
    const dir = (db.query('SELECT working_dir FROM sessions WHERE id = ?').get('s1') as { working_dir: string })
      .working_dir;
    expect(dir).toBe(chosen);
    expect(relay.acks).toEqual(['handoff-1']);
  });

  test('a relay that will not release the bundle is still a successful restore', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes, { failAcknowledge: true });
    const chosen = path.join(tmp, 'dst-projects');
    fs.mkdirSync(chosen, { recursive: true });
    messageBoxResponses = [0];
    openDialogPaths = [chosen];

    const result = await restoreMachineHandoff(relay.transport, phrase, legacyDir, noSuggestions);
    expect(result.success).toBe(true);
    expect(result.groupCount).toBe(1);
    // Answered locally, or the bundle it could not drop would be offered again
    // on the next launch as though nothing had been restored.
    expect((await readHandoffOffer(relay.transport)).declined).toBe(true);
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

  test('offers what this machine found, and takes it on one confirmation', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes);
    // One session means `collectWorkingDirRoots` descends to it, so the root
    // in the manifest is the session's own directory — and the folder proposed
    // for it IS the new working directory.
    const here = path.join(tmp, 'dst', 'Work', 'Repos', 'Bodhilander');
    fs.mkdirSync(here, { recursive: true });

    // The four-button prompt a proposal raises; 0 is "Use This Folder". No
    // showOpenDialog answer is queued, so a restore that reached the folder
    // picker would come back with the root unmapped and fail the assertion.
    messageBoxResponses = [0];
    const result = await restoreMachineHandoff(relay.transport, phrase, legacyDir, (roots) =>
      roots.map((from) => ({ from, to: here, matchedSegments: 2, unchanged: false })),
    );

    expect(result.success).toBe(true);
    const dir = (db.query('SELECT working_dir FROM sessions WHERE id = ?').get('s1') as { working_dir: string })
      .working_dir;
    expect(dir).toBe(here);
  });

  test('does not ask about a root that is already here', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes);

    // Nothing queued: a prompt raised here would take the `?? 0` default and
    // then reach a folder picker with no answer, so this fails loudly if the
    // unchanged root is asked about rather than skipped.
    messageBoxResponses = [];
    const asked: string[] = [];
    const result = await restoreMachineHandoff(relay.transport, phrase, legacyDir, (roots) => {
      asked.push(...roots);
      return roots.map((from) => ({ from, to: from, matchedSegments: 3, unchanged: true }));
    });

    expect(result.success).toBe(true);
    expect(asked).toEqual([`${SOURCE_ROOT}/Bodhilander`]);
    // Left exactly as the source wrote it, which is the right answer when the
    // tree is at the same path on both machines.
    const dir = (db.query('SELECT working_dir FROM sessions WHERE id = ?').get('s1') as { working_dir: string })
      .working_dir;
    expect(dir).toBe(`${SOURCE_ROOT}/Bodhilander`);
  });

  test('keeps a report of what arrived, naming the machine that sent it', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes);
    // Reading the offer is what puts it on screen, and is where the source
    // machine's name is learned.
    await readHandoffOffer(relay.transport);
    messageBoxResponses = [1];

    await restoreMachineHandoff(relay.transport, phrase, legacyDir, noSuggestions);
    const report = readArrival();

    expect(report).not.toBeNull();
    expect(report!.via).toBe('handoff');
    expect(report!.sourceLabel).toBe('Old Laptop');
    expect(report!.sessions).toBe(1);
    // The folder is not on this machine, so the one session that arrived is
    // not one that can start — and the report says so rather than reporting
    // a restore of one session and leaving the rest to be discovered.
    expect(report!.resumable).toBe(0);
    expect(report!.needsRelink.map((r) => r.sessionId)).toEqual(['s1']);
  });

  test('reports only the accounts the bundle carried, not every account here', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes);
    // An account this machine already had, signed out, and never in the
    // transfer. Without scoping it would appear in the "needs sign-in" list of
    // this restore — and of every future one.
    db.prepare(
      `INSERT INTO claude_accounts (id, label, config_dir, email, color, is_default, created_at)
       VALUES ('local-only', 'Not From The Bundle', ?, NULL, '#888888', 0, '2026-08-01T00:00:00.000Z')`,
    ).run(path.join(tmp, 'unrelated', '.claude'));
    messageBoxResponses = [1];

    await restoreMachineHandoff(relay.transport, phrase, legacyDir, noSuggestions);
    const report = readArrival();

    expect(report!.accounts.map((a) => a.accountId)).toEqual(['acct-1']);
  });

  test('relinking a session strikes it off the kept report and makes it launchable', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes);
    messageBoxResponses = [1];
    await restoreMachineHandoff(relay.transport, phrase, legacyDir, noSuggestions);

    expect(readArrival()!.needsRelink.map((r) => r.sessionId)).toEqual(['s1']);
    const here = path.join(tmp, 'dst', 'api');
    fs.mkdirSync(here, { recursive: true });

    const report = resolveRelink('s1', here);

    // Both halves, or the report is describing work that is already done.
    expect(report!.needsRelink).toEqual([]);
    expect(report!.resumable).toBe(1);
    expect(readArrival()!.needsRelink).toEqual([]);
    const row = db.query('SELECT working_dir, state FROM sessions WHERE id = ?').get('s1') as {
      working_dir: string;
      state: string;
    };
    expect(row.working_dir).toBe(here);
    // `stopped`, which is what the sidebar's parked marker is derived from.
    expect(row.state).toBe('stopped');
  });

  test('resolving the same session twice cannot walk the resumable count past the truth', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes);
    messageBoxResponses = [1];
    await restoreMachineHandoff(relay.transport, phrase, legacyDir, noSuggestions);

    const here = path.join(tmp, 'dst', 'api');
    resolveRelink('s1', here);
    const report = resolveRelink('s1', here);

    // Recomputed from the list rather than incremented, so a double-resolve —
    // two windows with the report open, say — is idempotent.
    expect(report!.resumable).toBe(1);
    expect(report!.sessions).toBe(1);
  });

  test('relinks the session even when nothing is keeping score', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes);
    messageBoxResponses = [1];
    await restoreMachineHandoff(relay.transport, phrase, legacyDir, noSuggestions);
    // The user read the report and dismissed it. The session is still parked,
    // and pointing it at a real folder is still worth doing.
    dismissArrival();

    const here = path.join(tmp, 'dst', 'api');
    expect(resolveRelink('s1', here)).toBeNull();

    const row = db.query('SELECT working_dir FROM sessions WHERE id = ?').get('s1') as {
      working_dir: string;
    };
    expect(row.working_dir).toBe(here);
  });

  test('a mistyped phrase names the mistake instead of a decryption failure', async () => {
    const relay = standIn(preparedElsewhere().bytes);
    const result = await restoreMachineHandoff(relay.transport, 'agent album alloy', legacyDir, noSuggestions);
    expect(result.error).toMatch(/18 words/);
    expect(relay.stored()).not.toBeNull();
  });

  test('abandoning the root question leaves everything as it was', async () => {
    const { bytes, phrase } = preparedElsewhere();
    const relay = standIn(bytes);
    messageBoxResponses = [2];

    expect(await restoreMachineHandoff(relay.transport, phrase, legacyDir, noSuggestions)).toEqual({
      success: false,
      error: 'Import cancelled',
    });
    expect(relay.acks).toEqual([]);
    expect(db.query('SELECT COUNT(*) AS n FROM groups').get()).toEqual({ n: 0 });
  });
});
