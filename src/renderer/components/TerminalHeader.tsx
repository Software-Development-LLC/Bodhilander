import React, { useState } from 'react';
import { Session } from '../../shared/types';
import { useSessionStats, formatDuration, formatStatsTooltip } from '../store/session-stats';
import { SessionAccountIndicator, SessionAccountIndicatorProps } from './SessionAccountIndicator';

interface TerminalHeaderProps {
  session: Session;
  /**
   * Live-vs-assigned account state for the header indicator (#165). null when
   * no Claude accounts are registered, or when this session doesn't run the
   * Claude provider — the header then looks exactly as it did before accounts
   * existed.
   *
   * Resolved by the caller rather than looked up here: App keeps one header
   * mounted per open session (inactive ones are only display:none), so any
   * fetching in this component would fan out across every session at once.
   */
  account?: SessionAccountIndicatorProps | null;
  onRename: (name: string) => void;
  onRestart: () => void;
  onStop: () => void;
  onClose: () => void;
}

const TerminalHeader: React.FC<TerminalHeaderProps> = ({
  session,
  account,
  onRename,
  onRestart,
  onStop,
  onClose,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.name);
  const { stats } = useSessionStats(session.id);

  const handleFinishEdit = () => {
    if (editName.trim() && editName !== session.name) {
      onRename(editName.trim());
    }
    setIsEditing(false);
  };

  const truncatePath = (path: string, maxLen: number = 50) => {
    if (path.length <= maxLen) return path;
    return '...' + path.slice(-(maxLen - 3));
  };

  return (
    <div className="terminal-header">
      <span className={`header-state-dot ${session.state}`} title={session.state} />

      {isEditing ? (
        <input
          className="header-name-input"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={handleFinishEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleFinishEdit();
            if (e.key === 'Escape') {
              setEditName(session.name);
              setIsEditing(false);
            }
          }}
          autoFocus
        />
      ) : (
        <span
          className="header-name"
          onDoubleClick={() => {
            setEditName(session.name);
            setIsEditing(true);
          }}
          title="Double-click to rename"
        >
          {session.name}
        </span>
      )}

      <span className="header-path" title={session.workingDir}>
        {truncatePath(session.workingDir)}
      </span>

      {account && <SessionAccountIndicator {...account} />}

      {stats && stats.totalEvents > 0 && (
        <span className="header-stats" title={formatStatsTooltip(stats)}>
          {formatDuration(stats.totalDurationSeconds) && (
            <span className="header-stat">{formatDuration(stats.totalDurationSeconds)}</span>
          )}
          {stats.totalEvents > 0 && (
            <span className="header-stat">{stats.totalEvents} events</span>
          )}
          {Object.values(stats.toolUseCounts).reduce((s, c) => s + c, 0) > 0 && (
            <span className="header-stat">
              {Object.values(stats.toolUseCounts).reduce((s, c) => s + c, 0)} tools
            </span>
          )}
        </span>
      )}

      <div className="header-actions">
        <button className="header-action" onClick={onRestart} title="Restart session" aria-label="Restart session">
          ↻
        </button>
        <button className="header-action" onClick={onStop} title="Stop session" aria-label="Stop session">
          ■
        </button>
        <button className="header-action danger" onClick={onClose} title="Close session" aria-label="Close session">
          ×
        </button>
      </div>
    </div>
  );
};

export default TerminalHeader;
