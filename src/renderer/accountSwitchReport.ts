import { AccountSwitchResult, ClaudeAccount } from '../shared/types';

/**
 * A sentence about an account switch, split around the account it names.
 *
 * The chip is a React element and the rest is text, so the two halves travel
 * separately; keeping this file free of JSX is what lets every branch below be
 * asserted directly rather than through a render.
 */
export interface AccountSwitchReport {
  /** 'muted' when nothing changed at all — a confirmation, not news. */
  tone: 'info' | 'muted';
  /** Text before the account chip. */
  prefix: string;
  /** The account the target now resolves to. */
  account: ClaudeAccount | null;
  /** Text after the account chip. */
  suffix: string;
}

export interface SwitchContext {
  /** The session or group the click was on, for naming it back. */
  targetName: string;
  /** The account id the user picked; null = "inherit"/"use default". */
  pickedAccountId: string | null;
  /** Of the sessions that changed account, those with a pty to replace. */
  liveAffected: string[];
}

/**
 * What to say after a session's account was switched (#214).
 *
 * Returns null in the one case that speaks for itself: a live session whose
 * account moved is about to visibly restart, and a notice saying so would be
 * narrating something the user can already see.
 *
 * Every other outcome reaches the user as an unchanged screen. The click did
 * land, the row did get written, and saying nothing is indistinguishable from
 * a menu that ignored the click — which is what sends someone back to the menu
 * to try again, and is how a group ends up mis-clicked onto the default (#213).
 */
export function reportSessionSwitch(
  result: AccountSwitchResult,
  ctx: SwitchContext,
): AccountSwitchReport | null {
  const { account } = result.outcome;
  const name = quoted(ctx.targetName);

  if (result.affectedSessionIds.length > 0) {
    if (ctx.liveAffected.length > 0) return null; // The restart is the report.
    return {
      tone: 'info',
      prefix: `${name} will use `,
      account,
      suffix: ' when you start it.',
    };
  }

  // Nothing moved, because it was already there. Which of the two ways the
  // user got here matters: picking the account explicitly pins the session to
  // it, and that has a consequence they did not ask for and cannot see.
  if (ctx.pickedAccountId !== null) {
    return {
      tone: 'muted',
      prefix: `${name} was already using `,
      account,
      suffix: ' — it is pinned to that account, so changing the group’s'
        + ' account will no longer move this session.',
    };
  }

  return {
    tone: 'muted',
    prefix: `${name} now follows its group, which uses `,
    account,
    suffix: ' — the same account it was already on, so nothing moved.',
  };
}

/**
 * What to say after a group's account was switched (#214).
 *
 * Composes rather than picks: a group switch can do several things at once —
 * move some sessions, move others that have no pty to restart, and fail to
 * move the ones pinned to their own account — and the user needs all of them,
 * not the first one that happens to apply.
 *
 * The restart prompt covers only the sessions it is about to restart. Every
 * other fact lands here, which is why this returns null in exactly one case:
 * the prompt is showing and there is nothing left for it to have missed.
 */
export function reportGroupSwitch(
  result: AccountSwitchResult,
  ctx: SwitchContext,
): AccountSwitchReport | null {
  const { account, unchangedSessionIds, overriddenSessionIds } = result.outcome;

  const clauses: string[] = [];

  // Sessions that moved but have no pty to replace. The assignment is real and
  // takes effect the moment they start — worth saying precisely because there
  // is nothing on screen to suggest it.
  const stoppedMovers = result.affectedSessionIds.length - ctx.liveAffected.length;
  if (stoppedMovers > 0) {
    clauses.push(`${count(stoppedMovers)} in it ${plural(stoppedMovers, 'is', 'are')} stopped and `
      + `will use it when you start ${plural(stoppedMovers, 'it', 'them')}`);
  }

  // A group switch cannot move a session pinned to its own account. That is
  // the design, but it is invisible from the group menu, so a switch that
  // leaves sessions behind looks broken rather than declined.
  const stuck = describeStuck(unchangedSessionIds, overriddenSessionIds);
  if (stuck) {
    clauses.push(`${stuck}, so ${plural(unchangedSessionIds.length, 'it', 'they')} did not move`);
  }

  // The prompt about to appear already names what it is restarting. Only stay
  // silent if that is genuinely the whole story.
  if (ctx.liveAffected.length > 0 && clauses.length === 0) return null;

  return {
    // Muted only when the switch moved nothing anywhere — a confirmation
    // rather than news.
    tone: result.affectedSessionIds.length === 0 ? 'muted' : 'info',
    prefix: `${quoted(ctx.targetName)} now uses `,
    account,
    suffix: clauses.length === 0 ? '.' : `. ${sentence(clauses)}.`,
  };
}

/** "2 sessions were already on it and 1 has its own account", or '' if neither. */
function describeStuck(unchanged: string[], overridden: string[]): string {
  const pinned = overridden.length;
  const already = unchanged.length - pinned;

  const own = `${plural(pinned, 'has', 'have')} ${plural(pinned, 'its', 'their')} own account`;

  // Both reasons: the first clause establishes "sessions", so the second says
  // a bare number rather than repeating the noun.
  if (already > 0 && pinned > 0) {
    return `${count(already)} ${plural(already, 'was', 'were')} already on it and ${pinned} ${own}`;
  }
  if (already > 0) return `${count(already)} ${plural(already, 'was', 'were')} already on it`;
  if (pinned > 0) return `${count(pinned)} ${own}`;
  return '';
}

/** Joins independent clauses into one sentence, capitalised. */
function sentence(clauses: string[]): string {
  const joined = clauses.join('; ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

function count(n: number): string {
  return n === 1 ? '1 session' : `${n} sessions`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Curly quotes: these names are user-typed and land mid-sentence. */
function quoted(name: string): string {
  return `“${name}”`;
}
