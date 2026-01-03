import React, { useState, useEffect } from 'react';
import { ShareCode, CreateCodeOptions } from '../../shared/types';
import './ShareModal.css';

interface ShareModalProps {
  sessionId: string;
  sessionName: string;
  isOpen: boolean;
  onClose: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({
  sessionId,
  sessionName,
  isOpen,
  onClose,
}) => {
  const [isSharing, setIsSharing] = useState(false);
  const [codes, setCodes] = useState<ShareCode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Code creation form
  const [permission, setPermission] = useState<'read' | 'control'>('read');
  const [expiresIn, setExpiresIn] = useState<number>(30);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      checkSharingStatus();
    }
  }, [isOpen, sessionId]);

  const checkSharingStatus = async () => {
    setError(null);
    const sharing = await window.electronAPI.isSharing(sessionId);
    setIsSharing(sharing);
    if (sharing) {
      const existingCodes = await window.electronAPI.getShareCodes(sessionId);
      setCodes(existingCodes);
    }
  };

  const handleStartSharing = async () => {
    setLoading(true);
    setError(null);
    try {
      await window.electronAPI.startSharing(sessionId);
      setIsSharing(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };

  const handleStopSharing = async () => {
    setLoading(true);
    try {
      await window.electronAPI.stopSharing(sessionId);
      setIsSharing(false);
      setCodes([]);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };

  const handleCreateCode = async () => {
    setLoading(true);
    setError(null);
    try {
      const options: CreateCodeOptions = {
        permission,
        expiresInMinutes: expiresIn,
        maxUses: maxUses || undefined,
      };
      const code = await window.electronAPI.createShareCode(sessionId, options);
      setCodes([...codes, code]);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };

  const handleRevokeCode = async (code: string) => {
    setLoading(true);
    try {
      await window.electronAPI.revokeShareCode(code);
      setCodes(codes.filter((c) => c.code !== code));
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (e) {
      setError('Failed to copy to clipboard');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Share Session</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <p className="session-name">Session: {sessionName}</p>

          {error && <div className="error-message">{error}</div>}

          {!isSharing ? (
            <div className="start-sharing">
              <p>Share this session to let others view or collaborate in real-time.</p>
              <button
                className="btn primary"
                onClick={handleStartSharing}
                disabled={loading}
              >
                {loading ? 'Starting...' : 'Start Sharing'}
              </button>
            </div>
          ) : (
            <>
              <div className="create-code-form">
                <h3>Create Share Code</h3>

                <div className="form-group">
                  <label>Permission</label>
                  <select
                    value={permission}
                    onChange={(e) => setPermission(e.target.value as 'read' | 'control')}
                  >
                    <option value="read">Read Only (can view)</option>
                    <option value="control">Full Control (can type)</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Expires In</label>
                  <select
                    value={expiresIn}
                    onChange={(e) => setExpiresIn(Number(e.target.value))}
                  >
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={240}>4 hours</option>
                    <option value={0}>No expiry</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Max Uses</label>
                  <select
                    value={maxUses === null ? 'unlimited' : String(maxUses)}
                    onChange={(e) => {
                      const val = e.target.value;
                      setMaxUses(val === 'unlimited' ? null : Number(val));
                    }}
                  >
                    <option value="1">1 use</option>
                    <option value="5">5 uses</option>
                    <option value="unlimited">Unlimited</option>
                  </select>
                </div>

                <button
                  className="btn primary"
                  onClick={handleCreateCode}
                  disabled={loading}
                >
                  Generate Code
                </button>
              </div>

              {codes.length > 0 && (
                <div className="codes-list">
                  <h3>Active Codes</h3>
                  {codes.map((code) => (
                    <div key={code.code} className="code-item">
                      <div className="code-value">
                        <span className="code">{code.code}</span>
                        <button className="copy-btn" onClick={() => copyCode(code.code)}>
                          {copiedCode === code.code ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                      <div className="code-meta">
                        <span className={`permission ${code.permission}`}>
                          {code.permission}
                        </span>
                        {code.expiresAt && (
                          <span className="expires">
                            Expires: {new Date(code.expiresAt).toLocaleTimeString()}
                          </span>
                        )}
                        {code.maxUses && (
                          <span className="uses">
                            {code.currentUses}/{code.maxUses} uses
                          </span>
                        )}
                      </div>
                      <button
                        className="revoke-btn"
                        onClick={() => handleRevokeCode(code.code)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="stop-sharing">
                <button
                  className="btn danger"
                  onClick={handleStopSharing}
                  disabled={loading}
                >
                  Stop Sharing
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
