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

import type { TransferManifest } from './bundle-format';

/** A session that arrived but cannot start until somebody says where it lives. */
export interface ArrivalRelinkItem {
  sessionId: string;
  name: string;
  /** The directory as it was remapped, i.e. where we looked and did not find it. */
  workingDir: string;
}

export interface ArrivalAccountItem {
  accountId: string;
  label: string;
  /**
   * Undefined where the evidence could not be read, which is not the same as
   * "never logged in" and is not reported as needing a sign-in.
   */
  loggedIn: boolean | undefined;
}

export interface ArrivalReport {
  /** ISO 8601, stamped by the caller so this module stays a pure assembly. */
  restoredAt: string;
  /** How the state got here, for a report the user opens a week later. */
  via: 'file' | 'handoff';
  /** The machine that prepared it, when the transport knows. */
  sourceLabel: string | null;
  sourcePlatform: string | null;
  groups: number;
  sessions: number;
  /** Sessions whose working directory is on this machine, so they can start. */
  resumable: number;
  transcripts: number;
  skippedGroups: number;
  skippedSessions: number;
  needsRelink: ArrivalRelinkItem[];
  accounts: ArrivalAccountItem[];
  /**
   * Providers that had a key on the source machine. The keys themselves are
   * sealed to that machine's keychain and never travel; these are names, so
   * the report can say which ones to re-enter rather than leaving the user to
   * discover it when a launch fails.
   */
  providersNeedingKeys: string[];
}

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

/** Accounts the user still has to sign in to, in the order they arrived. */
export function accountsNeedingSignIn(report: ArrivalReport): ArrivalAccountItem[] {
  // `undefined` means the evidence was unreadable. Listing it as "sign in"
  // would send someone to re-authenticate an account that may be fine.
  return report.accounts.filter((a) => a.loggedIn === false);
}

/**
 * Whether anything in the report is still waiting on a person. This is what
 * decides whether the report is worth surfacing at all — a restore onto the
 * same machine, with every folder present and every account already signed in,
 * has nothing to say and should say nothing.
 */
export function hasOutstandingWork(report: ArrivalReport): boolean {
  return (
    report.needsRelink.length > 0 ||
    accountsNeedingSignIn(report).length > 0 ||
    report.providersNeedingKeys.length > 0
  );
}

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
