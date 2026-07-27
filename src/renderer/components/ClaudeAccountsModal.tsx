import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClaudeAccount } from '../../shared/types';
import Terminal from './Terminal';
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
  const [loading, setLoading] = useState(false);
  const [loginFlow, setLoginFlow] = useState<{ account: ClaudeAccount; ptyId: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.electronAPI.listAccounts();
      setAccounts(list);
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

  const handleAdd = useCallback(async (label: string) => {
    const result = await window.electronAPI.startAccountLogin(label);
    setLoginFlow(result);
    await refresh();
  }, [refresh]);

  const handleSetDefault = useCallback(async (id: string) => {
    await window.electronAPI.setDefaultAccount(id);
    await refresh();
  }, [refresh]);

  const handleDelete = useCallback(async (id: string, label: string) => {
    const confirmed = window.confirm(
      `Delete account "${label}"?\n\nThis removes its saved credentials and unsets any sessions or groups that were bound to it. Sessions themselves are kept.`
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

  return (
    <div className="claude-accounts-panel">
      <p className="subtitle">
        Register one or more Claude Max subscriptions. Each account gets its own isolated
        login, so sessions assigned to different accounts can run at the same time.
      </p>

      {loading && accounts.length === 0 ? (
        <div className="empty">Loading…</div>
      ) : accounts.length === 0 ? (
        <div className="empty">No accounts yet. Click "Add account" to log in for the first time.</div>
      ) : (
        <ul className="account-list">
          {accounts.map(acc => (
            <li key={acc.id} className="account-row">
              <span className="swatch" style={{ background: acc.color || '#888888' }} />
              <div className="label">
                <span className="name">{acc.label}</span>
                <span className="email">{acc.email || 'Not yet logged in'}</span>
              </div>
              {acc.isDefault && <span className="default-tag">default</span>}
              <div className="row-actions">
                {!acc.isDefault && (
                  <button onClick={() => handleSetDefault(acc.id)} title="Use as the default account when a group or session doesn't specify one">
                    Make default
                  </button>
                )}
                <button className="delete-btn" onClick={() => handleDelete(acc.id, acc.label)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
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
// Add-account button — inline label prompt before starting the login flow.
// -----------------------------------------------------------------------------

const AddAccountButton: React.FC<{ onAdd: (label: string) => Promise<void>; disabled?: boolean }> = ({ onAdd, disabled }) => {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
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
// Login modal — embeds a Terminal attached to the login pty. Auto-closes when
// the credentials file appears (Linux/Windows). On macOS, shows an explicit
// "I'm logged in" button since tokens go to Keychain.
// -----------------------------------------------------------------------------

interface ClaudeAccountLoginModalProps {
  account: ClaudeAccount;
  ptyId: string;
  onDone: () => void;
  onCancel: (deleteAccount: boolean) => void;
}

const ClaudeAccountLoginModal: React.FC<ClaudeAccountLoginModalProps> = ({
  account,
  ptyId,
  onDone,
  onCancel,
}) => {
  const [completed, setCompleted] = useState(false);
  const [exited, setExited] = useState(false);
  const isMac = useMemo(() => window.electronAPI.platform === 'darwin', []);

  useEffect(() => {
    const offCompleted = window.electronAPI.onAccountLoginCompleted((data) => {
      if (data.accountId === account.id) {
        setCompleted(true);
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
        // When the panel is hosted in Settings this modal is a DOM descendant of
        // the settings dialog, whose key handler closes on Escape and traps Tab.
        // Swallow keys here so a stray Escape doesn't tear the settings modal
        // out from under the user. Defence in depth only: it stops nothing once
        // focus leaves this subtree (the settings Tab trap cycles through the
        // account-panel controls behind this overlay), so the pty's actual
        // lifetime guarantee is the unmount cleanup in ClaudeAccountsPanel.
        onKeyDown={e => e.stopPropagation()}
      >
        <h3 id="claude-account-login-title">Log in to "{account.label}"</h3>
        <p className="hint">
          {completed ? (
            <>Login detected{' — '}credentials were saved to this account's isolated config directory. You can close this window.</>
          ) : exited ? (
            <>The login process exited before credentials were saved. Abort and try again, or close this window to keep the empty account.</>
          ) : isMac ? (
            <>Run <code>/login</code> in the terminal below and complete OAuth in your browser. Because macOS stores tokens in Keychain, click "I'm logged in" once you see "Logged in" in the terminal.</>
          ) : (
            <>Run <code>/login</code> in the terminal below and complete OAuth in your browser. This window will close itself once your credentials are saved.</>
          )}
        </p>

        {completed && <div className="completion-banner">Login saved. It's safe to close this window.</div>}

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
