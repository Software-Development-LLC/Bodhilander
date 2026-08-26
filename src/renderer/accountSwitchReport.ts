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
      suffix: ' — it is now pinned to that account, so changing the group’s'
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
 * Returns null when the restart prompt is about to appear: that prompt already
 * names what happened, and two things saying it at once is worse than one.
 */
export function reportGroupSwitch(
  result: AccountSwitchResult,
  ctx: SwitchContext,
): AccountSwitchReport | null {
  if (ctx.liveAffected.length > 0) return null; // The restart prompt is the report.

  const { account, unchangedSessionIds, overriddenSessionIds } = result.outcome;
  const prefix = `${quoted(ctx.targetName)} now uses `;

  // Sessions that moved but have no pty to replace: the assignment is real and
  // takes effect the moment they start, which is worth saying precisely
  // because there is nothing on screen to suggest it.
  if (result.affectedSessionIds.length > 0) {
    return {
      tone: 'info',
      prefix,
      account,
      suffix: `. ${count(result.affectedSessionIds.length)} in it `
        + `${plural(result.affectedSessionIds.length, 'is', 'are')} stopped and will use it `
        + 'when you start ' + plural(result.affectedSessionIds.length, 'it', 'them') + '.',
    };
  }

  if (unchangedSessionIds.length === 0) {
    return { tone: 'info', prefix, account, suffix: '.' };
  }

  // A group switch cannot move a session pinned to its own account. That is
  // the design, but it is invisible from the group menu, so a switch that
  // moves nothing looks broken rather than declined.
  const pinned = overriddenSessionIds.length;
  const already = unchangedSessionIds.length - pinned;

  return {
    tone: 'muted',
    prefix,
    account,
    suffix: `. ${describeStuck(already, pinned)}, so nothing moved.`,
  };
}

/** "2 sessions were already on it and 1 has its own account" */
function describeStuck(already: number, pinned: number): string {
  const parts: string[] = [];
  if (already > 0) {
    parts.push(`${count(already)} ${plural(already, 'was', 'were')} already on it`);
  }
  if (pinned > 0) {
    parts.push(
      `${count(pinned)} ${plural(pinned, 'has', 'have')} ${plural(pinned, 'its', 'their')} own account`,
    );
  }
  return parts.join(' and ');
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
