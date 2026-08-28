import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ApiServerStatus, ArrivalReport, HANDOFF_MAX_BYTES, PairedDevice, PairingCode, PortableExportResult, PortableImportResult } from '../../shared/types';
import { ProviderSettings } from './ProviderSettings';
import { RemoteHostingSettings } from './RemoteHostingSettings';
import { ClaudeAccountsPanel } from './ClaudeAccountsModal';
import { HandoffPreparePanel } from './MachineHandoff';
import { ArrivalReportModal } from './ArrivalReport';

// Exported so callers that deep-link into a tab (menu, tray) can type their
// state instead of passing a bare string.
export type SettingsTab =
  | 'general'
  | 'terminal'
  | 'sound'
  | 'integrations'
  | 'providers'
  | 'accounts'
  | 'mobile'
  | 'remoteHosting'
  | 'updates';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tab to land on when the modal opens. Defaults to 'general'. */
  initialTab?: SettingsTab;
}

/** A bundle export reports its size; the portable JSON has none to report. */
export function exportSummary(result: PortableExportResult): string {
  const carried = `${result.groupCount} groups and ${result.sessionCount} sessions`;
  return result.sizeLabel
    ? `Wrote a ${result.sizeLabel} transfer bundle carrying ${carried}.`
    : `Exported ${carried}.`;
}

/**
 * Everything the restore actually did. Transcripts and relinks are the two
 * facts a machine transfer turns on, and both were being computed and dropped.
 */
export function importSummary(result: PortableImportResult): string {
  const lines = [`Imported ${result.groupCount} groups and ${result.sessionCount} sessions.`];
  if (result.transcriptCount !== undefined) {
    lines.push(`Restored ${result.transcriptCount} conversation transcripts.`);
  }
  if (result.needsRelinkCount) {
    lines.push(`${result.needsRelinkCount} sessions need their folder set before they can start.`);
  }
  if (result.skippedGroups || result.skippedSessions) {
    lines.push(`Skipped ${result.skippedGroups} existing groups and ${result.skippedSessions} existing sessions.`);
  }
  return lines.join('\n');
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, initialTab = 'general' }) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  // The kept arrival report, reopened on demand. `missing` is a separate flag
  // so "nothing has been restored here" is an answer rather than a dead button.
  const [arrivalReport, setArrivalReport] = useState<ArrivalReport | null>(null);
  const [arrivalMissing, setArrivalMissing] = useState(false);
  const navClass = (tab: SettingsTab) =>
    `settings-nav-item ${activeTab === tab ? 'active' : ''}`;

  // App keeps this component mounted and only flips isOpen, so activeTab
  // survives a close — a useState initial value would only honour initialTab
  // the very first time. Re-apply it on each open so "Settings → Claude
  // Accounts" lands on the right tab even after the user browsed elsewhere.
  useEffect(() => {
    if (isOpen) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  // Update channel state (BDHLNDR-32)
  const [updateChannel, setUpdateChannelState] = useState<'stable' | 'beta'>('stable');
  const [updateChannelLoading, setUpdateChannelLoading] = useState(false);


  // Mobile API state
  const [apiStatus, setApiStatus] = useState<ApiServerStatus>({ running: false });
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [pairingCode, setPairingCode] = useState<PairingCode | null>(null);
  const [port, setPort] = useState(8443);
  const [loading, setLoading] = useState(false);

  // Sound settings state
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundVolume, setSoundVolume] = useState(70);
  const [debouncePreset, setDebouncePreset] = useState<'fast' | 'normal' | 'relaxed'>('normal');
  const [soundWaitingEnabled, setSoundWaitingEnabled] = useState(true);
  const [soundErrorEnabled, setSoundErrorEnabled] = useState(true);
  const [soundStartEnabled, setSoundStartEnabled] = useState(true);
  const [soundCompleteEnabled, setSoundCompleteEnabled] = useState(true);
  const volumeSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // General settings state
  const [autoLaunchClaude, setAutoLaunchClaude] = useState(true);
  const [customShellPath, setCustomShellPath] = useState('');
  const [closeToTray, setCloseToTray] = useState(true);
  const [preferredEditor, setPreferredEditor] = useState('');
  const [editorOptions, setEditorOptions] = useState<{ value: string; label: string }[]>([]);

  // Appearance settings state

  // Terminal settings state
  const [fontSize, setFontSize] = useState(14);
  const [webglRenderer, setWebglRenderer] = useState(true);

  // Desktop notifications state
  const [enableNotifications, setEnableNotifications] = useState(true);

  // Integrations state

  // Error state for surfacing errors to users
  const [error, setError] = useState<string | null>(null);

  // Load initial state
  useEffect(() => {
    if (!isOpen) return;

    const loadState = async () => {
      try {
        const [status, devices, hasPairingResult, channel] = await Promise.all([
          window.electronAPI.apiGetStatus(),
          window.electronAPI.apiGetPairedDevices(),
          window.electronAPI.apiHasPairingCode(),
          window.electronAPI.getUpdateChannel(),
        ]);
        setApiStatus(status);
        setPairedDevices(devices);
        if (!hasPairingResult.active) {
          setPairingCode(null);
        }
        setUpdateChannelState(channel);

        // Load sound settings
        const [
          soundEnabledPref,
          volumePref,
          debouncePref,
          waitingPref,
          errorPref,
          startPref,
          completePref,
          autoLaunchPref,
          shellPathPref,
          closeToTrayPref,
          fontSizePref,
          webglRendererPref,
          enableNotificationsPref,
        ] = await Promise.all([
          window.electronAPI.getPreference('notificationSound'),
          window.electronAPI.getPreference('soundVolume'),
          window.electronAPI.getPreference('soundDebouncePreset'),
          window.electronAPI.getPreference('soundWaitingEnabled'),
          window.electronAPI.getPreference('soundErrorEnabled'),
          window.electronAPI.getPreference('soundStartEnabled'),
          window.electronAPI.getPreference('soundCompleteEnabled'),
          window.electronAPI.getPreference('autoLaunchClaude'),
          window.electronAPI.getPreference('customShellPath'),
          window.electronAPI.getPreference('closeToTray'),
          window.electronAPI.getPreference('fontSize'),
          window.electronAPI.getPreference('webglRenderer'),
          window.electronAPI.getPreference('enableNotifications'),
        ]);

        setSoundEnabled(soundEnabledPref !== 'false');
        setSoundVolume(volumePref ? parseInt(volumePref, 10) : 70);
        setDebouncePreset((debouncePref as 'fast' | 'normal' | 'relaxed') || 'normal');
        setSoundWaitingEnabled(waitingPref !== 'false');
        setSoundErrorEnabled(errorPref !== 'false');
        setSoundStartEnabled(startPref !== 'false');
        setSoundCompleteEnabled(completePref !== 'false');
        setAutoLaunchClaude(autoLaunchPref === 'true');
        setCustomShellPath(shellPathPref || '');
        setCloseToTray(closeToTrayPref !== 'false');
        setFontSize(fontSizePref ? parseInt(fontSizePref, 10) : 14);
        setWebglRenderer(webglRendererPref === 'true');
        setEnableNotifications(enableNotificationsPref !== 'false');

        // Load editor options and preference
        try {
          const [options, editorPref] = await Promise.all([
            window.electronAPI.getEditorOptions(),
            window.electronAPI.getPreference('preferredEditor'),
          ]);
          setEditorOptions(options);
          setPreferredEditor(editorPref || '');
        } catch {
          // Editor options are optional
        }
      } catch (err) {
        console.error('Failed to load API state:', err);
        setError('Failed to load settings. Please try reopening the settings.');
      }
    };

    loadState();
  }, [isOpen]);

  // Auto-dismiss error after 5 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const handleStartServer = useCallback(async () => {
    setLoading(true);
    try {
      await window.electronAPI.apiStart({ port });
      const status = await window.electronAPI.apiGetStatus();
      setApiStatus(status);
    } catch (err) {
      console.error('Failed to start API server:', err);
      setError('Failed to start API server.');
    }
    setLoading(false);
  }, [port]);

  const handleStopServer = useCallback(async () => {
    setLoading(true);
    try {
      await window.electronAPI.apiStop();
      setApiStatus({ running: false });
      setPairingCode(null);
    } catch (err) {
      console.error('Failed to stop API server:', err);
      setError('Failed to stop API server.');
    }
    setLoading(false);
  }, []);

  const handleGeneratePairingCode = useCallback(async () => {
    try {
      const result = await window.electronAPI.apiGeneratePairingCode({
        canControl: true,
        canModify: false,
      });
      if (result.success && result.code && result.qrCode && result.expiresAt) {
        setPairingCode({
          code: result.code,
          qrCode: result.qrCode,
          expiresAt: result.expiresAt,
          addresses: result.addresses,
          port: result.port,
        });
      } else {
        console.error('Failed to generate pairing code:', result.error);
        setError('Failed to generate pairing code.');
      }
    } catch (err) {
      console.error('Failed to generate pairing code:', err);
      setError('Failed to generate pairing code.');
    }
  }, []);

  const handleCancelPairing = useCallback(async () => {
    try {
      await window.electronAPI.apiCancelPairing();
      setPairingCode(null);
    } catch (err) {
      console.error('Failed to cancel pairing:', err);
      setError('Failed to cancel pairing.');
    }
  }, []);


  const handleUnpairDevice = useCallback(async (deviceId: string) => {
    try {
      await window.electronAPI.apiUnpairDevice(deviceId);
      setPairedDevices(prev => prev.filter(d => d.id !== deviceId));
    } catch (err) {
      console.error('Failed to unpair device:', err);
      setError('Failed to unpair device.');
    }
  }, []);

  const handleUpdatePermissions = useCallback(async (
    deviceId: string,
    permissions: { canControl?: boolean; canModify?: boolean }
  ) => {
    try {
      await window.electronAPI.apiUpdateDevicePermissions(deviceId, permissions);
      setPairedDevices(prev =>
        prev.map(d =>
          d.id === deviceId
            ? { ...d, ...permissions }
            : d
        )
      );
    } catch (err) {
      console.error('Failed to update permissions:', err);
      setError('Failed to update device permissions.');
    }
  }, []);

  // Sound setting handlers
  const handleSoundEnabledChange = useCallback(async (enabled: boolean) => {
    setSoundEnabled(enabled);
    await window.electronAPI.setPreference('notificationSound', enabled.toString());
  }, []);

  const handleVolumeChange = useCallback((volume: number) => {
    setSoundVolume(volume);
    // Debounce preference save to avoid excessive writes during slider drag
    if (volumeSaveTimerRef.current) {
      clearTimeout(volumeSaveTimerRef.current);
    }
    volumeSaveTimerRef.current = setTimeout(() => {
      window.electronAPI.setPreference('soundVolume', volume.toString());
    }, 300);
  }, []);

  const handleDebouncePresetChange = useCallback(async (preset: 'fast' | 'normal' | 'relaxed') => {
    setDebouncePreset(preset);
    await window.electronAPI.setPreference('soundDebouncePreset', preset);
  }, []);

  const handleSoundToggle = useCallback(async (
    event: 'waiting' | 'error' | 'start' | 'complete',
    enabled: boolean
  ) => {
    const prefKey = `sound${event.charAt(0).toUpperCase() + event.slice(1)}Enabled`;
    await window.electronAPI.setPreference(prefKey, enabled.toString());

    switch (event) {
      case 'waiting': setSoundWaitingEnabled(enabled); break;
      case 'error': setSoundErrorEnabled(enabled); break;
      case 'start': setSoundStartEnabled(enabled); break;
      case 'complete': setSoundCompleteEnabled(enabled); break;
    }
  }, []);

  const handleTestSound = useCallback(async (event: 'waiting' | 'error' | 'start' | 'complete') => {
    await window.electronAPI.testSound(event);
  }, []);

  // General setting handlers
  const handleAutoLaunchClaudeChange = useCallback(async (enabled: boolean) => {
    setAutoLaunchClaude(enabled);
    await window.electronAPI.setPreference('autoLaunchClaude', enabled.toString());
  }, []);

  const handleCustomShellPathChange = useCallback(async (path: string) => {
    setCustomShellPath(path);
    await window.electronAPI.setPreference('customShellPath', path);
  }, []);

  const handleCloseToTrayChange = useCallback(async (enabled: boolean) => {
    setCloseToTray(enabled);
    await window.electronAPI.setPreference('closeToTray', enabled.toString());
  }, []);

  const handlePreferredEditorChange = useCallback(async (editor: string) => {
    setPreferredEditor(editor);
    await window.electronAPI.setPreference('preferredEditor', editor);
  }, []);

  // Terminal setting handlers
  const handleFontSizeChange = useCallback(async (size: number) => {
    setFontSize(size);
    await window.electronAPI.setPreference('fontSize', size.toString());
  }, []);

  const handleWebglRendererChange = useCallback(async (enabled: boolean) => {
    setWebglRenderer(enabled);
    await window.electronAPI.setPreference('webglRenderer', enabled.toString());
  }, []);

  const handleEnableNotificationsChange = useCallback(async (enabled: boolean) => {
    setEnableNotifications(enabled);
    await window.electronAPI.setPreference('enableNotifications', enabled.toString());
  }, []);

  const handleModalKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      const modal = e.currentTarget as HTMLElement;
      const focusable = modal.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, [onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onKeyDown={handleModalKeyDown}
      >
        <div className="modal-header">
          <h2 id="settings-modal-title">Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close settings">&times;</button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav">
            <button
              className={navClass('general')}
              onClick={() => setActiveTab('general')}
            >
              General
            </button>
            <button
              className={navClass('terminal')}
              onClick={() => setActiveTab('terminal')}
            >
              Terminal
            </button>
            <button
              className={navClass('mobile')}
              onClick={() => setActiveTab('mobile')}
            >
              Mobile App
            </button>
            <button
              className={navClass('remoteHosting')}
              onClick={() => setActiveTab('remoteHosting')}
            >
              Remote Hosting
            </button>
            <button
              className={navClass('sound')}
              onClick={() => setActiveTab('sound')}
            >
              Sound
            </button>
            <button
              className={navClass('integrations')}
              onClick={() => setActiveTab('integrations')}
            >
              Integrations
            </button>
            <button
              className={navClass('providers')}
              onClick={() => setActiveTab('providers')}
            >
              Providers
            </button>
            <button
              className={navClass('accounts')}
              onClick={() => setActiveTab('accounts')}
            >
              Claude Accounts
            </button>
            <button
              className={navClass('updates')}
              onClick={() => setActiveTab('updates')}
            >
              Updates
            </button>
          </nav>

          <div className="settings-content">
            {error && (
              <div className="settings-error-banner" role="alert">
                {error}
                <button onClick={() => setError(null)} aria-label="Dismiss error">&times;</button>
              </div>
            )}
            {activeTab === 'general' && (
              <div className="settings-section">
                <h3>General Settings</h3>

                <div className="settings-group">
                  <h4>Sessions</h4>
                  <div className="settings-row">
                    <label htmlFor="auto-launch-claude">Auto-launch Claude:</label>
                    <input
                      id="auto-launch-claude"
                      type="checkbox"
                      checked={autoLaunchClaude}
                      onChange={e => handleAutoLaunchClaudeChange(e.target.checked)}
                    />
                    <span className="settings-hint">Automatically start Claude when creating new sessions</span>
                  </div>

                  <div className="settings-row">
                    <label htmlFor="custom-shell-path">Custom Shell Path:</label>
                    <input
                      id="custom-shell-path"
                      type="text"
                      className="settings-text-input"
                      value={customShellPath}
                      onChange={e => handleCustomShellPathChange(e.target.value)}
                      placeholder="Auto-detect"
                    />
                    <span className="settings-hint">
                      {window.electronAPI.platform === 'win32'
                        ? 'e.g., C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
                        : 'e.g., /bin/bash, /bin/zsh'}
                    </span>
                  </div>

                  <div className="settings-row">
                    <label htmlFor="preferred-editor">Preferred Editor:</label>
                    <select
                      id="preferred-editor"
                      className="settings-select"
                      value={preferredEditor}
                      onChange={e => handlePreferredEditorChange(e.target.value)}
                    >
                      <option value="">Auto-detect</option>
                      {editorOptions.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <span className="settings-hint">Editor to use when opening files from code search results</span>
                  </div>
                </div>

                <div className="settings-group">
                  <h4>System</h4>
                  <div className="settings-row">
                    <label htmlFor="close-to-tray">Close to Tray:</label>
                    <input
                      id="close-to-tray"
                      type="checkbox"
                      checked={closeToTray}
                      onChange={e => handleCloseToTrayChange(e.target.checked)}
                    />
                    <span className="settings-hint">Minimize to system tray instead of quitting when closing window</span>
                  </div>
                </div>

                <div className="settings-group">
                  <h4>Data</h4>
                  {/* Two buttons, not one control — so the purpose rides on each
                      button's own name instead of a label with nothing to point at. */}
                  <div className="settings-row">
                    <span className="settings-row-label" aria-hidden="true">Move to Another Machine:</span>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        className="settings-button"
                        aria-label="Export this machine, to move to another one"
                        onClick={async () => {
                          const result = await window.electronAPI.exportGroups();
                          if (result.success) {
                            alert(exportSummary(result));
                          } else if (result.error && result.error !== 'Export cancelled') {
                            alert(`Export failed: ${result.error}`);
                          }
                        }}
                      >
                        Export…
                      </button>
                      <button
                        className="settings-button"
                        aria-label="Import a machine exported from another one"
                        onClick={async () => {
                          const result = await window.electronAPI.importGroups();
                          if (result.success) {
                            alert(importSummary(result));
                            window.location.reload();
                          } else if (result.error && result.error !== 'Import cancelled') {
                            alert(`Import failed: ${result.error}`);
                          }
                        }}
                      >
                        Import…
                      </button>
                    </div>
                    <span className="settings-hint">
                      Export asks what to carry: this whole machine as a transfer bundle — groups, sessions,
                      history, settings, accounts and conversation transcripts — or just groups and sessions
                      as portable JSON that ClaudeLander reads. Import accepts either.
                    </span>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label" aria-hidden="true">Over the Relay:</span>
                    <HandoffPreparePanel />
                    <span className="settings-hint">
                      Sends that same bundle to your relay account instead of a file. It is encrypted
                      here first, so the relay carries bytes it cannot read; sign in on the new
                      machine and it is offered there. Needs this machine linked under Remote Hosting,
                      and holds up to {Math.round(HANDOFF_MAX_BYTES / (1024 * 1024))} MB — larger
                      machines move by file.
                    </span>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label" aria-hidden="true">Last Restore:</span>
                    <button
                      className="settings-button"
                      onClick={async () => {
                        const report = await window.electronAPI.arrivalRead();
                        if (report) setArrivalReport(report);
                        else setArrivalMissing(true);
                      }}
                    >
                      Show Restore Report
                    </button>
                    {arrivalMissing && (
                      <span className="settings-hint" role="status">
                        Nothing has been restored onto this machine yet.
                      </span>
                    )}
                    <span className="settings-hint">
                      What the last restore carried, and what it left for you: sessions whose folder is
                      not on this machine, accounts still to sign in to, and provider keys to re-enter.
                    </span>
                  </div>
                  <div className="settings-row">
                    <label>ClaudeLander:</label>
                    <button
                      className="settings-button"
                      onClick={async () => {
                        const result = await window.electronAPI.importFromClaudeLander();
                        if (result.success) {
                          alert(`Imported ${result.groupCount} groups and ${result.sessionCount} sessions from ClaudeLander.` +
                            (result.skippedGroups || result.skippedSessions
                              ? ` (Skipped ${result.skippedGroups} existing groups, ${result.skippedSessions} existing sessions)`
                              : ''));
                          window.location.reload();
                        } else if (result.error) {
                          alert(result.error);
                        }
                      }}
                    >
                      Import directly from ClaudeLander
                    </button>
                    <span className="settings-hint">Reads the ClaudeLander database directly — no export step needed</span>
                  </div>
                </div>

                <div className="settings-group">
                  <h4>Diagnostics</h4>
                  <div className="settings-row">
                    <label>Log Files:</label>
                    <button
                      className="settings-button"
                      onClick={async () => {
                        const paths = await window.electronAPI.getLogPaths();
                        if (paths.logFile) {
                          const dir = paths.logFile.replace(/[\\/][^\\/]+$/, '');
                          window.electronAPI.openExternal(`file://${dir}`);
                        }
                      }}
                    >
                      Open Log Folder
                    </button>
                    <span className="settings-hint">View application logs for troubleshooting</span>
                  </div>
                  <div className="settings-row">
                    <label>Crash Dumps:</label>
                    <button
                      className="settings-button"
                      onClick={async () => {
                        const paths = await window.electronAPI.getLogPaths();
                        window.electronAPI.openExternal(`file://${paths.crashDumps}`);
                      }}
                    >
                      Open Crash Dumps Folder
                    </button>
                    <span className="settings-hint">View native crash dumps (minidump files)</span>
                  </div>
                </div>
              </div>
            )}


            {activeTab === 'terminal' && (
              <div className="settings-section">
                <h3>Terminal</h3>

                <div className="settings-group">
                  <h4>Display</h4>
                  <div className="settings-row">
                    <label htmlFor="font-size">Font Size:</label>
                    <input
                      type="range"
                      id="font-size"
                      min="10"
                      max="24"
                      step="1"
                      value={fontSize}
                      onChange={e => handleFontSizeChange(parseInt(e.target.value, 10))}
                    />
                    <span className="range-value">{fontSize}px</span>
                  </div>

                  <div className="settings-row">
                    <label htmlFor="webgl-renderer">Enable WebGL Rendering:</label>
                    <input
                      id="webgl-renderer"
                      type="checkbox"
                      checked={webglRenderer}
                      onChange={e => handleWebglRendererChange(e.target.checked)}
                    />
                    <span className="settings-hint">Use GPU acceleration for terminal (recommended)</span>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'integrations' && (
              <div className="settings-section">
                <h3>Integrations</h3>
                <p className="settings-description">
                  Connect external services to receive notifications and share sessions.
                </p>

                <div className="settings-group integration-card disabled">
                  <div className="integration-header">
                    <span className="integration-status-dot" />
                    <h4>Microsoft Teams</h4>
                  </div>
                  <p className="integration-status">Coming Soon</p>
                  <p className="settings-hint">Used for: Notifications</p>
                  <div className="settings-actions">
                    <button className="btn btn-secondary" disabled>
                      Coming Soon
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'updates' && (
              <div className="settings-section">
                <h3>Updates</h3>
                <p className="settings-description">
                  Choose which release channel Bodhilander auto-updates from. Changing
                  the channel triggers an immediate background check.
                </p>

                <div className="settings-group">
                  <h4>Release channel</h4>
                  <div className="settings-radio-group">
                    <label className="settings-radio-row">
                      <input
                        type="radio"
                        name="updateChannel"
                        value="stable"
                        checked={updateChannel === 'stable'}
                        disabled={updateChannelLoading}
                        onChange={async () => {
                          setUpdateChannelLoading(true);
                          try {
                            const applied = await window.electronAPI.setUpdateChannel('stable');
                            setUpdateChannelState(applied);
                          } finally {
                            setUpdateChannelLoading(false);
                          }
                        }}
                      />
                      <span>
                        <strong>Stable</strong>
                        <span className="settings-hint"> — the default. Tested releases only.</span>
                      </span>
                    </label>
                    <label className="settings-radio-row">
                      <input
                        type="radio"
                        name="updateChannel"
                        value="beta"
                        checked={updateChannel === 'beta'}
                        disabled={updateChannelLoading}
                        onChange={async () => {
                          setUpdateChannelLoading(true);
                          try {
                            const applied = await window.electronAPI.setUpdateChannel('beta');
                            setUpdateChannelState(applied);
                          } finally {
                            setUpdateChannelLoading(false);
                          }
                        }}
                      />
                      <span>
                        <strong>Beta (opt-in)</strong>
                        <span className="settings-hint"> — earlier access to new features. May be unstable; please report issues.</span>
                      </span>
                    </label>
                  </div>
                  {updateChannel === 'beta' && (
                    <p className="settings-hint" style={{ marginTop: 8 }}>
                      You'll receive beta builds as they're cut from the development branch.
                      Switch back to Stable at any time — the next stable release ≥ your
                      current beta will auto-install.
                    </p>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'providers' && <ProviderSettings />}

            {activeTab === 'accounts' && (
              <div className="settings-section">
                <h3>Claude Accounts</h3>
                {/* Panel is shared with the standalone accounts modal; it owns
                    its own add-account overlay because that flow runs a pty. */}
                <ClaudeAccountsPanel />
              </div>
            )}

            {activeTab === 'remoteHosting' && <RemoteHostingSettings />}

            {activeTab === 'mobile' && (
              <div className="settings-section">
                <h3>Mobile Companion App</h3>
                <p className="settings-description">
                  Enable the local API server to connect the Bodhilander mobile app.
                  Your mobile device must be on the same network.
                </p>

                <div className="settings-group">
                  <h4>API Server</h4>
                  <div className="settings-row">
                    <label>Status:</label>
                    <span className={`api-status ${apiStatus.running ? 'running' : 'stopped'}`}>
                      {apiStatus.running ? `Running on ${apiStatus.addresses?.[0] ?? 'localhost'}:${apiStatus.port}` : 'Stopped'}
                    </span>
                  </div>

                  {!apiStatus.running && (
                    <div className="settings-row">
                      <label htmlFor="api-port">Port:</label>
                      <input
                        id="api-port"
                        type="number"
                        value={port}
                        onChange={e => setPort(parseInt(e.target.value) || 8443)}
                        min={1024}
                        max={65535}
                      />
                    </div>
                  )}

                  <div className="settings-actions">
                    {apiStatus.running ? (
                      <button
                        className="btn btn-danger"
                        onClick={handleStopServer}
                        disabled={loading}
                      >
                        {loading ? 'Stopping...' : 'Stop Server'}
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary"
                        onClick={handleStartServer}
                        disabled={loading}
                      >
                        {loading ? 'Starting...' : 'Start Server'}
                      </button>
                    )}
                  </div>
                </div>

                {apiStatus.running && (
                  <div className="settings-group">
                    <h4>Pair New Device</h4>
                    {pairingCode ? (
                      <div className="pairing-active">
                        <div className="pairing-qr">
                          <img
                            src={pairingCode.qrCode}
                            alt="Scan with mobile app"
                            width={200}
                            height={200}
                          />
                        </div>
                        <div className="pairing-code">
                          <span>Code: </span>
                          <strong>{pairingCode.code}</strong>
                        </div>
                        <p className="pairing-hint">
                          Scan this QR code with the Bodhilander mobile app, or enter the code manually.
                        </p>
                        <button className="btn btn-secondary" onClick={handleCancelPairing}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="pairing-start">
                        <p>Generate a pairing code to connect a new mobile device.</p>
                        <button className="btn btn-primary" onClick={handleGeneratePairingCode}>
                          Generate Pairing Code
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="settings-group">
                  <h4>Paired Devices ({pairedDevices.length})</h4>
                  {pairedDevices.length === 0 ? (
                    <p className="settings-empty">No devices paired yet.</p>
                  ) : (
                    <div className="paired-devices-list">
                      {pairedDevices.map(device => (
                        <div key={device.id} className="paired-device">
                          <div className="device-info">
                            <span className="device-name">{device.name}</span>
                            <span className="device-platform">{device.platform}</span>
                            <span className="device-last-used">
                              Last used: {new Date(device.lastUsedAt).toLocaleDateString()}
                            </span>
                          </div>
                          <div className="device-permissions">
                            <label>
                              <input
                                type="checkbox"
                                checked={device.canControl}
                                onChange={e =>
                                  handleUpdatePermissions(device.id, { canControl: e.target.checked })
                                }
                              />
                              Control
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={device.canModify}
                                onChange={e =>
                                  handleUpdatePermissions(device.id, { canModify: e.target.checked })
                                }
                              />
                              Modify
                            </label>
                          </div>
                          <button
                            className="btn btn-danger btn-small"
                            onClick={() => handleUnpairDevice(device.id)}
                          >
                            Unpair
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <p className="settings-hint">
                  Looking for access from outside your network? See{' '}
                  <strong>Settings → Remote Hosting</strong>.
                </p>
              </div>
            )}

            {activeTab === 'sound' && (
              <div className="settings-section">
                <h3>Sound Settings</h3>

                <div className="settings-group">
                  <h4>Desktop Notifications</h4>
                  <div className="settings-row">
                    <label htmlFor="enable-notifications">Enable Notifications:</label>
                    <input
                      id="enable-notifications"
                      type="checkbox"
                      checked={enableNotifications}
                      onChange={e => handleEnableNotificationsChange(e.target.checked)}
                    />
                    <span className="settings-hint">Show system notifications when sessions need attention</span>
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-row">
                    <label htmlFor="sound-enabled">Enable Sounds:</label>
                    <input
                      id="sound-enabled"
                      type="checkbox"
                      checked={soundEnabled}
                      onChange={e => handleSoundEnabledChange(e.target.checked)}
                    />
                  </div>
                </div>

                {soundEnabled && (
                  <>
                    <div className="settings-group">
                      <h4>Sound Frequency</h4>
                      <p className="settings-description">
                        Controls how rapidly sounds can play when states change quickly.
                      </p>
                      <div className="settings-row">
                        <label htmlFor="debounce-preset">Preset:</label>
                        <select
                          id="debounce-preset"
                          value={debouncePreset}
                          onChange={e => handleDebouncePresetChange(e.target.value as 'fast' | 'normal' | 'relaxed')}
                        >
                          <option value="fast">Fast (200ms)</option>
                          <option value="normal">Normal (500ms) - Recommended</option>
                          <option value="relaxed">Relaxed (1000ms)</option>
                        </select>
                      </div>
                    </div>

                    <div className="settings-group">
                      <h4>Master Volume</h4>
                      <div className="settings-row volume-row">
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={soundVolume}
                          onChange={e => handleVolumeChange(parseInt(e.target.value, 10))}
                        />
                        <span className="volume-value">{soundVolume}%</span>
                      </div>
                    </div>

                    <div className="settings-group">
                      <h4>Individual Sounds</h4>
                      <div className="sound-events-list">
                        {[
                          { event: 'waiting' as const, label: 'Waiting for Input', enabled: soundWaitingEnabled },
                          { event: 'error' as const, label: 'Error', enabled: soundErrorEnabled },
                          { event: 'start' as const, label: 'Session Start', enabled: soundStartEnabled },
                          { event: 'complete' as const, label: 'Task Complete', enabled: soundCompleteEnabled },
                        ].map(({ event, label, enabled }) => (
                          <div key={event} className="sound-event-row">
                            <span className="sound-event-label">{label}</span>
                            <label className="sound-event-toggle">
                              <input
                                type="checkbox"
                                checked={enabled}
                                onChange={e => handleSoundToggle(event, e.target.checked)}
                              />
                              <span>{enabled ? 'On' : 'Off'}</span>
                            </label>
                            <button
                              className="btn btn-small btn-secondary"
                              onClick={() => handleTestSound(event)}
                              disabled={!enabled}
                            >
                              Test
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Reopened on demand, over the settings window that asked for it. */}
      <ArrivalReportModal report={arrivalReport} onClosed={() => setArrivalReport(null)} />
    </div>
  );
};
