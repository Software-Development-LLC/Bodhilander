/**
 * Why a hire's runs are held on this machine, if they are. Causes are checked
 * in a fixed order and the owner is told once per cause. Held jobs keep their
 * place in the queue; nothing here moves them to another account.
 */
import type { AccountUsage, UsageWindow } from '../../shared/types';
import type { QuotaLimitHit } from '../quota-limit';
import type { CrewAccountCap } from '../repositories/preferences';

export type HoldCause = 'missing' | 'signed-out' | 'rate-limited' | 'crew-cap' | 'hire-cap';

export interface HireCap {
  /** Daily token ceiling, or null when off (the default). */
  dailyTokens: number | null;
  usedToday: number;
}

export interface HoldInputs {
  accountId: string | null;
  signedIn: boolean;
  usage: AccountUsage | null;
  cap: CrewAccountCap;
  hireCap: HireCap;
  now: number;
}

export type WindowReading = { pct: number } | 'not reported';

/** A window with no reading, or one whose reset has passed, is not reported, never 0%. */
export function readWindow(window: UsageWindow | null | undefined, now: number): WindowReading {
  if (!window) return 'not reported';
  if (window.resetsAt !== null && window.resetsAt <= now) return 'not reported';
  return { pct: window.pct };
}

export function overCrewCap(usage: AccountUsage | null, cap: CrewAccountCap, now: number): boolean {
  const five = readWindow(usage?.fiveHour, now);
  const seven = readWindow(usage?.sevenDay, now);
  return (five !== 'not reported' && five.pct >= cap.fiveHourPct) || (seven !== 'not reported' && seven.pct >= cap.sevenDayPct);
}

/** The tokens the per-hire cap counts from a run's result.usage; cache reads are not counted. */
export function capTokens(usage: { input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number }): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

/** The calendar day in the owner's timezone, so the hire cap resets at their midnight. */
export function capDay(now: number, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
}

export class Holds {
  private readonly limitedUntil = new Map<string, number>();
  private readonly told = new Map<string, HoldCause>();

  /** A usage-limit rejection for the account; a later hit replaces the reset time. */
  recordRateLimit(accountId: string, resetAt: number): void {
    this.limitedUntil.set(accountId, resetAt);
  }

  recordQuotaLimit(accountId: string, hit: QuotaLimitHit): void {
    this.recordRateLimit(accountId, hit.resetAt.getTime());
  }

  rateLimitedUntil(accountId: string, now: number): number | null {
    const until = this.limitedUntil.get(accountId);
    if (until === undefined) return null;
    if (until <= now) {
      this.limitedUntil.delete(accountId);
      return null;
    }
    return until;
  }

  evaluate(inputs: HoldInputs): HoldCause | null {
    if (inputs.accountId === null) return 'missing';
    if (!inputs.signedIn) return 'signed-out';
    if (this.rateLimitedUntil(inputs.accountId, inputs.now) !== null) return 'rate-limited';
    if (overCrewCap(inputs.usage, inputs.cap, inputs.now)) return 'crew-cap';
    const { dailyTokens, usedToday } = inputs.hireCap;
    if (dailyTokens !== null && usedToday >= dailyTokens) return 'hire-cap';
    return null;
  }

  /** True the first time a hire is held for this cause; a release lets the next hold notify again. */
  shouldNotify(hireId: string, cause: HoldCause | null): boolean {
    const last = this.told.get(hireId);
    if (cause === null) {
      this.told.delete(hireId);
      return false;
    }
    if (last === cause) return false;
    this.told.set(hireId, cause);
    return true;
  }
}
