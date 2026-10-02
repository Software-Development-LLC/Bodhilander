import log from 'electron-log';

import { AccountUsageMap, ClaudeAccount, LiveAccountBindings } from '../shared/types';
import { isSinkEnabled, USAGE_SINK_PREF } from '../shared/usage';
import { CredentialStore } from './credential-store';
import { FetchLike } from './usage-credentials';
import { describeCrossing } from './usage-meter';
import {
  ownedAccountIds,
  RunOwnershipDeps,
  runAccountIdsForOwnership,
  UsageCrossingEvent,
  UsagePoller,
} from './usage-poller';
import { hasSavedChain, SinkLaunch, sinkReconciler } from './statusline-sink';

/**
 * The usage meters as the app runs them: which accounts' tokens a CLI owns,
 * keeping every account's statusline sink in step with its preference, and
 * where readings and threshold notices go.
 */

export interface UsageServiceDeps {
  listAccounts: () => ClaudeAccount[];
  getPreference: (key: string) => string | null;
  liveAccounts: () => LiveAccountBindings;
  activeRuns: () => { id: string; groupId: string | null }[];
  ownership: RunOwnershipDeps;
  fetch: FetchLike;
  credentials: CredentialStore;
  /** Null when this build carries no sink script. */
  sink: SinkLaunch | null;
  publish: (usage: AccountUsageMap) => void;
  notify: (title: string, body: string) => void;
  now?: () => number;
  watchSinks?: boolean;
}

/** Accounts a live pty or an active run's gates hold. A failed run listing still counts the ptys. */
export function tokenOwnedAccountIds(
  deps: Pick<UsageServiceDeps, 'liveAccounts' | 'activeRuns' | 'ownership'>,
): Set<string> {
  let runAccountIds: (string | null)[] = [];
  try {
    runAccountIds = runAccountIdsForOwnership(deps.activeRuns(), deps.ownership);
  } catch (err) {
    log.warn('[Usage] Could not list active runs for token ownership:', err);
  }
  return ownedAccountIds(deps.liveAccounts(), runAccountIds);
}

export interface UsageService {
  poller: UsagePoller;
  start(): void;
  stop(): void;
  /** Re-applies the sink everywhere when the sink preference is what changed. */
  preferenceChanged(key: string): void;
}

export function createUsageService(deps: UsageServiceDeps): UsageService {
  if (!deps.sink) log.warn('[Usage] Statusline sink unavailable; meters rely on polling alone');
  const apply = sinkReconciler(deps.sink, () => isSinkEnabled(deps.getPreference(USAGE_SINK_PREF)));
  const lastAction = new Map<string, string>();
  const reconcile = (configDir: string) => {
    const action = apply(configDir);
    if (action === 'error') log.warn(`[Usage] Could not update the statusline sink in ${configDir}`);
    // Every round reconciles, so only a change of outcome is worth a line.
    if (lastAction.get(configDir) === action) return;
    lastAction.set(configDir, action);
    const chained = hasSavedChain(configDir) ? 'yes' : 'no';
    log.info(`[Usage] Statusline sink ${action} in ${configDir}; user statusLine chained: ${chained}`);
  };
  const now = deps.now ?? Date.now;

  const poller = new UsagePoller({
    listAccounts: deps.listAccounts,
    boundAccountIds: () => tokenOwnedAccountIds(deps),
    fetch: deps.fetch,
    credentials: deps.credentials,
    now: deps.now,
    ensureSink: account => reconcile(account.configDir),
    watchSinks: deps.watchSinks ?? true,
  });
  poller.on('updated', deps.publish);
  poller.on('crossing', ({ account, crossing }: UsageCrossingEvent) => {
    deps.notify(`${account.label} is near its usage limit`, describeCrossing(account.label, crossing, now()));
  });

  return {
    poller,
    start: () => poller.start(),
    stop: () => poller.stop(),
    preferenceChanged: key => {
      if (key !== USAGE_SINK_PREF) return;
      for (const account of deps.listAccounts()) reconcile(account.configDir);
    },
  };
}
