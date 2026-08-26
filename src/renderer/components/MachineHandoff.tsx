import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HandoffOfferState, PortableImportResult } from '../../shared/types';
import './MachineHandoff.css';

/**
 * The two halves of moving a machine. `HandoffPreparePanel` shows a recovery
 * phrase nothing can reproduce, so it stays up until dismissed rather than
 * passing in a toast; `HandoffRestoreOffer` is the other end of the trip.
 */

function words(phrase: string): number {
  return phrase.split(/[^a-zA-Z]+/).filter((w) => w.length > 0).length;
}

export const HandoffPreparePanel: React.FC = () => {
  const [busy, setBusy] = useState(false);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  const prepare = useCallback(async () => {
    setBusy(true);
    setError(null);
    setCopied('idle');
    try {
      const result = await window.electronAPI.handoffPrepare();
      if (!result.success) {
        if (result.error && result.error !== 'Handoff cancelled') setError(result.error);
        return;
      }
      setPhrase(result.phrase ?? null);
      setDetail(
        `${result.sizeLabel ?? 'The bundle'} — ${result.groupCount ?? 0} group(s), ` +
          `${result.sessionCount ?? 0} session(s).`,
      );
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="handoff-prepare">
      <button className="settings-button" onClick={prepare} disabled={busy}>
        {busy ? 'Preparing…' : 'Send to Another Machine…'}
      </button>

      {error && (
        <p className="handoff-error" role="alert">
          {error}
        </p>
      )}

      {phrase && (
        <section className="handoff-phrase" aria-label="Recovery phrase">
          <p className="handoff-phrase-lead">
            Write this down before you close it. It is the only thing that opens the bundle, and it is
            not stored anywhere — not here, and not on the relay.
          </p>
          <p className="handoff-phrase-words">{phrase}</p>
          <p className="handoff-phrase-detail">{detail}</p>
          {copied === 'failed' && (
            <p className="handoff-error" role="alert">
              Could not reach the clipboard. Copy the phrase from the screen before closing this.
            </p>
          )}
          <div className="handoff-actions">
            <button
              className="settings-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(phrase);
                  setCopied('done');
                } catch {
                  setCopied('failed');
                }
              }}
            >
              {copied === 'done' ? 'Copied' : 'Copy Phrase'}
            </button>
            <button className="settings-button" onClick={() => setPhrase(null)}>
              I have written it down
            </button>
          </div>
        </section>
      )}
    </div>
  );
};

export interface HandoffRestoreOfferProps {
  /** Run once the restore lands, to pick up everything that just arrived. */
  onRestored: () => void;
}

export const HandoffRestoreOffer: React.FC<HandoffRestoreOfferProps> = ({ onRestored }) => {
  const [state, setState] = useState<HandoffOfferState | null>(null);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Undefined is "never asked". Null is a real answer, and the one a machine
    // gives at launch, before anybody has signed in on it.
    let askedFor: string | null | undefined;

    const peek = (machineId: string | null) => {
      if (askedFor === machineId) return;
      askedFor = machineId;
      void window.electronAPI.handoffPeek().then((next) => {
        if (!cancelled) setState(next);
      });
    };

    void window.electronAPI.relayGetStatus().then((status) => peek(status.machineId));
    // Linking is what makes a bundle reachable, and it happens well after
    // launch. Without this the offer waits for a restart nothing asks for.
    const off = window.electronAPI.onRelayStatus((status) => peek(status.machineId));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const offer = state?.offer;

  // Opened here rather than left to `open`, because only `showModal()` makes
  // the rest of the page inert and traps focus — and this asks for a phrase
  // that must be typed into it and nowhere else.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, [offer?.id]);

  // Escape would close the dialog and leave the offer neither restored nor
  // declined — visibly gone, with nothing recorded. "Not Now" is durable and
  // must not be something a stray keypress can spend, so neither answer is
  // reachable except by its button. This is what the overlay did before.
  const keepOpen = (e: React.SyntheticEvent<HTMLDialogElement>) => e.preventDefault();

  if (!offer || state?.declined) return null;

  const decline = async () => {
    await window.electronAPI.handoffDecline(offer.id);
    setState({ offer, declined: true });
  };

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      const result: PortableImportResult = await window.electronAPI.handoffRestore(phrase);
      if (result.success) {
        onRestored();
        return;
      }
      // The bundle is untouched on any failure, so the phrase can be retried.
      if (result.error !== 'Import cancelled') setError(result.error ?? 'The restore did not finish.');
    } finally {
      setBusy(false);
    }
  };

  const from = offer.sourceMachineName ?? 'your other machine';

  return (
    <dialog ref={dialogRef} className="handoff-offer" aria-labelledby="handoff-offer-title" onCancel={keepOpen}>
      <h3 id="handoff-offer-title">Restore from {from}?</h3>

      <p className="handoff-offer-lead">
        {from} left {state?.sizeLabel ?? 'its state'} here for you — groups, sessions, history,
        settings and conversation transcripts. Enter the recovery phrase it showed you.
      </p>

      <label className="handoff-field" htmlFor="handoff-phrase-input">
        Recovery phrase
      </label>
      <textarea
        id="handoff-phrase-input"
        className="handoff-input"
        rows={3}
        spellCheck={false}
        autoFocus
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        aria-describedby="handoff-phrase-count"
      />
      <p id="handoff-phrase-count" className="handoff-phrase-detail">
        {words(phrase)} of 18 words
      </p>

      {error && (
        <p className="handoff-error" role="alert">
          {error}
        </p>
      )}

      <div className="handoff-actions">
        <button className="btn primary" onClick={restore} disabled={busy || words(phrase) === 0}>
          {busy ? 'Restoring…' : 'Restore'}
        </button>
        <button className="btn" onClick={decline} disabled={busy}>
          Not Now
        </button>
      </div>
      <p className="handoff-phrase-detail">
        Declining keeps the bundle on the relay until it expires; you will not be asked about this
        one again.
      </p>
    </dialog>
  );
};
