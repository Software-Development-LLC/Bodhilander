/**
 * The machine-facing half of the arrival report (#202).
 *
 * `transfer/arrival-report.ts` decides what a report says; this gathers the
 * facts it says them about — which sessions landed without their folder, which
 * accounts have no credentials here, where a source root appears to have moved
 * to — and keeps the answer where it can be opened again later.
 *
 * Everything a caller might want to fake is a parameter with a real default,
 * so the wiring is exercised without standing up a filesystem or a window.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import log from 'electron-log';
import * as accountsRepo from './repositories/accounts';
import * as sessionsRepo from './repositories/sessions';
import { deletePreference, getPreference, setPreference } from './repositories/preferences';
import { resolveAccountIdentity } from './account-identity';
import {
  buildArrivalReport,
  clearArrivalReport,
  loadArrivalReport,
  saveArrivalReport,
  type ArrivalAccountItem,
  type ArrivalRelinkItem,
  type ArrivalReport,
  type ReportStore,
} from './transfer/arrival-report';
import { suggestRootMappings, type RootSuggestion } from './transfer/root-suggest';
import type { TransferManifest } from './transfer/bundle-format';
import type { ImportOutcome } from './transfer/bundle-import';

/** The preference table, as the report store sees it. */
const preferenceStore: ReportStore = {
  get: getPreference,
  set: setPreference,
  delete: deletePreference,
};

// ---------------------------------------------------------------------------
// Where to look for a moved root
// ---------------------------------------------------------------------------

/**
 * Conventional places a checkout lives, in the order they are worth trying.
 * The home directory itself is included, so a root directly beneath it is
 * found at depth one; the named children are here because they are where
 * people put code, and starting the walk lower down keeps the visit budget
 * pointed at directories that might actually be an answer.
 */
export function searchBases(home: string = os.homedir()): string[] {
  const named = ['Work', 'work', 'Projects', 'projects', 'Code', 'code', 'src', 'dev', 'Developer', 'repos', 'Repos'];
  return [home, ...named.map((name) => path.join(home, name))];
}

/** Immediate subdirectory names of `dir`; a directory that cannot be read is empty. */
function readSubdirs(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export interface SuggestHereOptions {
  bases?: string[];
  readSubdirs?: (dir: string) => string[];
  directoryExists?: (dir: string) => boolean;
}

/** What this machine thinks the manifest's roots map to. Advice, never applied. */
export function suggestRootMappingsHere(roots: string[], options: SuggestHereOptions = {}): RootSuggestion[] {
  // Only the bases that exist: handing the walk a dozen missing directories
  // spends the visit budget on `readdir` calls that can only fail.
  const exists = options.directoryExists ?? directoryExists;
  const bases = (options.bases ?? searchBases()).filter(exists);
  try {
    return suggestRootMappings(roots, {
      bases,
      readSubdirs: options.readSubdirs ?? readSubdirs,
      directoryExists: exists,
    });
  } catch (err) {
    // A proposal is a convenience. Failing to make one must never be the
    // reason an import does not happen — the manual prompt still works.
    log.warn('[Arrival] Could not propose root mappings:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Recording what arrived
// ---------------------------------------------------------------------------

export interface RecordArrivalInput {
  via: 'file' | 'handoff';
  /** The machine that prepared it, where the transport knows one. */
  sourceLabel?: string | null;
  manifest: TransferManifest | null;
  outcome: ImportOutcome;
  /** Provider ids that need a key re-entered here. Defaults to the manifest's. */
  providersNeedingKeys?: string[];
  now?: () => Date;
  store?: ReportStore;
}

/** The sessions that landed without their folder, named so the report can list them. */
function relinkItems(sessionIds: string[]): ArrivalRelinkItem[] {
  const items: ArrivalRelinkItem[] = [];
  for (const sessionId of sessionIds) {
    // A row that has gone missing between the import and this read is skipped
    // rather than reported as a session with no name.
    const session = sessionsRepo.getSession(sessionId);
    if (!session) continue;
    items.push({ sessionId, name: session.name, workingDir: session.workingDir });
  }
  return items;
}

/**
 * The accounts THIS BUNDLE carried, and whether this machine has credentials
 * for each. Scoped to the bundle rather than to the machine: an account that
 * happens to live here and was never in the transfer is not something this
 * restore left outstanding, and listing it would put a standing "you have a
 * logged-out account" notice inside every future arrival report.
 *
 * Whether it is signed in is read from the config dir, not from the row: the
 * row travelled, the credentials did not, and only the directory on this disk
 * can say.
 */
function accountItems(accountIds: string[]): ArrivalAccountItem[] {
  const wanted = new Set(accountIds);
  return accountsRepo
    .getAllAccounts()
    .filter((account) => wanted.has(account.id))
    .map((account) => ({
      accountId: account.id,
      label: account.label,
      loggedIn: resolveAccountIdentity(account.configDir).loggedIn,
    }));
}

/**
 * Build the report for a restore that just finished, and keep it.
 *
 * Never throws: the restore has already happened by the time this runs, and
 * nothing about failing to describe it should be able to turn a completed
 * import into a reported failure.
 */
export function recordArrival(input: RecordArrivalInput): ArrivalReport | null {
  try {
    const report = buildArrivalReport({
      restoredAt: (input.now?.() ?? new Date()).toISOString(),
      via: input.via,
      sourceLabel: input.sourceLabel ?? null,
      manifest: input.manifest,
      groups: input.outcome.groups,
      sessions: input.outcome.sessions,
      transcripts: input.outcome.transcripts,
      skippedGroups: input.outcome.skippedGroups,
      skippedSessions: input.outcome.skippedSessions,
      needsRelink: relinkItems(input.outcome.needsRelink),
      accounts: accountItems(input.outcome.accountIds),
      // The manifest names providers that had a key on the source. A bundle
      // written before that existed says nothing, and nothing is what gets
      // reported — not "none", which would be a claim the bundle never made.
      providersNeedingKeys: input.providersNeedingKeys ?? input.manifest?.providersWithApiKeys ?? [],
    });
    saveArrivalReport(input.store ?? preferenceStore, report);
    return report;
  } catch (err) {
    log.warn('[Arrival] Could not record the arrival report:', err);
    return null;
  }
}

/**
 * Point a restored session at a folder on this machine, and strike it off the
 * kept report.
 *
 * Both halves, in one place, because they are one act: fixing the session
 * without updating the report leaves the report listing work already done, and
 * updating the report without fixing the session is a lie. The caller gets the
 * rewritten report back so the window can redraw from what was actually
 * stored rather than from its own guess at it.
 *
 * Null when there is no kept report — the session is still relinked, since
 * that is worth doing whether or not anything is keeping score.
 */
export function resolveRelink(
  sessionId: string,
  workingDir: string,
  store: ReportStore = preferenceStore,
): ArrivalReport | null {
  // The directory and nothing else. `workingDirMissing` — the parked marker —
  // is derived from the filesystem on every read, so a real directory is the
  // whole fix; a restored session is already `stopped`, which made writing the
  // state a no-op on the only path that reaches here and left this able to
  // stop a *running* session if it were ever called with another id.
  sessionsRepo.updateSession(sessionId, { workingDir });

  const report = loadArrivalReport(store);
  if (!report) return null;

  const needsRelink = report.needsRelink.filter((item) => item.sessionId !== sessionId);
  const next: ArrivalReport = {
    ...report,
    needsRelink,
    // Recomputed rather than incremented, so a double-resolve of the same
    // session cannot walk the count past the number of sessions there are.
    resumable: Math.max(0, report.sessions - needsRelink.length),
  };
  saveArrivalReport(store, next);
  return next;
}

/** The kept report, or null when there has been no restore on this machine. */
export function readArrival(store: ReportStore = preferenceStore): ArrivalReport | null {
  return loadArrivalReport(store);
}

/** Forget it, once the user says they are done with it. */
export function dismissArrival(store: ReportStore = preferenceStore): void {
  clearArrivalReport(store);
}
