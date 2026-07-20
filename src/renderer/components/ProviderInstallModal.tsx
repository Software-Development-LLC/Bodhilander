import React, { useCallback, useEffect, useState } from 'react';
import Terminal from './Terminal';
import './ProviderInstallModal.css';

/**
 * Runs a provider CLI's install command in a visible embedded terminal so the
 * user can watch it instead of copy-pasting into their own shell. The pty is
 * spawned by main (providers:run-install) before this mounts; the Terminal
 * attaches with externalPty and the pty's exit code is the install's.
 *
 * Used from Settings → Providers ("Install" on a missing CLI) and from the
 * session launch-failure banner ("Reinstall" on a broken CLI).
 */

interface ProviderInstallModalProps {
  providerName: string;
  command: string;
  ptyId: string;
  /** Called when the modal closes; succeeded is true iff the command exited 0. */
  onClose: (succeeded: boolean) => void;
}

export const ProviderInstallModal: React.FC<ProviderInstallModalProps> = ({
  providerName,
  command,
  ptyId,
  onClose,
}) => {
  const [exitCode, setExitCode] = useState<number | null>(null);

  useEffect(() => {
    return window.electronAPI.onPtyExit((id, code) => {
      if (id === ptyId) {
        setExitCode(code);
      }
    });
  }, [ptyId]);

  const handleClose = useCallback(() => {
    if (exitCode === null) {
      const confirmed = window.confirm(`Cancel the running install for ${providerName}?`);
      if (!confirmed) return;
    }
    // Kills the pty if it is still running; a no-op after exit.
    window.electronAPI.cancelProviderInstall(ptyId).catch(() => {});
    onClose(exitCode === 0);
  }, [exitCode, onClose, providerName, ptyId]);

  return (
    <div className="modal-overlay">
      <dialog
        open
        className="provider-install-modal"
        aria-labelledby="provider-install-title"
      >
        <h3 id="provider-install-title">Installing {providerName}</h3>
        <p className="hint">
          Running <code>{command}</code> in your shell. If the installer asks
          questions, answer them in the terminal below.
        </p>

        {exitCode === 0 && (
          <div className="result-banner success">
            Install finished. Close this window, then start (or restart) the session.
          </div>
        )}
        {exitCode !== null && exitCode !== 0 && (
          <div className="result-banner failure">
            The installer exited with code {exitCode}. Check its output above, then close and retry.
          </div>
        )}

        <div className="terminal-host">
          <Terminal
            sessionId={ptyId}
            cwd={window.electronAPI.homedir}
            launchClaude={false}
            externalPty={true}
            isActive={true}
          />
        </div>

        <div className="footer">
          <button className={exitCode === 0 ? 'primary' : ''} onClick={handleClose}>
            {exitCode === null ? 'Cancel install' : 'Close'}
          </button>
        </div>
      </dialog>
    </div>
  );
};
