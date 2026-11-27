import React, { useCallback, useEffect, useState } from 'react';
import type { CrewCard, CrewCardKind, CrewCardList } from '../../../shared/types';
import './Crew.css';

const KIND_TEXT: Record<CrewCardKind, string> = {
  permission: 'Permission',
  outbound: 'Send outside the circle',
  skill_change: 'Skill change',
  note_patch: 'Shared note change',
  move: 'Move home machine',
};

function decisionText(card: CrewCard): string {
  if (card.decision === null) return 'Waiting for a decision';
  const by = card.decidedBy ? ` by ${card.decidedBy}` : '';
  return card.decision === 'approved' ? `Approved${by}` : `Denied${by}`;
}

export interface CardsInboxProps {
  load?: () => Promise<CrewCardList>;
  openCard?: (raiseId: string) => Promise<boolean>;
  pollMs?: number;
}

/** The cards Crew raised from this machine. Cards are decided in Teams, at the Hub; this view never decides one. */
export const CardsInbox: React.FC<CardsInboxProps> = ({ load, openCard, pollMs = 10_000 }) => {
  const [cards, setCards] = useState<CrewCardList | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCards(await (load ?? window.electronAPI.crewListCards)());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  const open = async (raiseId: string) => {
    const opened = await (openCard ?? window.electronAPI.crewOpenCard)(raiseId).catch(() => false);
    setNote(opened ? null : 'Decide this card in Teams.');
  };

  let body: React.ReactNode;
  if (error) {
    body = (
      <p className="crew-cards__error" role="alert">
        Couldn't read cards: {error}
      </p>
    );
  } else if (cards === undefined) {
    body = <p>Loading…</p>;
  } else if (cards === null) {
    body = <p>Cards aren't available on this machine yet. They are in Teams.</p>;
  } else if (cards.length === 0) {
    body = <p>No cards waiting</p>;
  } else {
    const ordered = [...cards].sort((a, b) => Number(a.decision !== null) - Number(b.decision !== null) || b.raisedAt - a.raisedAt);
    body = (
      <ul className="crew-cards__list">
        {ordered.map((c) => (
          <li key={c.raiseId} className={`crew-card${c.decision === null ? ' crew-card--open' : ''}`}>
            <div className="crew-card__head">
              <strong>{KIND_TEXT[c.kind] ?? c.kind}</strong>
              <span className="crew-card__meta">
                {c.hireName} · {new Date(c.raisedAt).toLocaleString()}
              </span>
            </div>
            <div className="crew-card__summary">{c.summary}</div>
            <div className="crew-card__meta">{decisionText(c)}</div>
            {c.decision === null && (
              <button type="button" onClick={() => void open(c.raiseId)}>
                Open in Teams
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="crew-cards">
      <h2>Cards</h2>
      {note && <output className="crew-inbox__note">{note}</output>}
      {body}
    </div>
  );
};
