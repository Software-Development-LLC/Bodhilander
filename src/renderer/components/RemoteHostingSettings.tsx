import { useEffect, useState, useCallback } from 'react';
import type { RelayStatus } from '../../shared/types';

/**
 * Remote Hosting settings — drives the cloud relay client (BDHLNDR remote
 * hosting). Lets the user turn remote access on, point at a relay, and link
 * this machine to their account by generating a code they claim in the relay's
 * web UI. Live connection status arrives via the `relay:status` push channel.
 */
export function RemoteHostingSettings() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [machineName, setMachineName] = useState('');
  const [linkCode, setLinkCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI.relayGetStatus().then((s) => {
      setStatus(s);
      setUrlInput(s.relayUrl);
      if (s.machineName) setMachineName(s.machineName);
    });
    return window.electronAPI.onRelayStatus((s) => setStatus(s));
  }, []);

  const run = useCallback(async (fn: () => Promise<RelayStatus | void>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      if (s) setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }, []);

  const copy = (label: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
  };

  if (!status) {
    return <div className="settings-section"><p className="settings-hint">Loading…</p></div>;
  }

  const connState = status.connected ? 'running' : 'stopped';
  const connLabel = !status.enabled
    ? 'Off'
    : status.connected
      ? 'Online'
      : status.linked
        ? 'Connecting…'
        : 'Waiting to be linked';

  return (
    <div className="settings-section">
      <div className="settings-group">
        <h4>Remote Hosting</h4>
        <p className="settings-description">
          Reach this machine's sessions from a browser or phone anywhere — no LAN, no tunnel. This machine
          connects out to a relay; terminal traffic is end-to-end encrypted, so the relay can't read it.
        </p>

        <div className="settings-row">
          <label>
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy}
              onChange={() => run(() => (status.enabled ? window.electronAPI.relayDisable() : window.electronAPI.relayEnable()))}
            />
            Enable remote hosting
          </label>
          <span className={`api-status ${connState}`}>{connLabel}</span>
        </div>
      </div>

      <div className="settings-group">
        <h4>Relay</h4>
        <p className="settings-hint">The relay this machine connects to. Use your own self-hosted relay or a hosted one.</p>
        <div className="settings-row">
          <input
            type="text"
            value={urlInput}
            placeholder="https://relay.example.com"
            onChange={(e) => setUrlInput(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <button
            className="btn btn-secondary btn-small"
            disabled={busy || urlInput.trim() === status.relayUrl}
            onClick={() => run(() => window.electronAPI.relaySetUrl(urlInput))}
          >
            Save
          </button>
        </div>
      </div>

      <div className="settings-group">
        <h4>Link this machine</h4>
        {status.linked ? (
          <p className="settings-description">
            Linked as <strong>{status.machineName ?? 'this machine'}</strong>. Generate a new code to link it to a
            different account.
          </p>
        ) : (
          <p className="settings-description">
            Generate a code, then enter it in the relay's web app while signed in to bind this machine to your account.
          </p>
        )}

        <div className="settings-row">
          <input
            type="text"
            value={machineName}
            placeholder="Machine name (e.g. Will-MBP)"
            onChange={(e) => setMachineName(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <button
            className="btn btn-primary btn-small"
            disabled={busy || machineName.trim().length === 0}
            onClick={() => run(async () => {
              const result = await window.electronAPI.relayGenerateLinkCode(machineName);
              setLinkCode(result);
            })}
          >
            Generate link code
          </button>
        </div>

        {linkCode && (
          <div className="pairing-code" style={{ marginTop: 12 }}>
            <span>Enter this code in the relay web app:</span>
            <strong>{linkCode.code}</strong>
            <button className="btn btn-secondary btn-small" onClick={() => copy('code', linkCode.code)}>
              {copied === 'code' ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>

      {status.fingerprint && (
        <div className="settings-group">
          <h4>Machine fingerprint</h4>
          <p className="settings-hint">
            Confirm this matches what the web app shows when you link — it proves you're connecting to this machine and
            not an impostor.
          </p>
          <div className="settings-row">
            <code style={{ userSelect: 'all' }}>{status.fingerprint}</code>
            <button className="btn btn-secondary btn-small" onClick={() => copy('fp', status.fingerprint!)}>
              {copied === 'fp' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="settings-hint" style={{ color: 'var(--color-danger, #e5534b)' }}>{error}</p>}
    </div>
  );
}
