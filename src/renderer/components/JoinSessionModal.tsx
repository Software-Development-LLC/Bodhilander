import React, { useState } from 'react';
import './ShareModal.css'; // Reuse styles

interface JoinSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onJoined: (code: string, permission: 'read' | 'control') => void;
}

export const JoinSessionModal: React.FC<JoinSessionModalProps> = ({
  isOpen,
  onClose,
  onJoined,
}) => {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleJoin = async () => {
    if (!code.trim()) {
      setError('Please enter a share code');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.joinSession(code.toUpperCase());
      onJoined(code.toUpperCase(), result.permission);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }

    setLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (loading) return;
    if (e.key === 'Enter') {
      handleJoin();
    }
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Join Shared Session</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <p>Enter the share code to join a session:</p>

          {error && <div className="error-message">{error}</div>}

          <div className="form-group">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={handleKeyDown}
              placeholder="SYCLX-XXXXXX"
              className="code-input"
              autoFocus
            />
          </div>

          <button
            className="btn primary"
            onClick={handleJoin}
            disabled={loading || !code.trim()}
            style={{ width: '100%' }}
          >
            {loading ? 'Joining...' : 'Join Session'}
          </button>
        </div>
      </div>
    </div>
  );
};
