import React, { useState, useEffect, useCallback } from 'react';
import { ProviderStatus } from '../../shared/types';
import { ProviderKeyVault } from './ProviderKeyVault';
import { ProviderInstallModal } from './ProviderInstallModal';

/**
 * Settings → Providers panel: provider CLI detection status + setup guidance
 * (#97). Self-contained — detects on mount (each time the tab is opened) and
 * re-detects via the Refresh button, no app restart needed.
 */
export const ProviderSettings: React.FC = () => {
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [installFlow, setInstallFlow] = useState<{ name: string; ptyId: string; command: string } | null>(null);

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

  const handleInstall = useCallback(async (p: ProviderStatus) => {
    // Install commands run remote scripts / global npm installs — show the
    // exact command before executing anything.
    if (!window.confirm(`This will run in your shell:\n\n${p.installCommand}\n\nContinue?`)) return;
    try {
      const { ptyId, command } = await window.electronAPI.runProviderInstall(p.id);
      setInstallFlow({ name: p.name, ptyId, command });
    } catch (error) {
      console.error('Failed to start provider install:', error);
    }
  }, []);

  const handleInstallClose = useCallback(() => {
    setInstallFlow(null);
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
                {p.installCommand && (
                  <button
                    className="settings-button"
                    disabled={!!installFlow}
                    onClick={() => handleInstall(p)}
                  >
                    Install for me
                  </button>
                )}
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

      <ProviderKeyVault />

      {installFlow && (
        <ProviderInstallModal
          providerName={installFlow.name}
          command={installFlow.command}
          ptyId={installFlow.ptyId}
          onClose={handleInstallClose}
        />
      )}
    </div>
  );
};
