import { EventEmitter } from 'events';
import * as fs from 'fs';
import log from 'electron-log';

import { AccountUsage, ClaudeAccount, LiveAccountBindings, UsageUnavailableReason } from '../shared/types';
import { USAGE_STALE_MS } from '../shared/usage';
import {
  FetchLike,
  isTokenExpired,
  OAuthCredentials,
  readOAuthCredentials,
  refreshOAuthToken,
  writeRotatedTokens,
} from './usage-credentials';
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
    if (!this.inFlight) {
      this.inFlight = this.runRound(minGapMs).finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async runRound(minGapMs: number): Promise<void> {
    const accounts = this.syncAccounts();
    for (const account of accounts) {
      const last = this.lastAttempt.get(account.id);
      if (minGapMs > 0 && last !== undefined && this.now() - last < minGapMs) continue;
      try {
        await this.pollAccount(account);
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

  private async pollAccount(account: ClaudeAccount): Promise<void> {
    const now = this.now();
    if ((this.retryAt.get(account.id) ?? 0) > now) return;
    this.lastAttempt.set(account.id, now);

    let creds = readOAuthCredentials(account.configDir);
    if (!creds) {
      this.markUnavailable(account.id, 'no-credentials');
      return;
    }

    if (isTokenExpired(creds, now)) {
      // A running CLI refreshes its own token; refreshing under it would race
      // the rotation. The file it rewrites is read on the next round.
      if (this.deps.boundAccountIds().has(account.id)) return;
      const token = await this.refreshToken(account, creds);
      if (!token) return;
      creds = { ...creds, accessToken: token };
    }

    const response = await this.deps.fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 429 || response.status >= 500) {
      this.backOff(account, response.status, response.headers.get('retry-after'));
      this.markUnavailable(account.id, 'error');
      return;
    }
    this.failures.delete(account.id);
    this.retryAt.delete(account.id);

    if (response.status === 401 || response.status === 403) {
      this.markUnavailable(account.id, 'reauth');
      return;
    }
    const obs = response.ok ? parseOAuthUsage(await response.json(), this.now()) : null;
    if (!obs) {
      log.warn(`[Usage] Unrecognised usage response for ${account.label} (${response.status})`);
      this.markUnavailable(account.id, 'error');
      return;
    }
    this.observe(account, obs);
  }

  private async refreshToken(
    account: ClaudeAccount,
    creds: OAuthCredentials,
  ): Promise<string | null> {
    try {
      const rotated = await refreshOAuthToken(creds, this.deps.fetch, this.now);
      if (!writeRotatedTokens(account.configDir, rotated)) {
        log.warn(`[Usage] Refreshed ${account.label}'s token but could not save it`);
        this.markUnavailable(account.id, 'reauth');
        return null;
      }
      log.info(`[Usage] Refreshed the expired token for ${account.label}`);
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

  private observe(account: ClaudeAccount, obs: UsageObservation): boolean {
    const prev = this.record(account.id);
    const next = mergeUsage(prev, obs);
    if (next === prev) return false;
    usageStore.setUsage(next);
    if (this.now() - obs.observedAt > USAGE_STALE_MS) return true;
    for (const crossing of this.notices.check(next, usageStore.getUsageThreshold(), this.now())) {
      this.emit('crossing', { account, crossing } satisfies UsageCrossingEvent);
    }
    return true;
  }

  private publish(): void {
    this.emit('updated', usageStore.allUsage());
  }
}

/** Error text without anything a response body might have carried. */
function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
}
