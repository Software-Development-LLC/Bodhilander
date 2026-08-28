/**
 * What actually survived a restore, said plainly.
 *
 * A restore reports counts today — groups, sessions, transcripts — and counts
 * are the half that is easy. The half that matters is what still needs a
 * person: sessions whose folder is not on this machine, accounts with no
 * credentials here, and provider keys that were deliberately left behind
 * because they are sealed to the source machine's keychain.
 *
 * None of that is inferable from a success message, so this states it. It is
 * kept rather than shown once: the work it describes is not work anybody
 * finishes in the thirty seconds after an import, and a dialog that has been
 * dismissed is a list nobody can get back.
 */

import type { ArrivalAccountItem, ArrivalRelinkItem, ArrivalReport } from '../../shared/types';
import type { TransferManifest } from './bundle-format';

// The report's shapes live in `shared/types` because the renderer draws them
// and preload has to name them on the way through.
export type { ArrivalAccountItem, ArrivalRelinkItem, ArrivalReport } from '../../shared/types';

export interface BuildArrivalReportInput {
  restoredAt: string;
  via: 'file' | 'handoff';
  sourceLabel?: string | null;
  manifest: TransferManifest | null;
  groups: number;
  sessions: number;
  transcripts: number;
  skippedGroups: number;
  skippedSessions: number;
  needsRelink: ArrivalRelinkItem[];
  accounts: ArrivalAccountItem[];
  providersNeedingKeys: string[];
}

export function buildArrivalReport(input: BuildArrivalReportInput): ArrivalReport {
  return {
    restoredAt: input.restoredAt,
    via: input.via,
    sourceLabel: input.sourceLabel ?? null,
    sourcePlatform: input.manifest?.sourcePlatform ?? null,
    groups: input.groups,
    sessions: input.sessions,
    // Never negative, even if a caller hands in a relink list longer than the
    // session count — a wrong number here would read as a fact about the user's
    // data rather than as the bug it is.
    resumable: Math.max(0, input.sessions - input.needsRelink.length),
    transcripts: input.transcripts,
    skippedGroups: input.skippedGroups,
    skippedSessions: input.skippedSessions,
    needsRelink: input.needsRelink,
    accounts: input.accounts,
    providersNeedingKeys: input.providersNeedingKeys,
  };
}

// One implementation, in `shared/arrival`, because the renderer asks the same
// two questions of a report and a second copy would eventually disagree.
export { accountsNeedingSignIn, hasOutstandingWork } from '../../shared/arrival';

/**
 * Where the kept report lives. Under `arrival.` so the export policy treats it
 * as local without anybody having to remember it: the prefix is listed in
 * `LOCAL_PREFERENCE_PREFIXES`, and carrying one machine's arrival report to
 * another would describe a restore that never happened there.
 */
export const ARRIVAL_REPORT_PREF = 'arrival.lastReport';

export interface ReportStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export function saveArrivalReport(store: ReportStore, report: ArrivalReport): void {
  store.set(ARRIVAL_REPORT_PREF, JSON.stringify(report));
}

/**
 * The kept report, or null when there is none or it cannot be read. A stored
 * value that no longer parses is treated as absent rather than thrown over:
 * this is a convenience surface, and failing to open it must not be able to
 * stop the window it is opened from.
 */
export function loadArrivalReport(store: ReportStore): ArrivalReport | null {
  const raw = store.get(ARRIVAL_REPORT_PREF);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const report = parsed as ArrivalReport;
    // Enough of a shape check that a value from an older build, or from a key
    // somebody set by hand, does not reach the renderer as a half-report.
    if (typeof report.restoredAt !== 'string') return null;
    if (!Array.isArray(report.needsRelink) || !Array.isArray(report.accounts)) return null;
    if (!Array.isArray(report.providersNeedingKeys)) return null;
    return report;
  } catch {
    return null;
  }
}

export function clearArrivalReport(store: ReportStore): void {
  store.delete(ARRIVAL_REPORT_PREF);
}
