import React, { useState, useEffect, useCallback } from 'react';
import { ProviderStatus } from '../../shared/types';

/**
 * Settings → Providers panel: provider CLI detection status + setup guidance
 * (#97). Self-contained — detects on mount (each time the tab is opened) and
 * re-detects via the Refresh button, no app restart needed.
 */
export const ProviderSettings: React.FC = () => {
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatuses(await window.electronAPI.detectProviders());
    } catch (error) {
      console.error('Provider detection failed:', error);
      setStatuses([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="settings-section">
      <h3>Session Providers</h3>
      <p className="settings-description">
        Agent CLIs available for new sessions. Detection runs through your
        login shell, matching how sessions launch.
      </p>

      <div className="settings-group">
        <div className="settings-row">
          <span className="settings-hint">
            {loading && 'Detecting installed CLIs…'}
            {!loading && statuses &&
              `${statuses.filter(p => p.installed).length} of ${statuses.length} providers detected`}
          </span>
          <button className="settings-button" onClick={refresh} disabled={loading}>
            {loading ? 'Detecting…' : 'Refresh'}
          </button>
        </div>

        {(statuses ?? []).map(p => (
          <div key={p.id} className="provider-status-row">
            <div className="provider-status-header">
              <span className={`provider-status-dot ${p.installed ? 'installed' : 'missing'}`} />
              <span className="provider-status-name">{p.name}</span>
              <code className="provider-status-command">{p.command}</code>
              {p.installed ? (
                <span className="provider-status-version">{p.version ?? 'detected'}</span>
              ) : (
                <span className="provider-status-missing">not found</span>
              )}
            </div>
            {!p.installed && (
              <div className="provider-status-setup">
                <div>Install: <code>{p.installHint}</code></div>
                <div>Sign in: {p.loginHint}</div>
                <button
                  className="settings-link-button"
                  onClick={() => window.electronAPI.openExternal(p.docsUrl)}
                >
                  Documentation ↗
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
