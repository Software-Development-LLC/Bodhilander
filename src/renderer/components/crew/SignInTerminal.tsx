import React from 'react';
import Terminal from '../Terminal';
import { LoginHint } from '../ClaudeAccountsModal';
import '../ClaudeAccountsModal.css';

export const AppLoginTerminal: React.FC<{ ptyId: string }> = ({ ptyId }) => (
  <Terminal sessionId={ptyId} cwd={window.electronAPI.homedir} launchClaude={true} externalPty={true} isActive={true} />
);

export interface SignInTerminalProps {
  accountLabel: string;
  ptyId: string;
  LoginTerminal: React.FC<{ ptyId: string }>;
  onCancel: () => void;
}

/** The account's login pty, shown while Crew's Sign in again waits for it; it closes when the sign in ends. */
export const SignInTerminal: React.FC<SignInTerminalProps> = ({ accountLabel, ptyId, LoginTerminal, onCancel }) => (
  <div className="modal-overlay">
    <dialog open className="claude-account-login-modal crew-sign-in" aria-modal="true" aria-labelledby="crew-sign-in-title">
      <h3 id="crew-sign-in-title">Sign in to {accountLabel}</h3>
      <p className="hint">
        <LoginHint completed={false} verified={false} exited={false} isMac={false} />
      </p>
      <div className="terminal-host">
        <LoginTerminal ptyId={ptyId} />
      </div>
      <div className="footer">
        <button type="button" onClick={onCancel}>
          Cancel sign in
        </button>
      </div>
    </dialog>
  </div>
);
