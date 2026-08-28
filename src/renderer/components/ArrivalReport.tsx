import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ArrivalReport, ClaudeAccount } from '../../shared/types';
import { ClaudeAccountLoginModal } from './ClaudeAccountsModal';
import { accountsNeedingSignIn } from '../../shared/arrival';
import './ArrivalReport.css';

/**
 * What the last restore left for a person to finish (#202).
 *
 * The counts are the easy half. This exists for the other half — sessions
 * whose folder is not on this machine, accounts whose credentials never left
 * the old one, and provider keys that were deliberately not carried. None of
 * that is inferable from "restored 12 sessions", and the user should not have
 * to discover it one failed launch at a time.
 *
 * It is opened again from Settings rather than being a one-shot dialog,
 * because none of this is work anybody finishes in the thirty seconds after an
 * import.
 */

export interface ArrivalReportViewProps {
  report: ArrivalReport;
  /** Close and keep it — the default, since the work is rarely done yet. */
  onClose: () => void;
  /** Close and forget it. */
  onDismiss: () => void;
  /** Run the sign-in flow for one restored account. */
  onSignIn: (accountId: string) => Promise<void> | void;
  /** Point one session at a folder on this machine. */
  onRelink: (sessionId: string, currentDir: string) => Promise<void> | void;
  /** Surfaced above the actions when something the report tried did not work. */
  error?: string | null;
}

function relinkLabel(count: number): string {
  return count === 1 ? '1 session needs its folder' : `${count} sessions need their folder`;
}

export const ArrivalReportView: React.FC<ArrivalReportViewProps> = ({
  report,
  onClose,
  onDismiss,
  onSignIn,
  onRelink,
  error,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [relinking, setRelinking] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // Escape closes and keeps, which is the same as the Close button. Nothing
  // here is destructive, so unlike the handoff offer there is no reason to
  // refuse it — but it must not be mistaken for "done with this".
  const handleCancel = useCallback(
    (e: React.SyntheticEvent<HTMLDialogElement>) => {
      e.preventDefault();
      onClose();
    },
    [onClose],
  );

  const needSignIn = accountsNeedingSignIn(report);
  const from = report.sourceLabel ?? (report.via === 'handoff' ? 'your other machine' : 'a transfer bundle');
  const when = new Date(report.restoredAt);
  const whenLabel = Number.isNaN(when.getTime()) ? null : when.toLocaleString();

  return (
    <dialog ref={dialogRef} className="arrival-report" aria-labelledby="arrival-title" onCancel={handleCancel}>
      <h3 id="arrival-title">What arrived from {from}</h3>
      {whenLabel && <p className="arrival-when">Restored {whenLabel}</p>}

      <section className="arrival-counts" aria-label="What was restored">
        <p>
          <strong>{report.groups}</strong> group(s) and <strong>{report.sessions}</strong> session(s),
          with <strong>{report.transcripts}</strong> conversation transcript(s).
        </p>
        <p>
          <strong>{report.resumable}</strong> of those session(s) can start on this machine.
        </p>
        {(report.skippedGroups > 0 || report.skippedSessions > 0) && (
          <p className="arrival-muted">
            {report.skippedGroups} group(s) and {report.skippedSessions} session(s) were already here and
            were left alone.
          </p>
        )}
      </section>

      {report.needsRelink.length > 0 && (
        <section className="arrival-section" aria-label="Sessions needing a folder">
          <h4>{relinkLabel(report.needsRelink.length)}</h4>
          <p className="arrival-muted">
            These arrived pointing at a folder that is not on this machine. Point each one at its
            folder here and it becomes launchable again.
          </p>
          <ul className="arrival-list">
            {report.needsRelink.map((item) => (
              <li key={item.sessionId}>
                <span className="arrival-name">{item.name}</span>
                <span className="arrival-path">{item.workingDir}</span>
                <button
                  className="btn"
                  disabled={relinking !== null}
                  onClick={async () => {
                    setRelinking(item.sessionId);
                    try {
                      await onRelink(item.sessionId, item.workingDir);
                    } finally {
                      setRelinking(null);
                    }
                  }}
                >
                  {relinking === item.sessionId ? 'Setting…' : 'Set Folder…'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {needSignIn.length > 0 && (
        <section className="arrival-section" aria-label="Accounts needing a sign-in">
          <h4>{needSignIn.length} account(s) need signing in</h4>
          <p className="arrival-muted">
            Credentials never leave the machine that holds them, so these came across as accounts
            without logins.
          </p>
          <ul className="arrival-list">
            {needSignIn.map((account) => (
              <li key={account.accountId}>
                <span className="arrival-name">{account.label}</span>
                <button
                  className="btn"
                  disabled={signingIn !== null}
                  onClick={async () => {
                    setSigningIn(account.accountId);
                    try {
                      await onSignIn(account.accountId);
                    } finally {
                      setSigningIn(null);
                    }
                  }}
                >
                  {signingIn === account.accountId ? 'Opening…' : 'Sign In'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.providersNeedingKeys.length > 0 && (
        <section className="arrival-section" aria-label="Provider keys to re-enter">
          <h4>{report.providersNeedingKeys.length} provider key(s) to re-enter</h4>
          <p className="arrival-muted">
            API keys are sealed to the keychain of the machine that stored them and were not carried.
            Add them again under Settings → Providers.
          </p>
          <ul className="arrival-list">
            {report.providersNeedingKeys.map((providerId) => (
              <li key={providerId}>
                <span className="arrival-name">{providerId}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p className="arrival-error" role="alert">
          {error}
        </p>
      )}

      <div className="arrival-actions">
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
        {/* Keeping it is the default; this is the way to say the work is done. */}
        <button className="btn" onClick={onDismiss}>
          Done — Don&apos;t Show Again
        </button>
      </div>
    </dialog>
  );
};

export interface ArrivalReportProps {
  /** Null closes it. The owner decides when it is worth raising. */
  report: ArrivalReport | null;
  onClosed: () => void;
}

/**
 * The report wired to the main process — loading is the owner's job.
 *
 * Signing in raises the same `ClaudeAccountLoginModal` the accounts panel
 * does, over the top of the report. `resumeAccountLogin` spawns a live pty and
 * hands back its id; without a terminal attached to that id there is nowhere
 * for the user to complete the OAuth flow, and the button would look like it
 * did nothing while leaving a pty running.
 */
export const ArrivalReportModal: React.FC<ArrivalReportProps> = ({ report, onClosed }) => {
  const [loginFlow, setLoginFlow] = useState<{ account: ClaudeAccount; ptyId: string } | null>(null);
  /**
   * The report as it stands after any relinking done here. Main rewrites the
   * kept copy and hands back what it stored, so this redraws from the record
   * rather than from a guess at what the record now says.
   */
  const [live, setLive] = useState(report);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setLive(report), [report]);

  const endLogin = useCallback(
    async (cancel: boolean) => {
      // Cancelling never deletes: this account is the user's, brought back by a
      // restore, and an interrupted sign-in is not a reason to lose it.
      if (cancel && loginFlow) await window.electronAPI.cancelAccountLogin(loginFlow.ptyId, false);
      setLoginFlow(null);
    },
    [loginFlow],
  );

  if (!live) return null;
  return (
    <>
      <ArrivalReportView
        report={live}
        onClose={onClosed}
        onDismiss={async () => {
          await window.electronAPI.arrivalDismiss();
          onClosed();
        }}
        onSignIn={async (accountId) => {
          setLoginFlow(await window.electronAPI.resumeAccountLogin(accountId));
        }}
        error={error}
        onRelink={async (sessionId, currentDir) => {
          setError(null);
          try {
            // Opened at the folder the session is looking for. On a restore
            // across machines that path does not exist, and the picker falls
            // back on its own rather than refusing to open.
            const chosen = await window.electronAPI.selectDirectory(currentDir || undefined);
            if (!chosen) return;
            // The row goes when main says it has gone. Deliberately not closed
            // when the last one is resolved: the counts are still worth
            // reading, and a dialog that vanishes as you finish with it reads
            // as a crash. It stops being *raised* on the next launch instead.
            const next = await window.electronAPI.arrivalResolveRelink(sessionId, chosen);
            if (next) setLive(next);
          } catch (err) {
            // Without this the rejection is unhandled, the button quietly
            // re-enables, and the row stays put with nothing said — which
            // reads as the button not working.
            setError(err instanceof Error ? err.message : 'That folder could not be set.');
          }
        }}
      />

      {loginFlow && (
        <ClaudeAccountLoginModal
          account={loginFlow.account}
          ptyId={loginFlow.ptyId}
          onDone={() => void endLogin(false)}
          onCancel={() => void endLogin(true)}
        />
      )}
    </>
  );
};
