/**
 * The arrival report. What is pinned here is mostly about honesty: that
 * "resumable" is derived and not asserted, that an account whose login
 * evidence could not be read is never reported as needing a sign-in, and that
 * a kept report which no longer parses reads as absent rather than as a
 * half-report the renderer will draw.
 */
import { describe, expect, test } from 'bun:test';
import {
  ARRIVAL_REPORT_PREF,
  accountsNeedingSignIn,
  buildArrivalReport,
  clearArrivalReport,
  hasOutstandingWork,
  loadArrivalReport,
  saveArrivalReport,
  type ArrivalReport,
  type BuildArrivalReportInput,
  type ReportStore,
} from '../arrival-report';

function store(seed: Record<string, string> = {}): ReportStore & { rows: Map<string, string> } {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    get: (key) => rows.get(key) ?? null,
    set: (key, value) => void rows.set(key, value),
    delete: (key) => void rows.delete(key),
  };
}

const BASE: BuildArrivalReportInput = {
  restoredAt: '2026-08-28T10:00:00.000Z',
  via: 'handoff',
  sourceLabel: 'Old Laptop',
  manifest: null,
  groups: 3,
  sessions: 10,
  transcripts: 42,
  skippedGroups: 0,
  skippedSessions: 0,
  needsRelink: [],
  accounts: [],
  providersNeedingKeys: [],
};

describe('building the report', () => {
  test('derives resumable from what actually needs relinking', () => {
    const report = buildArrivalReport({
      ...BASE,
      sessions: 10,
      needsRelink: [
        { sessionId: 's1', name: 'api', workingDir: '/Users/will/Work/api' },
        { sessionId: 's2', name: 'web', workingDir: '/Users/will/Work/web' },
      ],
    });

    expect(report.resumable).toBe(8);
    expect(report.needsRelink).toHaveLength(2);
  });

  test('never reports a negative count, however wrong the inputs are', () => {
    // A number below zero here would read as a claim about the user's data
    // rather than as the bug it would be.
    const report = buildArrivalReport({
      ...BASE,
      sessions: 1,
      needsRelink: [
        { sessionId: 's1', name: 'a', workingDir: '/a' },
        { sessionId: 's2', name: 'b', workingDir: '/b' },
      ],
    });

    expect(report.resumable).toBe(0);
  });

  test('takes the platform from the manifest and the label from the transport', () => {
    const report = buildArrivalReport({
      ...BASE,
      sourceLabel: 'Old Laptop',
      manifest: { sourcePlatform: 'win32' } as never,
    });

    expect(report.sourceLabel).toBe('Old Laptop');
    expect(report.sourcePlatform).toBe('win32');
  });

  test('a file import has no source machine to name, and says so rather than guessing', () => {
    const report = buildArrivalReport({ ...BASE, via: 'file', sourceLabel: undefined, manifest: null });

    expect(report.via).toBe('file');
    expect(report.sourceLabel).toBeNull();
    expect(report.sourcePlatform).toBeNull();
  });
});

describe('who still has to do something', () => {
  test('lists accounts with no credentials here', () => {
    const report = buildArrivalReport({
      ...BASE,
      accounts: [
        { accountId: 'a1', label: 'work', loggedIn: false },
        { accountId: 'a2', label: 'personal', loggedIn: true },
      ],
    });

    expect(accountsNeedingSignIn(report).map((a) => a.label)).toEqual(['work']);
  });

  test('an account whose evidence could not be read is not sent to re-authenticate', () => {
    // `undefined` is "unreadable", not "logged out" — Claude rewrites the
    // profile file about once a minute, so a torn read is ordinary. Telling
    // someone to sign in again on that basis is worse than saying nothing.
    const report = buildArrivalReport({
      ...BASE,
      accounts: [{ accountId: 'a1', label: 'work', loggedIn: undefined }],
    });

    expect(accountsNeedingSignIn(report)).toEqual([]);
    expect(hasOutstandingWork(report)).toBe(false);
  });

  test('a clean restore onto the same machine has nothing to say', () => {
    const report = buildArrivalReport({
      ...BASE,
      accounts: [{ accountId: 'a1', label: 'work', loggedIn: true }],
    });

    expect(hasOutstandingWork(report)).toBe(false);
  });

  test.each([
    ['a session to relink', { needsRelink: [{ sessionId: 's', name: 'n', workingDir: '/d' }] }],
    ['an account to sign in', { accounts: [{ accountId: 'a', label: 'l', loggedIn: false }] }],
    ['a provider key to re-enter', { providersNeedingKeys: ['openai'] }],
  ])('%s is outstanding work on its own', (_label, patch) => {
    expect(hasOutstandingWork(buildArrivalReport({ ...BASE, ...patch }))).toBe(true);
  });
});

describe('keeping it', () => {
  test('survives a round trip, so the report outlives the dialog', () => {
    const rows = store();
    const report = buildArrivalReport({
      ...BASE,
      needsRelink: [{ sessionId: 's1', name: 'api', workingDir: '/Users/will/Work/api' }],
      accounts: [{ accountId: 'a1', label: 'work', loggedIn: false }],
      providersNeedingKeys: ['openai'],
    });

    saveArrivalReport(rows, report);
    expect(loadArrivalReport(rows)).toEqual(report);
  });

  test('is stored under a key the export policy already treats as local', () => {
    // `arrival.` is a listed local prefix. A report describing a restore that
    // happened on one machine must not travel to another and be read there as
    // that machine's own history.
    expect(ARRIVAL_REPORT_PREF.startsWith('arrival.')).toBe(true);
  });

  test('reads as absent when there is none', () => {
    expect(loadArrivalReport(store())).toBeNull();
  });

  test.each([
    ['not JSON at all', 'null and void'],
    ['JSON that is not an object', '42'],
    ['an object missing its timestamp', '{"needsRelink":[],"accounts":[],"providersNeedingKeys":[]}'],
    ['an object whose lists are not lists', '{"restoredAt":"x","needsRelink":null,"accounts":[],"providersNeedingKeys":[]}'],
  ])('reads as absent rather than half a report: %s', (_label, raw) => {
    // This surface is a convenience. Failing to open it must not be able to
    // stop the window it is opened from.
    expect(loadArrivalReport(store({ [ARRIVAL_REPORT_PREF]: raw }))).toBeNull();
  });

  test('clearing it leaves nothing behind', () => {
    const rows = store();
    saveArrivalReport(rows, buildArrivalReport(BASE));
    clearArrivalReport(rows);

    expect(rows.rows.has(ARRIVAL_REPORT_PREF)).toBe(false);
    expect(loadArrivalReport(rows)).toBeNull();
  });

  test('a second restore replaces the first, rather than accumulating', () => {
    const rows = store();
    saveArrivalReport(rows, buildArrivalReport({ ...BASE, sessions: 10 }));
    saveArrivalReport(rows, buildArrivalReport({ ...BASE, sessions: 2, restoredAt: '2026-08-29T00:00:00.000Z' }));

    const loaded = loadArrivalReport(rows) as ArrivalReport;
    expect(loaded.sessions).toBe(2);
    expect(loaded.restoredAt).toBe('2026-08-29T00:00:00.000Z');
  });
});
