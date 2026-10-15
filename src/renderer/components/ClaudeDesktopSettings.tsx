import { useCallback, useEffect, useState } from 'react';
import type { ClaudeDesktopActionResult, ClaudeDesktopStatus } from '../../shared/types';

const STATUS_REFRESH_MS = 5000;

function accessLabel(status: ClaudeDesktopStatus): string {
  if (!status.enabled) return 'Off';
  return status.apiRunning ? 'Enabled' : 'Enabled — API server stopped';
}

/**
 * Settings → Claude Desktop. Access is a paired device of its own; the
 * extension is installed by Claude Desktop's installer, which opening the
 * bundled .mcpb hands off to.
 */
export function ClaudeDesktopSettings() {
  const [status, setStatus] = useState<ClaudeDesktopStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const load = () => window.electronAPI.claudeDesktopGetStatus()
      .then(setStatus)
      .catch(() => setError('Could not read Claude Desktop status.'));
    load();
    const timer = setInterval(load, STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const run = useCallback(async (action: () => Promise<ClaudeDesktopActionResult>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      if (result.status) setStatus(result.status);
      if (result.success) {
        if (result.message) setNotice(result.message);
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!status) {
    return <div className="settings-section"><p className="settings-hint">Loading…</p></div>;
  }

  return (
    <div className="settings-section">
      <h3>Claude Desktop</h3>
      <p className="settings-description">
        Let Claude Desktop on this computer list your sessions, read them, start new Claude Code sessions in repos
        Bodhilander knows, and check run status. It connects only to this computer, as its own paired device.
      </p>
      <p className="settings-hint">
        That device has Control and Modify permission, so any program running as you that reads its credential can
        do what a fully trusted paired device can. Text Claude Desktop reads from one session can shape the prompt it
        sends to another.
      </p>

      <div className="settings-group">
        <h4>Access</h4>
        <div className="settings-row">
          <label>
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy}
              onChange={() => run(() => (status.enabled
                ? window.electronAPI.claudeDesktopDisable()
                : window.electronAPI.claudeDesktopEnable()))}
            />
            <span>Allow Claude Desktop to use Bodhilander</span>
          </label>
          <span className={`api-status ${status.enabled && status.apiRunning ? 'running' : 'stopped'}`}>
            {accessLabel(status)}
          </span>
        </div>
        {status.enabled && !status.apiRunning && (
          <p className="settings-hint">
            The local API server is stopped, so Claude Desktop cannot reach Bodhilander. Start it under Settings → Mobile App.
          </p>
        )}
        <p className="settings-hint">
          Turning access off unpairs the &quot;Claude Desktop&quot; device. You can also unpair it from the Mobile App tab.
        </p>
      </div>

      <div className="settings-group">
        <h4>Extension</h4>
        {status.extensionAvailable ? (
          <>
            <p className="settings-description">
              Install the Bodhilander extension in Claude Desktop, or save the file to share it.
            </p>
            <div className="settings-actions">
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => run(() => window.electronAPI.claudeDesktopInstall())}
              >
                Install in Claude Desktop
              </button>
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => run(() => window.electronAPI.claudeDesktopSaveExtension())}
              >
                Save extension file…
              </button>
            </div>
          </>
        ) : (
          <p className="settings-hint">This build does not include the Claude Desktop extension.</p>
        )}
      </div>

      {notice && <p className="settings-hint">{notice}</p>}
      {error && <p className="settings-hint" style={{ color: 'var(--color-danger, #e5534b)' }}>{error}</p>}
    </div>
  );
}
