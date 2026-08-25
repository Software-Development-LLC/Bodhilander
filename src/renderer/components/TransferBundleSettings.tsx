import React, { useCallback, useState } from 'react';
import { TransferBundleManifest } from '../../shared/types';

interface PendingImport {
  filePath: string;
  sizeLabel?: string;
  manifest: TransferBundleManifest | null;
}

/**
 * Export the whole machine, or restore one. A restore stops between reading
 * the bundle and writing it so every working-directory root the source machine
 * used can be pointed at wherever that tree lives here.
 */
export function TransferBundleSettings(): React.JSX.Element {
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const handleExport = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.electronAPI.exportTransferBundle();
      if (result.success) {
        alert(`Bundle written (${result.sizeLabel}):\n${result.filePath}`);
      } else if (result.error && result.error !== 'Export cancelled') {
        alert(`Export failed: ${result.error}`);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const handleChoose = useCallback(async () => {
    const result = await window.electronAPI.inspectTransferBundle();
    if (!result.success || !result.filePath) {
      if (result.error && result.error !== 'Import cancelled') alert(`Could not read bundle: ${result.error}`);
      return;
    }
    setMappings({});
    setPending({ filePath: result.filePath, sizeLabel: result.sizeLabel, manifest: result.manifest ?? null });
  }, []);

  const handleMapRoot = useCallback(async (root: string) => {
    const chosen = await window.electronAPI.selectDirectory(mappings[root] || undefined);
    if (chosen) setMappings(prev => ({ ...prev, [root]: chosen }));
  }, [mappings]);

  const handleRestore = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await window.electronAPI.importTransferBundle(
        pending.filePath,
        Object.entries(mappings).map(([from, to]) => ({ from, to })),
      );
      if (!result.success) {
        alert(`Import failed: ${result.error}`);
        return;
      }
      alert(
        `Restored ${result.groups} group(s), ${result.sessions} session(s) and ${result.transcripts} transcript(s).` +
        (result.needsRelink ? `\n${result.needsRelink} session(s) need their folder relinked.` : ''),
      );
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }, [pending, mappings]);

  const roots = pending?.manifest?.workingDirRoots ?? [];

  return (
    <>
      <div className="settings-row">
        <label>Whole Machine:</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="settings-button" disabled={busy} onClick={handleExport}>
            Export Transfer Bundle
          </button>
          <button className="settings-button" disabled={busy} onClick={handleChoose}>
            Import Transfer Bundle…
          </button>
        </div>
        <span className="settings-hint">
          Groups, sessions, history, settings, accounts and conversation transcripts. API keys, Teams tokens
          and the relay identity stay on this machine — they cannot be decrypted anywhere else.
        </span>
      </div>

      {pending && (
        <div className="transfer-import-panel">
          <div className="transfer-import-header">
            <strong>{pending.filePath.split(/[\\/]/).pop()}</strong>
            {pending.sizeLabel && <span className="settings-hint"> — {pending.sizeLabel}</span>}
            {pending.manifest && (
              <span className="settings-hint">
                {' '}from {pending.manifest.sourcePlatform}, Bodhilander {pending.manifest.sourceAppVersion}
              </span>
            )}
          </div>

          {roots.length > 0 ? (
            <>
              <p className="settings-hint">
                Point each folder at where it lives on this machine. Anything left unmapped is restored as-is;
                sessions whose folder is missing arrive marked for relinking.
              </p>
              <ul className="transfer-root-list">
                {roots.map(root => (
                  <li key={root} className="transfer-root-row">
                    <code title={root}>{root}</code>
                    <span aria-hidden="true">→</span>
                    <code className={mappings[root] ? '' : 'transfer-root-unmapped'}>
                      {mappings[root] || 'unmapped'}
                    </code>
                    <button className="settings-button" onClick={() => handleMapRoot(root)}>
                      Choose…
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="settings-hint">
              This file carries no folder list, so paths are restored exactly as they were.
            </p>
          )}

          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="settings-button" disabled={busy} onClick={handleRestore}>
              Restore
            </button>
            <button className="settings-button" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
