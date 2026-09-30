import { EventEmitter } from 'events';
import * as fs from 'fs';
import log from 'electron-log';

import { AccountUsage, ClaudeAccount, LiveAccountBindings, UsageUnavailableReason } from '../shared/types';
import { USAGE_STALE_MS } from '../shared/usage';
import { CredentialStore } from './credential-store';
import { FetchLike, isTokenExpired, OAuthCredentials, refreshOAuthToken } from './usage-credentials';
import {
  emptyUsage,
  mergeUsage,
  parseOAuthUsage,
  parseStatuslineSink,
  ThresholdCrossing,
  ThresholdNotices,
  UsageObservation,
} from './usage-meter';
import { sinkFilePath } from './statusline-sink';
import { trackTokenRefresh } from './token-refresh';
import * as usageStore from './usage-store';

/**
 * Polls every registered account's usage, whether or not a session runs on it,
 * because usage spent on another machine only shows up here. Also ingests what
 * the statusline sink writes for accounts with an interactive session.
 */

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const USAGE_POLL_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** Opening the panel twice in a row must not poll twice. */
const REFRESH_THROTTLE_MS = 30_000;
const SINK_WATCH_INTERVAL_MS = 2_000;

export interface UsagePollerDeps {
  listAccounts: () => ClaudeAccount[];
  /** Accounts a running pty is bound to. Their tokens belong to the CLI. */
  boundAccountIds: () => Set<string>;
  fetch: FetchLike;
  /** Where tokens are read and rotations saved: the token file, or the macOS Keychain. */
  credentials: CredentialStore;
  now?: () => number;
  /** Keep the statusline sink installed in each account's settings. */
  ensureSink?: (account: ClaudeAccount) => void;
  /** Off in tests, which feed sink files in by hand. */
  watchSinks?: boolean;
}

/**
 * Accounts whose token a running CLI owns: live ptys, plus the account each
 * active run's gates launch under, since those CLIs are not ptys.
 */
export function ownedAccountIds(live: LiveAccountBindings, runAccountIds: (string | null)[]): Set<string> {
  const ids = new Set<string>();
  for (const binding of Object.values(live)) {
    if (binding.accountId) ids.add(binding.accountId);
  }
  for (const id of runAccountIds) {
    if (id) ids.add(id);
  }
  return ids;
}

export interface RunOwnershipDeps {
  candidate: (groupId: string | null) => string | null;
  resolved: (groupId: string | null) => string | null;
  launchedDirs: (activeRunIds: string[]) => string[];
  accountIdForDir: (configDir: string) => string | null;
}

/**
 * The accounts active runs may have gates running on: the group's own account
 * (a gate launched before a restart), its current resolution, and every dir a
 * gate was actually launched under. Over-counting only delays a refresh.
 */
export function runAccountIdsForOwnership(
  runs: { id: string; groupId: string | null }[],
  deps: RunOwnershipDeps,
): (string | null)[] {
  const ids = runs.flatMap(run => [deps.candidate(run.groupId), deps.resolved(run.groupId)]);
  for (const dir of deps.launchedDirs(runs.map(run => run.id))) ids.push(deps.accountIdForDir(dir));
  return ids;
}

export interface UsageCrossingEvent {
  account: ClaudeAccount;
  crossing: ThresholdCrossing;
}

export class UsagePoller extends EventEmitter {
  private readonly now: () => number;
  private readonly notices = new ThresholdNotices();
  private readonly retryAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly lastAttempt = new Map<string, number>();
  private readonly watched = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: UsagePollerDeps) {
    super();
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.pollAll().catch(() => undefined); }, USAGE_POLL_MS);
    this.pollAll().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const file of this.watched.values()) fs.unwatchFile(file);
    this.watched.clear();
  }

  /** One immediate round, for the accounts panel opening. */
  refreshNow(): Promise<void> {
    return this.pollAll(REFRESH_THROTTLE_MS);
  }

  /** Poll every account once. Concurrent callers share one round. */
  pollAll(minGapMs = 0): Promise<void> {
    this.inFlight ??= this.runRound(minGapMs).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async runRound(minGapMs: number): Promise<void> {
    const accounts = this.syncAccounts();
    const threshold = usageStore.getUsageThreshold();
    for (const account of accounts) {
      const last = this.lastAttempt.get(account.id);
      if (minGapMs > 0 && last !== undefined && this.now() - last < minGapMs) continue;
      try {
        await this.pollAccount(account, threshold);
      } catch (err) {
        log.warn(`[Usage] Poll failed for ${account.label}: ${describeError(err)}`);
        this.markUnavailable(account.id, 'error');
      }
    }
    this.publish();
  }

  /** Track the current account list: sinks, watchers, and records to drop. */
  private syncAccounts(): ClaudeAccount[] {
    const accounts = this.deps.listAccounts();
    const ids = new Set(accounts.map(a => a.id));
    for (const [id, file] of this.watched) {
      if (ids.has(id)) continue;
      fs.unwatchFile(file);
      this.watched.delete(id);
    }
    for (const id of Object.keys(usageStore.allUsage())) {
      if (!ids.has(id)) usageStore.forgetUsage(id);
    }
    for (const account of accounts) {
      try {
        this.deps.ensureSink?.(account);
      } catch (err) {
        log.warn(`[Usage] Could not install the statusline sink for ${account.label}: ${describeError(err)}`);
      }
      if (this.deps.watchSinks) this.watchSink(account);
    }
    return accounts;
  }

  private watchSink(account: ClaudeAccount): void {
    if (this.watched.has(account.id)) return;
    const file = sinkFilePath(account.configDir);
    this.watched.set(account.id, file);
    this.ingestSinkFile(account);
    fs.watchFile(file, { interval: SINK_WATCH_INTERVAL_MS, persistent: false }, (curr) => {
      if (curr.mtimeMs > 0 && this.ingestSinkFile(account)) this.publish();
    });
  }

  /** Read what the statusline sink last wrote for an account. */
  ingestSinkFile(account: ClaudeAccount): boolean {
    let body: unknown;
    try {
      body = JSON.parse(fs.readFileSync(sinkFilePath(account.configDir), 'utf-8'));
    } catch {
      return false;
    }
    const obs = parseStatuslineSink(body);
    return obs ? this.observe(account, obs) : false;
  }

  private async pollAccount(account: ClaudeAccount, threshold: number): Promise<void> {
    const now = this.now();
    if ((this.retryAt.get(account.id) ?? 0) > now) return;
    this.lastAttempt.set(account.id, now);

    const creds = await this.deps.credentials.read(account.configDir);
    if (!creds) {
      this.markUnavailable(account.id, this.deps.credentials.missing);
      return;
    }
    const response = await this.authorisedUsage(account, creds, now);
    if (!response) return;

    if (response.status === 429 || response.status >= 500) {
      this.backOff(account, response.status, response.headers.get('retry-after'));
      this.markUnavailable(account.id, 'error');
      return;
    }
    this.failures.delete(account.id);
    this.retryAt.delete(account.id);

    if (isAuthRejection(response.status)) {
      this.markUnavailable(account.id, 'reauth');
      return;
    }
    const obs = response.ok ? parseOAuthUsage(await response.json(), this.now()) : null;
    if (!obs) {
      log.warn(`[Usage] Unrecognised usage response for ${account.label} (${response.status})`);
      this.markUnavailable(account.id, 'error');
      return;
    }
    this.observe(account, obs, threshold);
  }

  /**
   * The usage response, refreshing an unowned account's token first when it has
   * expired, or once when the endpoint rejects a token the clock called valid.
   * Null when there is nothing to ask with.
   */
  private async authorisedUsage(
    account: ClaudeAccount,
    creds: OAuthCredentials,
    now: number,
  ): Promise<FetchResponse | null> {
    const owned = this.deps.boundAccountIds().has(account.id);
    if (isTokenExpired(creds, now)) {
      // A running CLI refreshes its own token; refreshing under it would race
      // the rotation. What it writes is read on the next round.
      if (owned) return null;
      const token = await this.refreshToken(account, creds);
      return token ? this.requestUsage(token) : null;
    }
    const response = await this.requestUsage(creds.accessToken);
    if (!isAuthRejection(response.status) || !creds.refreshToken) return response;
    if (this.deps.boundAccountIds().has(account.id)) return response;
    const token = await this.refreshToken(account, creds);
    return token ? this.requestUsage(token) : null;
  }

  private requestUsage(accessToken: string): Promise<FetchResponse> {
    return this.deps.fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
  }

  private refreshToken(account: ClaudeAccount, creds: OAuthCredentials): Promise<string | null> {
    return trackTokenRefresh(account.configDir, this.rotateToken(account, creds));
  }

  private async rotateToken(
    account: ClaudeAccount,
    creds: OAuthCredentials,
  ): Promise<string | null> {
    try {
      const rotated = await refreshOAuthToken(creds, this.deps.fetch, this.now);
      // The old refresh token is spent once this returns, so the rotation is
      // saved even if a CLI bound to the account during the request.
      if (this.deps.boundAccountIds().has(account.id)) {
        log.warn(`[Usage] ${account.label} was bound during a token refresh; saving the rotation anyway`);
      }
      if (!(await this.deps.credentials.writeRotated(account.configDir, rotated))) {
        log.warn(`[Usage] Refreshed ${account.label}'s token but could not save it`);
        this.markUnavailable(account.id, 'reauth');
        return null;
      }
      log.info(`[Usage] Refreshed the token for ${account.label}`);
      return rotated.accessToken;
    } catch (err) {
      log.warn(`[Usage] Token refresh failed for ${account.label}: ${describeError(err)}`);
      this.markUnavailable(account.id, 'reauth');
      return null;
    }
  }

  private backOff(account: ClaudeAccount, status: number, retryAfter: string | null): void {
    const failures = (this.failures.get(account.id) ?? 0) + 1;
    this.failures.set(account.id, failures);
    const seconds = Number(retryAfter);
    const hinted = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    const exponential = USAGE_POLL_MS * 2 ** (failures - 1);
    const delay = Math.min(MAX_BACKOFF_MS, Math.max(hinted, exponential));
    this.retryAt.set(account.id, this.now() + delay);
    log.warn(`[Usage] Usage endpoint returned ${status} for ${account.label}; retrying in ${Math.round(delay / 60_000)}m`);
  }

  private record(accountId: string): AccountUsage {
    return usageStore.getUsage(accountId) ?? emptyUsage(accountId);
  }

  private markUnavailable(accountId: string, reason: UsageUnavailableReason): void {
    usageStore.setUsage({ ...this.record(accountId), unavailable: reason });
  }

  private observe(
    account: ClaudeAccount,
    obs: UsageObservation,
    threshold: number = usageStore.getUsageThreshold(),
  ): boolean {
    const prev = this.record(account.id);
    const next = mergeUsage(prev, obs);
    if (next === prev) return false;
    usageStore.setUsage(next);
    if (this.now() - obs.observedAt > USAGE_STALE_MS) return true;
    for (const crossing of this.notices.check(next, threshold, this.now())) {
      this.emit('crossing', { account, crossing } satisfies UsageCrossingEvent);
    }
    return true;
  }

  private publish(): void {
    this.emit('updated', usageStore.allUsage());
  }
}

type FetchResponse = Awaited<ReturnType<FetchLike>>;

function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/** Error text without anything a response body might have carried. */
function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
}
