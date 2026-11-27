import React, { useState } from 'react';
import type { CrewHireSummary, CrewLinkView, CrewStatus } from '../../../shared/types';
import { activityText, availabilityText } from '../../store/crew';
import './Crew.css';

interface CrewLinkProps {
  beginLink: () => Promise<CrewLinkView>;
  confirmLinkOwner: (isMe: boolean) => Promise<boolean>;
}

const CrewLink: React.FC<CrewLinkProps> = ({ beginLink, confirmLinkOwner }) => {
  const [view, setView] = useState<CrewLinkView | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      setView(await beginLink());
    } catch (err) {
      setView({ step: 'stopped', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const answer = async (isMe: boolean) => {
    setBusy(true);
    try {
      await confirmLinkOwner(isMe);
      setView(null);
    } finally {
      setBusy(false);
    }
  };

  if (view?.step === 'show-codes') {
    return (
      <div className="crew-link">
        <p>Sign in on the page that opened, and check it shows {view.name} with this code:</p>
        <code className="crew-link__code">{view.confirmCode}</code>
      </div>
    );
  }
  if (view?.step === 'confirm-owner') {
    return (
      <div className="crew-link">
        <p>
          This machine is linked to {view.ownerName} ({view.ownerUpn}).
        </p>
        <div className="crew-link__actions">
          <button type="button" disabled={busy} onClick={() => void answer(true)}>
            That's me
          </button>
          <button type="button" disabled={busy} onClick={() => void answer(false)}>
            Not me
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="crew-link">
      <button type="button" disabled={busy} onClick={() => void start()}>
        Link this machine
      </button>
      {view?.step === 'stopped' && <p className="crew-link__stopped">{view.message}</p>}
    </div>
  );
};

export interface CrewPanelProps extends CrewLinkProps {
  status: CrewStatus | null;
  hires: CrewHireSummary[] | null;
  error: string | null;
  selectedHireId: string | null;
  onSelectHire: (hireId: string) => void;
  onOpenCards: () => void;
  onHire?: () => void;
}

const LINKABLE = new Set(['unlinked', 'link-again']);

/** The sidebar's Crew section: whether Crew can be reached, and each hire with its state. */
export const CrewPanel: React.FC<CrewPanelProps> = ({ status, hires, error, selectedHireId, onSelectHire, onOpenCards, onHire, beginLink, confirmLinkOwner }) => {
  const notice = status ? availabilityText(status.availability) : null;
  const online = status?.availability === 'online';

  return (
    <section className="crew-panel" aria-labelledby="crew-panel-title">
      <div className="crew-panel__header">
        <h3 id="crew-panel-title">Crew</h3>
        {online && onHire && (
          <button type="button" className="crew-panel__cards" onClick={onHire}>
            Hire
          </button>
        )}
        <button type="button" className="crew-panel__cards" onClick={onOpenCards}>
          Cards
        </button>
      </div>
      {error && (
        <p className="crew-panel__error" role="alert">
          Couldn't read Crew: {error}
        </p>
      )}
      {notice && (
        <output className="crew-panel__notice">
          {notice}
        </output>
      )}
      {status && LINKABLE.has(status.availability) && <CrewLink beginLink={beginLink} confirmLinkOwner={confirmLinkOwner} />}
      {hires && hires.length > 0 && (
        <ul className="crew-panel__hires">
          {hires.map((h) => (
            <li key={h.hireId}>
              <button
                type="button"
                className={`crew-hire crew-hire--${h.activity}${h.hireId === selectedHireId ? ' crew-hire--selected' : ''}`}
                aria-current={h.hireId === selectedHireId ? 'true' : undefined}
                onClick={() => onSelectHire(h.hireId)}
              >
                <span className="crew-hire__name">{h.name}</span>
                <span className="crew-hire__state">{activityText(h)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {online && hires?.length === 0 && <p className="crew-panel__empty">No hires yet</p>}
    </section>
  );
};
