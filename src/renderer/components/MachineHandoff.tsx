import React, { useCallback, useEffect, useState } from 'react';
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

  const prepare = useCallback(async () => {
    setBusy(true);
    setError(null);
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
        <div className="handoff-phrase" role="group" aria-label="Recovery phrase">
          <p className="handoff-phrase-lead">
            Write this down before you close it. It is the only thing that opens the bundle, and it is
            not stored anywhere — not here, and not on the relay.
          </p>
          <p className="handoff-phrase-words">{phrase}</p>
          <p className="handoff-phrase-detail">{detail}</p>
          <div className="handoff-actions">
            <button className="settings-button" onClick={() => void navigator.clipboard?.writeText(phrase)}>
              Copy Phrase
            </button>
            <button className="settings-button" onClick={() => setPhrase(null)}>
              I have written it down
            </button>
          </div>
        </div>
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

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.handoffPeek().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const offer = state?.offer;
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
    <div className="modal-overlay">
      <div className="modal-content handoff-offer" role="dialog" aria-modal="true" aria-labelledby="handoff-offer-title">
        <div className="modal-header">
          <h2 id="handoff-offer-title">Restore from {from}?</h2>
        </div>
        <div className="modal-body">
          <p>
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
        </div>
      </div>
    </div>
  );
};
