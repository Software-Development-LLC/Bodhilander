import React from 'react';
import { CardsInbox } from './CardsInbox';
import { HireDetail } from './HireDetail';
import './Crew.css';

export type CrewSelection = { kind: 'cards' } | { kind: 'hire'; hireId: string };

export interface CrewViewProps {
  selection: CrewSelection;
  onLetGo: () => void;
}

/** The content area's Crew destination: one hire's page, or the cards inbox. */
export const CrewView: React.FC<CrewViewProps> = ({ selection, onLetGo }) => (
  <div className="crew-view" id="view-panel-crew" role="tabpanel" aria-labelledby="view-tab-crew">
    {selection.kind === 'hire' ? <HireDetail key={selection.hireId} hireId={selection.hireId} onLetGo={onLetGo} /> : <CardsInbox />}
  </div>
);
