import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClaudeAccount, LiveAccountBindings } from '../../shared/types';
import Terminal from './Terminal';
import { AccountChip } from './AccountChip';
import './ClaudeAccountsModal.css';

// -----------------------------------------------------------------------------
// Account panel — the account list, its row actions and the add-account flow.
// Rendered by Settings → Claude Accounts, the same way ProviderSettings renders
// <ProviderKeyVault /> inside a settings tab. Settings stops rendering it when
// it closes, so loading on mount is also "reload every time it is opened" — no
// isOpen plumbing needed. Reached from the app menu's "Claude Accounts…" item
// (menu:open-accounts), which deep-links Settings to this tab.
// -----------------------------------------------------------------------------

export const ClaudeAccountsPanel: React.FC = () => {
  const [accounts, setAccounts] = useState<ClaudeAccount[]>([]);
  const [liveAccounts, setLiveAccounts] = useState<LiveAccountBindings>({});
  const [loading, setLoading] = useState(false);
  const [loginFlow, setLoginFlow] = useState<{ account: ClaudeAccount; ptyId: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, live] = await Promise.all([
        window.electronAPI.listAccounts(),
        window.electronAPI.getLiveAccounts(),
      ]);
      setAccounts(list);
      setLiveAccounts(live);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const off = window.electronAPI.onAccountLoginCompleted(() => {
      refresh();
    });
    return off;
  }, [refresh]);

  // Ptys come and go while the panel is open — a session started, stopped, or
  // restarted to apply a switch — and a stale usage count is the one thing that
  // would make this panel less trustworthy than no count at all.
  useEffect(() => {
    return window.electronAPI.onPtyLiveAccount((sessionId, binding) => {
      setLiveAccounts(prev => {
        const next = { ...prev };
        if (binding) next[sessionId] = binding;
        else delete next[sessionId];
        return next;
      });
    });
  }, []);

  const handleAdd = useCallback(async (label: string) => {
    const result = await window.electronAPI.startAccountLogin(label);
    setLoginFlow(result);
    await refresh();
  }, [refresh]);

  const handleSetDefault = useCallback(async (id: string) => {
    await window.electronAPI.setDefaultAccount(id);
    await refresh();
  }, [refresh]);

  /**
   * Move an account up or down the failover queue.
   *
   * Buttons rather than drag-and-drop. The list is three or four rows on any
   * real setup, keyboard and screen-reader users get the same affordance as
   * everyone else for free, and the whole order is rewritten on each move so
   * an estate that was half-ranked comes out fully ranked.
   */
  const handleMove = useCallback(async (id: string, direction: -1 | 1) => {
    const index = accounts.findIndex(a => a.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= accounts.length) return;

    const reordered = [...accounts];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    // Optimistic: the reorder is instant and local, and a failed write is
    // corrected by the refresh that follows.
    setAccounts(reordered);
    await window.electronAPI.setAccountFallbackOrder(reordered.map(a => a.id));
    await refresh();
  }, [accounts, refresh]);

  const handleClearLimit = useCallback(async (id: string) => {
    await window.electronAPI.clearAccountLimit(id);
    await refresh();
  }, [refresh]);

  // The panel computes "N sessions are running on this account" two inches
  // above this button, and deleting removes the on-disk config dir out from
  // under those live ptys (#165). Withholding the number here while the dialog
  // reassures the user that "sessions themselves are kept" is the one place
  // that count actually had a job to do.
  const handleDelete = useCallback(async (id: string, label: string, runningSessions: number) => {
    const subject = runningSessions === 1 ? 'session is' : 'sessions are';
    const warning = runningSessions > 0
      ? `\n\n${runningSessions} running ${subject} `
        + `using this account right now. They keep running, but their account directory goes away `
        + `with it — restart them onto another account first if you need their conversations.`
      : '';
    const confirmed = window.confirm(
      `Delete account "${label}"?\n\nThis removes its saved credentials and unsets any sessions or `
      + `groups that were bound to it. Sessions themselves are kept.${warning}`
    );
    if (!confirmed) return;
    await window.electronAPI.deleteAccount(id);
    await refresh();
  }, [refresh]);

  const handleLoginDone = useCallback(async () => {
    setLoginFlow(null);
    await refresh();
  }, [refresh]);

  const handleLoginCancel = useCallback(async (deleteAccount: boolean) => {
    if (loginFlow) {
      await window.electronAPI.cancelAccountLogin(loginFlow.ptyId, deleteAccount);
    }
    setLoginFlow(null);
    await refresh();
  }, [loginFlow, refresh]);

  // The login pty is owned by this panel: <Terminal> attaches with
  // externalPty, so it never kills it, and nothing in main tears it down until
  // someone calls cancelAccountLogin. Our host can disappear mid-login without
  // routing through the buttons below — Settings closing on Escape while focus
  // has been tabbed onto a control behind the login overlay, a tab switch, an
  // App-level unmount — which would leave the pty running forever. Cancelling
  // from an unmount cleanup covers every one of those paths. deleteAccount is
  // false: an interrupted login is not an aborted one, so the (possibly empty)
  // account row survives and the user can retry. cancelLoginFlow no-ops on an
  // unknown ptyId, so racing the explicit Done/Abort handlers is harmless.
  const loginFlowRef = useRef<{ account: ClaudeAccount; ptyId: string } | null>(null);
  useEffect(() => {
    loginFlowRef.current = loginFlow;
  }, [loginFlow]);
  useEffect(() => () => {
    const pending = loginFlowRef.current;
    if (pending) {
      window.electronAPI.cancelAccountLogin(pending.ptyId, false).catch(() => {});
    }
  }, []);

  // Both empty states render the same box, so the only question is which
  // sentence goes in it — "still fetching" or "there are genuinely none".
  const emptyText = loading
    ? 'Loading…'
    : 'No accounts yet. Click "Add account" to log in for the first time.';

  return (
    <div className="claude-accounts-panel">
      <p className="subtitle">
        Register one or more Claude Max subscriptions. Each account gets its own isolated
        login, so sessions assigned to different accounts can run at the same time.
      </p>

      <FailoverSettings />

      {accounts.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        <ul className="account-list">
          {accounts.map((acc, index) => {
            // Live ptys, not DB assignments — an unapplied switch must not be
            // reported as usage, and this keeps the panel and the session
            // header telling the same story.
            const runningSessions = Object.values(liveAccounts)
              .filter(b => b.accountId === acc.id).length;
            return (
              <AccountRow
                key={acc.id}
                account={acc}
                runningSessions={runningSessions}
                position={index + 1}
                canMoveUp={index > 0}
                canMoveDown={index < accounts.length - 1}
                onMoveUp={() => handleMove(acc.id, -1)}
                onMoveDown={() => handleMove(acc.id, 1)}
                onClearLimit={() => handleClearLimit(acc.id)}
                onMakeDefault={() => handleSetDefault(acc.id)}
                onDelete={() => handleDelete(acc.id, acc.label, runningSessions)}
              />
            );
          })}
        </ul>
      )}

      <div className="panel-actions">
        <AddAccountButton onAdd={handleAdd} disabled={!!loginFlow} />
      </div>

      {/* Login runs a live pty, so it stays an overlay modal wherever the panel
          is rendered — a terminal has no business inside a settings tab body. */}
      {loginFlow && (
        <ClaudeAccountLoginModal
          account={loginFlow.account}
          ptyId={loginFlow.ptyId}
          onDone={handleLoginDone}
          onCancel={handleLoginCancel}
        />
      )}
    </div>
  );
};

// -----------------------------------------------------------------------------
// One account in the list. Pure — the panel above owns every fetch — so it can
// be rendered straight from a test without stubbing the account IPC surface.
// -----------------------------------------------------------------------------

export interface AccountRowProps {
  account: ClaudeAccount;
  /** Running ptys currently spawned under this account (#165). 0 renders no badge. */
  runningSessions: number;
  /** 1-based place in the failover queue (#207). */
  position: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Hand the account back before its recorded cooldown expires. */
  onClearLimit: () => void;
  onMakeDefault: () => void;
  onDelete: () => void;
}

/**
 * Whether a recorded cooldown is still in force.
 *
 * Decided against the clock here rather than trusted from the row, because
 * nothing sweeps the column when a limit expires — a stale `limitedUntil` is
 * the normal state of a healthy account, not a bug.
 */
export function isLimited(account: ClaudeAccount, now: Date = new Date()): boolean {
  return account.limitedUntil !== null && new Date(account.limitedUntil).getTime() > now.getTime();
}

/** "9:30 PM", or "Tue 9:30 PM" when it is not today. */
function formatReset(resetAt: Date, now: Date = new Date()): string {
  const time = resetAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (resetAt.toDateString() === now.toDateString()) return time;
  return `${resetAt.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/**
 * "Which of these am I actually using?" was unanswerable from this list (#165):
 * every row looked alike whether it had five sessions on it or none, so the
 * only way to find out what deleting an account would disturb was to delete it.
 *
 * The in-use pill answers it with a number rather than a tint, and is filled
 * where `default` is outlined, so the two read apart at a glance and still read
 * apart with colour removed entirely.
 */
export const AccountRow: React.FC<AccountRowProps> = ({
  account,
  runningSessions,
  position,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onClearLimit,
  onMakeDefault,
  onDelete,
}) => {
  const plural = runningSessions === 1 ? 'session' : 'sessions';
  const limited = isLimited(account);
  return (
    <li className={`account-row ${limited ? 'limited' : ''}`}>
      {/* The queue position is the whole point of the ordering, so it is text
          in the row and not a tooltip on an arrow. */}
      <span className="failover-position" aria-hidden="true">{position}</span>
      <AccountChip account={account} size="md" />
      {/* The status is a tag beside the address, not a replacement for it: the
          address is what says WHICH account this is, and the one surface where
          a signed-out account can be acted on is the one that must still name
          it. Only an explicit false speaks — undefined means nothing was read,
          and a working account may never be accused on a failed read. */}
      {account.loggedIn === false && (
        <span
          className="signed-out-tag"
          title="No completed login found in this account's config directory — log in again before using it"
          aria-label="Not signed in"
        >
          not signed in
        </span>
      )}
      {account.isDefault && <span className="default-tag">default</span>}
      {runningSessions > 0 && (
        <span
          className="in-use-tag"
          title={`${runningSessions} running ${runningSessions === 1 ? 'session is' : 'sessions are'} using this account right now`}
          aria-label={`In use by ${runningSessions} running ${plural}`}
        >
          in use · {runningSessions}
        </span>
      )}
      {limited && account.limitedUntil && (
        <span
          className="limited-tag"
          title="This account hit its usage limit. It won't be picked for failover until then."
        >
          limited · back {formatReset(new Date(account.limitedUntil))}
        </span>
      )}
      <div className="row-actions">
        <button
          className="move-btn"
          onClick={onMoveUp}
          disabled={!canMoveUp}
          title="Try this account earlier when another one runs out"
          aria-label={`Move ${account.label} up the failover order`}
        >
          ↑
        </button>
        <button
          className="move-btn"
          onClick={onMoveDown}
          disabled={!canMoveDown}
          title="Try this account later when another one runs out"
          aria-label={`Move ${account.label} down the failover order`}
        >
          ↓
        </button>
        {limited && (
          <button
            onClick={onClearLimit}
            title="Mark this account available again — use it if the reset time was a guess and your quota is already back"
          >
            Clear limit
          </button>
        )}
        {!account.isDefault && (
          <button onClick={onMakeDefault} title="Use as the default account when a group or session doesn't specify one">
            Make default
          </button>
        )}
        <button className="delete-btn" onClick={onDelete}>
          Delete
        </button>
      </div>
    </li>
  );
};

// -----------------------------------------------------------------------------
// Failover switches (#207).
// -----------------------------------------------------------------------------

/** Preference keys, matching account-failover.ts. Absent means enabled. */
const FAILOVER_PREF = 'accountFailoverEnabled';
const FAILBACK_PREF = 'accountFailbackEnabled';

/**
 * The two things a user might want to turn off about automatic switching.
 *
 * They are separate switches because they answer different worries. Failover
 * spends a second subscription without being asked; fail-back restarts a
 * session that was working fine. Somebody can reasonably want the first and
 * not the second, and collapsing them into one control would make refusing the
 * restart cost them the whole feature.
 */
const FailoverSettings: React.FC = () => {
  const [failover, setFailover] = useState(true);
  const [failback, setFailback] = useState(true);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getAllPreferences().then(prefs => {
      if (cancelled) return;
      setFailover(prefs[FAILOVER_PREF] !== 'false');
      setFailback(prefs[FAILBACK_PREF] !== 'false');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const toggle = (key: string, next: boolean, apply: (value: boolean) => void) => {
    apply(next);
    window.electronAPI.setPreference(key, next ? 'true' : 'false').catch(() => {});
  };

  return (
    <div className="failover-settings">
      <label className="failover-toggle">
        <input
          type="checkbox"
          checked={failover}
          onChange={e => toggle(FAILOVER_PREF, e.target.checked, setFailover)}
        />
        <span>
          <strong>Switch accounts when one hits its usage limit.</strong>{' '}
          Every session running on the spent account moves to the next one in the
          order below and resumes its conversation.
        </span>
      </label>
      <label className="failover-toggle">
        <input
          type="checkbox"
          checked={failback}
          disabled={!failover}
          onChange={e => toggle(FAILBACK_PREF, e.target.checked, setFailback)}
        />
        <span>
          <strong>Move them back when the limit lifts.</strong>{' '}
          Only while a session is idle, so a switch back never interrupts a turn
          in progress. Without this, sessions stay on the backup account.
        </span>
      </label>
    </div>
  );
};

// -----------------------------------------------------------------------------
// Add-account button — inline label prompt before starting the login flow.
// -----------------------------------------------------------------------------

const AddAccountButton: React.FC<{ onAdd: (label: string) => Promise<void>; disabled?: boolean }> = ({ onAdd, disabled }) => {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onAdd(trimmed);
      setLabel('');
      setEditing(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (!editing) {
    return (
      <button className="add-btn" disabled={disabled} onClick={() => setEditing(true)}>
        + Add account
      </button>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 6 }}>
      <input
        type="text"
        autoFocus
        aria-label="Account label"
        placeholder="Label (e.g. Personal)"
        value={label}
        onChange={e => setLabel(e.target.value)}
        style={{
          padding: '6px 10px',
          background: '#1e1e1e',
          border: '1px solid #3c3c3c',
          borderRadius: 4,
          color: '#d4d4d4',
          fontSize: 12,
          outline: 'none',
          minWidth: 160,
        }}
      />
      <button type="submit" className="add-btn" disabled={submitting || !label.trim()}>
        {submitting ? 'Starting…' : 'Start login'}
      </button>
      <button type="button" onClick={() => { setEditing(false); setLabel(''); }}>
        Cancel
      </button>
    </form>
  );
};

// -----------------------------------------------------------------------------
// Login modal — embeds a Terminal attached to the login pty, and reports the
// login as soon as main sees one land in the config dir. macOS also gets an
// explicit "I'm logged in" button, as the platform whose token store is the
// one main cannot read directly.
// -----------------------------------------------------------------------------

export interface ClaudeAccountLoginModalProps {
  account: ClaudeAccount;
  ptyId: string;
  onDone: () => void;
  onCancel: (deleteAccount: boolean) => void;
}

export interface LoginHintProps {
  completed: boolean;
  /** Whether main saw the login in the config dir, rather than being told. */
  verified: boolean;
  exited: boolean;
  isMac: boolean;
}

/**
 * What the overlay is allowed to claim. An unverified completion is the user
 * pressing the button before OAuth finished, and saying "signed in" there
 * contradicts the panel behind it, which reads the same config dir we just did.
 */
export const LoginHint: React.FC<LoginHintProps> = ({ completed, verified, exited, isMac }) => {
  if (completed && verified) {
    return <>Login detected{' — '}this account is signed in. You can close this window.</>;
  }
  if (completed) {
    return (
      <>
        Recorded{' — '}but no login was found in this account's config directory yet.
        If OAuth hasn't finished, run <code>/login</code> again before closing.
      </>
    );
  }
  if (exited) {
    return <>The login process exited before credentials were saved. Abort and try again, or close this window to keep the empty account.</>;
  }
  if (isMac) {
    return <>Run <code>/login</code> in the terminal below and complete OAuth in your browser. This window closes itself once the login lands; macOS keeps the tokens in Keychain, so click "I'm logged in" if it doesn't.</>;
  }
  return <>Run <code>/login</code> in the terminal below and complete OAuth in your browser. This window will close itself once your credentials are saved.</>;
};

export interface LoginBannerProps {
  completed: boolean;
  verified: boolean;
}

/**
 * The most emphatic thing the overlay says, extracted so its gate sits where a
 * test can hold it: only a login main found in the config dir may be called
 * saved, because the panel behind reads that same dir.
 */
export const LoginBanner: React.FC<LoginBannerProps> = ({ completed, verified }) => {
  if (!completed || !verified) return null;
  return <div className="completion-banner">Login saved. It's safe to close this window.</div>;
};

export const ClaudeAccountLoginModal: React.FC<ClaudeAccountLoginModalProps> = ({
  account,
  ptyId,
  onDone,
  onCancel,
}) => {
  const [completed, setCompleted] = useState(false);
  const [verified, setVerified] = useState(false);
  const [exited, setExited] = useState(false);
  const isMac = useMemo(() => window.electronAPI.platform === 'darwin', []);

  useEffect(() => {
    const offCompleted = window.electronAPI.onAccountLoginCompleted((data) => {
      if (data.accountId === account.id) {
        setCompleted(true);
        setVerified(data.verified);
      }
    });
    const offExited = window.electronAPI.onAccountLoginExited((data) => {
      if (data.accountId === account.id) {
        setExited(true);
      }
    });
    return () => {
      offCompleted();
      offExited();
    };
  }, [account.id]);

  const confirmMac = useCallback(async () => {
    await window.electronAPI.confirmAccountLoginMacOS(ptyId);
  }, [ptyId]);

  const handleClose = useCallback(() => {
    // Successful login: keep the account, just kill the pty.
    onDone();
    window.electronAPI.cancelAccountLogin(ptyId, false).catch(() => {});
  }, [onDone, ptyId]);

  const handleAbort = useCallback(() => {
    const confirmed = window.confirm(
      `Abort login for "${account.label}"? The account and its config directory will be deleted.`
    );
    if (!confirmed) return;
    onCancel(true);
  }, [onCancel, account.label]);

  return (
    <div className="modal-overlay" onClick={e => e.stopPropagation()}>
      <div
        className="claude-account-login-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claude-account-login-title"
      >
        <h3 id="claude-account-login-title">Log in to "{account.label}"</h3>
        <p className="hint">
          <LoginHint completed={completed} verified={verified} exited={exited} isMac={isMac} />
        </p>

        <LoginBanner completed={completed} verified={verified} />

        <div className="terminal-host">
          <Terminal
            sessionId={ptyId}
            cwd={window.electronAPI.homedir}
            launchClaude={true}
            externalPty={true}
            isActive={true}
          />
        </div>

        <div className="footer">
          <button className="danger" onClick={handleAbort}>Abort & delete</button>
          <div style={{ display: 'flex', gap: 8 }}>
            {isMac && !completed && !exited && (
              <button className="primary" onClick={confirmMac}>I'm logged in</button>
            )}
            <button className="primary" onClick={handleClose} disabled={!completed && !exited}>
              {completed ? 'Done' : exited ? 'Close' : 'Waiting…'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
