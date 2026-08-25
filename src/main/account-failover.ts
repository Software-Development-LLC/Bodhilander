import log from 'electron-log';

import {
  AccountFailoverEvent,
  ClaudeAccount,
  LiveAccountBindings,
  SessionState,
} from '../shared/types';
import { resolveAccountForSession } from './account-resolver';
import { assignSessionAccount } from './account-switch';
import * as accountsRepo from './repositories/accounts';
import { getPreference } from './repositories/preferences';
import * as sessionsRepo from './repositories/sessions';

/**
 * What happens when an account runs out of quota mid-session.
 *
 * The mechanics of moving a session between accounts already exist — the user
 * can do it by hand, and account-switch.ts carries the conversation across and
 * reports which ptys need respawning. This module is only the policy on top:
 * which account is spent, which one takes the work, and when the session is
 * allowed to go back.
 *
 * Two things it deliberately does NOT do. It never spawns or kills a pty —
 * a switch takes effect on respawn, and the renderer owns that (CLAUDE_CONFIG_DIR
 * is fixed at spawn). And it never decides that output means a limit; it is
 * handed that verdict by the pty scanner, so the text-matching risk stays in
 * one place.
 */

/** Preference keys. Both default to on — absent means enabled. */
const FAILOVER_PREF = 'accountFailoverEnabled';
const FAILBACK_PREF = 'accountFailbackEnabled';

export function isFailoverEnabled(): boolean {
  return getPreference(FAILOVER_PREF) !== 'false';
}

export function isFailbackEnabled(): boolean {
  return getPreference(FAILBACK_PREF) !== 'false';
}

export interface UsageLimitReport {
  /** Session whose pty printed the announcement. */
  sessionId: string;
  /** Account that pty was BILLING — its live binding, not its assignment. */
  accountId: string | null;
  /** Reset time parsed from the message, or null when it named none. */
  resetAt: Date | null;
  /** Which accounts running ptys are currently bound to. */
  liveAccounts: LiveAccountBindings;
}

/**
 * The next account willing to take work, in the user's failover order.
 *
 * Exported because the accounts panel shows the same answer ("Work is next in
 * line") and must not compute it a second way.
 */
export function nextHealthyAccount(excludeId: string | null, now: Date = new Date()): ClaudeAccount | null {
  return accountsRepo.getAccountsInFallbackOrder().find(
    account => account.id !== excludeId && accountsRepo.isAccountHealthy(account, now)
  ) ?? null;
}

/**
 * Record a usage limit and move the account's live sessions off it.
 *
 * Returns null only when there is nothing this could possibly be about: no
 * account was bound (the pre-accounts ~/.claude setup, where there is no
 * second account to move to), or the bound account has since been deleted.
 * Every other outcome — including "nowhere to go" and "you switched this off" —
 * comes back as an event, because each of those is something the user needs
 * told rather than a no-op to swallow.
 */
export function handleUsageLimit(report: UsageLimitReport): AccountFailoverEvent | null {
  if (!report.accountId) return null;

  const from = accountsRepo.getAccount(report.accountId);
  if (!from) return null;

  // Bookkeeping happens even when failover is switched off. Knowing an account
  // is spent until 9pm is worth having on its own — the panel shows it, and it
  // stops that account being picked as somebody else's failover target.
  const resetAt = report.resetAt ?? new Date(Date.now() + accountsRepo.DEFAULT_COOLDOWN_MS);
  accountsRepo.markAccountLimited(from.id, resetAt);
  log.info(
    `[Failover] ${from.label} is out of quota until ${resetAt.toISOString()}` +
    `${report.resetAt ? ' (from the CLI message)' : ' (default window — the message named no reset)'}`
  );

  if (!isFailoverEnabled()) {
    return { reason: 'limit', from, to: null, sessionIds: [], resetAt, blocked: 'disabled' };
  }

  const to = nextHealthyAccount(from.id);
  if (!to) {
    log.warn(`[Failover] ${from.label} is spent and no other account is available.`);
    return { reason: 'limit', from, to: null, sessionIds: [], resetAt, blocked: 'no-healthy-account' };
  }

  // Every pty billing the spent account, not just the one that noticed. The
  // limit is the account's, so the others are already dead in the water; making
  // each wait to hit the wall itself would restart them one at a time, minutes
  // apart, for no gain.
  const stranded = new Set(
    Object.entries(report.liveAccounts)
      .filter(([, binding]) => binding?.accountId === from.id)
      .map(([sessionId]) => sessionId)
  );
  // The reporter belongs in the set even if its binding says otherwise — it is
  // the one session we have direct evidence about.
  stranded.add(report.sessionId);

  const sessionIds: string[] = [];
  for (const sessionId of stranded) {
    if (moveSession(sessionId, from, to)) sessionIds.push(sessionId);
  }

  log.info(
    `[Failover] Moved ${sessionIds.length} session(s) from ${from.label} to ${to.label}.`
  );
  return { reason: 'limit', from, to, sessionIds, resetAt };
}

/**
 * Point one session at `to`, remembering where it came from.
 *
 * The bookkeeping is written BEFORE the assignment and only when it is not
 * already there. Not overwriting matters for the second hop: an account that
 * fails A→B and later B→C should go home to A, not to B — B is just as spent,
 * and "home" is the assignment the user actually chose.
 *
 * @returns whether the session needs its pty respawned.
 */
function moveSession(sessionId: string, from: ClaudeAccount, to: ClaudeAccount): boolean {
  const session = sessionsRepo.getSession(sessionId);
  if (!session) return false;

  // The user already pointed this session somewhere else and it just hasn't
  // respawned yet — its pty is still billing the spent account, which is why it
  // showed up here at all. Overwriting that with our own choice would discard a
  // decision they made deliberately. Restarting it is still exactly right: the
  // respawn applies THEIR switch, which gets the session off the spent account
  // just the same.
  const assigned = resolveAccountForSession(sessionId);
  if (assigned && assigned.id !== from.id) return true;

  if (!session.failoverFromAccountId) {
    sessionsRepo.updateSession(sessionId, {
      failoverFromAccountId: from.id,
      // NULL here is meaningful: it says the session inherited its account from
      // its group, and going home means restoring that inheritance rather than
      // pinning it to whatever the group resolved to today.
      failoverPrevAccountId: session.claudeAccountId,
    });
  }

  // Routed through account-switch so the conversation transcript is carried
  // into the new account's config dir — without it the respawn's --resume finds
  // no such conversation and the session starts over empty.
  return assignSessionAccount(sessionId, to.id).affectedSessionIds.length > 0;
}

/**
 * A session waiting to go home, and the account it is waiting on.
 *
 * Fail-back exists because the point of a secondary account is to absorb an
 * outage, not to become the new home: left alone, one limited afternoon
 * permanently migrates every session onto the backup and the primary's quota
 * goes unused from then on.
 */
export interface FailbackCandidate {
  sessionId: string;
  home: ClaudeAccount;
}

/**
 * Sessions whose original account is healthy again.
 *
 * Also cleans up after an account that was deleted while sessions were parked
 * off it: there is no home to return to, so the bookkeeping is dropped rather
 * than left pointing at a row that no longer exists.
 */
export function failbackCandidates(now: Date = new Date()): FailbackCandidate[] {
  const candidates: FailbackCandidate[] = [];

  for (const session of sessionsRepo.getAllSessions()) {
    if (!session.failoverFromAccountId) continue;

    const home = accountsRepo.getAccount(session.failoverFromAccountId);
    if (!home) {
      clearFailoverRecord(session.id);
      continue;
    }
    if (!accountsRepo.isAccountHealthy(home, now)) continue;

    // The cooldown has run out. Drop it now so the account is a legitimate
    // failover target again even if this particular session never moves back.
    accountsRepo.clearAccountLimit(home.id);
    candidates.push({ sessionId: session.id, home });
  }

  return candidates;
}

/**
 * Whether a session can be moved back right now without anyone noticing.
 *
 * This is the whole reason fail-back is safe to do unprompted. Going home costs
 * a pty respawn, and a respawn in the middle of a turn throws away work in
 * flight — so it waits for a session that is demonstrably between turns. A
 * stopped session is the easiest case of all: it has no pty to interrupt and
 * picks the account up whenever it is next started.
 */
export function canFailBackNow(state: SessionState): boolean {
  return state === 'idle' || state === 'stopped';
}

/**
 * Send a session back to the account it was failed over from.
 *
 * @returns the event to report, or null when the session had nothing to undo.
 */
export function failBackSession(sessionId: string): AccountFailoverEvent | null {
  const session = sessionsRepo.getSession(sessionId);
  if (!session?.failoverFromAccountId) return null;

  const home = accountsRepo.getAccount(session.failoverFromAccountId);
  if (!home) {
    clearFailoverRecord(sessionId);
    return null;
  }

  const leaving = session.claudeAccountId
    ? accountsRepo.getAccount(session.claudeAccountId)
    : null;

  // Restore the ORIGINAL override, which may well be null — that is a session
  // that inherits from its group, and pinning it to the group's current account
  // would quietly convert an inherited assignment into a fixed one.
  const affected = assignSessionAccount(sessionId, session.failoverPrevAccountId);
  clearFailoverRecord(sessionId);

  log.info(`[Failover] ${sessionId} returned to ${home.label}.`);
  return {
    reason: 'failback',
    from: leaving,
    to: home,
    sessionIds: affected.affectedSessionIds,
    resetAt: null,
  };
}

/**
 * Forget that a session was ever moved.
 *
 * Called when the user assigns an account by hand: they have just said where
 * this session belongs, and a fail-back that later overrode that choice would
 * be the app arguing with them.
 */
export function clearFailoverRecord(sessionId: string): void {
  sessionsRepo.updateSession(sessionId, {
    failoverFromAccountId: null,
    failoverPrevAccountId: null,
  });
}

/**
 * Notification copy for one switch.
 *
 * Lives here, next to the policy, because the wording has to stay true to what
 * actually happened — "moved to Work" when nothing moved is the failure mode
 * this feature is most likely to produce, and it is the kind that is only
 * caught by keeping the sentence and the decision in the same file.
 */
export function describeFailover(event: AccountFailoverEvent): { title: string; body: string } {
  const sessions = event.sessionIds.length === 1
    ? '1 session'
    : `${event.sessionIds.length} sessions`;

  if (event.reason === 'failback') {
    return {
      title: `Back on ${event.to?.label ?? 'the original account'}`,
      body: `${sessions} returned now that its usage limit has lifted.`,
    };
  }

  const spent = event.from?.label ?? 'That account';
  const until = event.resetAt ? ` until ${formatResetTime(event.resetAt)}` : '';

  if (event.blocked === 'disabled') {
    return {
      title: `${spent} hit its usage limit`,
      body: `Automatic failover is off, so nothing moved. Held${until}.`,
    };
  }
  if (event.blocked === 'no-healthy-account') {
    const held = until ? `; ${spent} is held${until}` : '';
    return {
      title: `${spent} hit its usage limit`,
      body: `No other account is available${held}.`,
    };
  }

  // "moved to", not "moved over and resumed". A session whose CLI exited when
  // the quota ran out is reassigned but deliberately not restarted — starting a
  // session the user watched stop is not ours to do — so a claim about resuming
  // would be false for exactly the sessions the user is most likely to check.
  return {
    title: `Switched to ${event.to?.label ?? 'another account'}`,
    body: `${spent} hit its usage limit${until}. ${sessions} moved to ${event.to?.label ?? 'it'}.`,
  };
}

/** "9:30pm", or "Tue 9:30pm" when it is not today. */
function formatResetTime(resetAt: Date, now: Date = new Date()): string {
  const time = resetAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = resetAt.toDateString() === now.toDateString();
  if (sameDay) return time;
  return `${resetAt.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}
