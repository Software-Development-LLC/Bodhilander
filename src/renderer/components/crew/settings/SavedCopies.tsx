import React, { useCallback, useEffect, useState } from 'react';
import type { CrewEditResult, CrewSavedCopy } from '../../../../shared/types';
import '../Crew.css';

export interface SavedCopiesProps {
  load?: () => Promise<CrewSavedCopy[]>;
  remove?: (name: string) => Promise<CrewEditResult>;
}

function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Crew → Windows setup → Saved copies. A copy is deleted only after the person confirms it. */
export const SavedCopies: React.FC<SavedCopiesProps> = ({ load, remove }) => {
  const [copies, setCopies] = useState<CrewSavedCopy[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const doLoad = load ?? (() => window.electronAPI.crewListSavedCopies());
  const doRemove = remove ?? ((name: string) => window.electronAPI.crewDeleteSavedCopy(name));

  const refresh = useCallback(() => {
    doLoad().then(setCopies, () => setCopies([]));
  }, [doLoad]);
  useEffect(refresh, []);

  const confirmDelete = async (name: string) => {
    setConfirming(null);
    const result = await doRemove(name);
    setNote(result.ok ? `Deleted ${name}.` : (result.error ?? "The copy couldn't be deleted."));
    refresh();
  };

  if (copies === null) return <div className="crew-cards">Loading saved copies…</div>;
  return (
    <div className="crew-cards">
      <h3>Saved copies</h3>
      {copies.length === 0 ? (
        <p>No saved copies. Repair saves one here before it moves Crew's Windows setup.</p>
      ) : (
        <ul className="crew-cards__list">
          {copies.map((c) => (
            <li key={c.name} className="crew-card">
              <div className="crew-card__head">
                <span>{c.name}</span>
                <span className="crew-card__meta">
                  {sizeText(c.sizeBytes)} · {new Date(c.savedAt).toLocaleString()}
                </span>
              </div>
              {confirming === c.name ? (
                <div>
                  Delete this copy? It can't be brought back.{' '}
                  <button type="button" onClick={() => void confirmDelete(c.name)}>
                    Delete
                  </button>{' '}
                  <button type="button" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirming(c.name)}>
                  Delete…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {note && <output className="crew-inbox__note">{note}</output>}
    </div>
  );
};
