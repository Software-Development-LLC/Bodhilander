import React, { useState, useEffect, useCallback } from 'react';
import { KeyVaultStatus, PROVIDER_LABELS } from '../../shared/types';

interface KeyRowProps {
  status: KeyVaultStatus;
  onChanged: () => void;
}

function describeTest(result: { ok: boolean; error: string | null } | null): string {
  if (result === null) return '';
  return result.ok ? 'Key is valid ✓' : `Test failed: ${result.error}`;
}

const ProviderKeyRow: React.FC<KeyRowProps> = ({ status, onChanged }) => {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const run = useCallback(async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      setMessage(await action());
      onChanged();
    } catch (error: any) {
      setMessage(error?.message ?? 'Operation failed');
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const saveKey = () => run(async () => {
    await window.electronAPI.vaultSetKey(status.providerId, draft);
    setDraft('');
    return 'Key stored (encrypted via OS keychain)';
  });

  const testKey = () => run(async () => {
    const result = await window.electronAPI.vaultTestKey(status.providerId);
    return describeTest(result);
  });

  // Delete is irreversible (the key is never displayed again), so require a
  // second click to confirm.
  const deleteKey = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      setMessage('Click again to permanently delete the stored key');
      return;
    }
    setConfirmingDelete(false);
    run(async () => {
      await window.electronAPI.vaultDeleteKey(status.providerId);
      return 'Key deleted';
    });
  };

  const toggleUse = (use: boolean) => run(async () => {
    await window.electronAPI.vaultSetUseKey(status.providerId, use);
    return use ? 'Launches for this provider now use the API key' : 'Back to CLI login / subscription';
  });

  const label = PROVIDER_LABELS[status.providerId] ?? status.providerId;
  const canSave = !busy && draft.trim().length > 0;
  const canTouchKey = !busy && status.hasKey;

  return (
    <div className="vault-row">
      <div className="vault-row-header">
        <span className="provider-status-name">{label}</span>
        <span className={`vault-key-state ${status.hasKey ? 'stored' : ''}`}>
          {status.hasKey ? 'key stored' : 'no key'}
        </span>
      </div>
      <div className="vault-row-controls">
        <input
          type="password"
          autoComplete="off"
          className="settings-text-input vault-key-input"
          placeholder={status.hasKey ? 'Replace key…' : 'Paste API key…'}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          disabled={busy}
        />
        <button className="settings-button" onClick={saveKey} disabled={!canSave}>
          Save
        </button>
        <button className="settings-button" onClick={testKey} disabled={!canTouchKey}>
          Test
        </button>
        <button className="settings-button" onClick={deleteKey} disabled={!canTouchKey}>
          {confirmingDelete ? 'Confirm delete' : 'Delete'}
        </button>
      </div>
      <label className="vault-use-toggle">
        <input
          type="checkbox"
          checked={status.useKey}
          disabled={!canTouchKey}
          onChange={e => toggleUse(e.target.checked)}
        />
        <span>
          Use API key for launches — bills your API account; off = CLI login / subscription (default)
        </span>
      </label>
      {message && <span className="vault-message">{message}</span>}
    </div>
  );
};

/**
 * Settings → Providers: encrypted API-key vault (#99). Keys are stored via
 * Electron safeStorage and never displayed back; a stored key only affects
 * launches after the per-provider opt-in toggle is enabled.
 */
export const ProviderKeyVault: React.FC = () => {
  const [statuses, setStatuses] = useState<KeyVaultStatus[] | null>(null);

  const refresh = useCallback(() => {
    window.electronAPI.vaultList().then(setStatuses).catch(() => setStatuses([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (statuses === null) return null;

  if (statuses.length > 0 && !statuses[0].available) {
    return (
      <div className="settings-group">
        <h4>API Keys (optional)</h4>
        <span className="settings-hint">
          Secure key storage isn't available on this system (OS keychain
          encryption unavailable), so API keys can't be stored. Provider CLIs
          keep working with their own logins.
        </span>
      </div>
    );
  }

  return (
    <div className="settings-group">
      <h4>API Keys (optional)</h4>
      <span className="settings-hint">
        Stored encrypted in your OS keychain and never shown again. By default
        everything runs on each CLI's own login/subscription — a key is used
        only for providers where you enable the toggle.
      </span>
      {statuses.map(s => (
        <ProviderKeyRow key={s.providerId} status={s} onChanged={refresh} />
      ))}
    </div>
  );
};
