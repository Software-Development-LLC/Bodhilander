import React from 'react';
import { ClaudeAccount } from '../../shared/types';
import { AccountChip } from './AccountChip';

export interface SessionAccountIndicatorProps {
  /**
   * Account the RUNNING pty actually launched under. null means it launched
   * under the legacy ~/.claude login, or under an account that has since been
   * deregistered (see liveAccountUnknown). Only meaningful when isRunning.
   */
  liveAccount: ClaudeAccount | null;
  /** Account the session will run under per session → group → default. null = legacy ~/.claude. */
  assignedAccount: ClaudeAccount | null;
  /** True when main reports a live pty binding for this session. */
  isRunning: boolean;
  /** True when the live pty's account id is no longer in the accounts list (deleted mid-session). */
  liveAccountUnknown: boolean;
  /** True when the assignment is the session's own override rather than group/default. Tooltip only. */
  isOverride: boolean;
  /** Restart the pty so the pending assignment takes effect. Called only from the Apply button. */
  onApplySwitch: () => void;
}

/**
 * Name an account the same way the chip does, for the strings the chip cannot
 * carry (#165).
 *
 * The pending line and the Apply button describe the OTHER side of a switch,
 * and naming it by label alone puts them back in the ambiguity emails were
 * added to remove: with two accounts both called "Work", "still running under
 * Work / switching to Work / apply the switch to Work" says nothing at all.
 */
function nameOf(account: ClaudeAccount | null): string {
  if (!account) return 'the default login';
  return account.email ? `${account.label} (${account.email})` : account.label;
}

/**
 * Is this session assigned to an account its pty is not running under (#165)?
 *
 * Exported because the sidebar has to answer the same question: it is the only
 * place the account of a session the user cannot see is named at all, and two
 * surfaces disagreeing about which login is in use is the confusion this
 * feature exists to end.
 *
 * liveAccountUnknown is its own trigger, not just an id mismatch: a pty running
 * under a deleted account resolves to liveAccount=null, and if the session has
 * no assignment either, comparing ids alone reports "no pending switch" and
 * withholds the way out — leaving the user told their account was removed and
 * given nothing to do about it. That is the one case where this matters most.
 */
export function isSwitchPending(state: {
  liveAccount: ClaudeAccount | null;
  assignedAccount: ClaudeAccount | null;
  isRunning: boolean;
  liveAccountUnknown: boolean;
}): boolean {
  return state.isRunning
    && (state.liveAccountUnknown
      || (state.liveAccount?.id ?? null) !== (state.assignedAccount?.id ?? null));
}

/**
 * Which Claude account this session is actually running on (#165).
 *
 * CLAUDE_CONFIG_DIR is baked into a pty when it spawns, so the database
 * assignment — and the session → group → default chain behind it — describes
 * what a session WILL run under, never what it IS running under. After an
 * account is switched on a live session the two disagree until the pty
 * respawns, and reporting the assignment as fact is exactly what made #164's
 * first symptom look like nothing had happened: the user picked a new account,
 * every surface immediately agreed, and the old account kept being billed.
 *
 * So this names the live binding and, when the two differ, says so and offers
 * the restart that closes the gap. Nothing here is signalled by colour or by a
 * glyph alone, and nothing is phrased as an operation in progress: "Switching
 * to Personal" described a state that was in fact stalled — a user who read it
 * as "in flight, wait for it" waited forever, and one who read it as done
 * stopped watching. It reads "Restart to use Personal", which is a fact and an
 * instruction, with the button that carries it out beside it.
 *
 * Presentational by construction: every account is resolved by the caller and
 * arrives as a prop. The header is mounted for every open session at once, so
 * a component that fetched here would fan out one request per session.
 */
export const SessionAccountIndicator: React.FC<SessionAccountIndicatorProps> = ({
  liveAccount,
  assignedAccount,
  isRunning,
  liveAccountUnknown,
  isOverride,
  onApplySwitch,
}) => {
  const pending = isSwitchPending({ liveAccount, assignedAccount, isRunning, liveAccountUnknown });
  const assignedName = nameOf(assignedAccount);
  const assignedScope = isOverride ? 'session override' : 'inherited from group or default';

  // The pty is on a login the user deleted, so there is no row left to name it
  // with. Saying so is more use than the legacy-login label.
  const runningEmptyLabel = liveAccountUnknown ? 'Removed account' : undefined;

  if (!isRunning) {
    return (
      <span className="header-account is-idle">
        <AccountChip
          account={assignedAccount}
          size="sm"
          detail={`will run under this account when started (${assignedScope})`}
          announceDetail
        />
      </span>
    );
  }

  if (!pending) {
    return (
      <span className="header-account">
        <AccountChip
          account={liveAccount}
          size="sm"
          detail="running under this account"
          announceDetail
          emptyLabel={runningEmptyLabel}
        />
      </span>
    );
  }

  return (
    <span className="header-account is-pending">
      <AccountChip
        account={liveAccount}
        size="sm"
        detail="still running under this account"
        announceDetail
        emptyLabel={runningEmptyLabel}
      />
      <span
        className="header-account-pending"
        title={`Assigned to ${assignedName} (${assignedScope}) — not in effect until this session restarts`}
      >
        Restart to use {assignedName}
      </span>
      <button
        type="button"
        className="header-account-apply"
        onClick={onApplySwitch}
        title={`Restart this session now so it runs under ${assignedName}`}
        aria-label={`Restart now to run under ${assignedName}`}
      >
        Apply
      </button>
    </span>
  );
};

export default SessionAccountIndicator;
