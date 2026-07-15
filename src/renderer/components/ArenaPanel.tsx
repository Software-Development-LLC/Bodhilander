import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ArenaRun, ArenaUpdate, Group, ProviderStatus } from '../../shared/types';
import { applyArenaUpdate, isRunSettled } from './arenaUpdates';
import { buildFolderOptions } from './arenaFolderOptions';

interface ArenaPanelProps {
  onClose: () => void;
  /** Sidebar groups — the ones with a working directory become folder scopes. */
  groups: Group[];
  /** Group to pre-select as the folder scope (e.g. "Ask Arena" from its menu). */
  initialGroupId?: string | null;
}

const OLLAMA_ID = 'ollama';

/** Reuse the sidebar status-pill palette for arena response states. */
const STATUS_PILL_CLASS: Record<string, string> = {
  running: 'working',
  done: 'idle',
  error: 'error',
};

function columnText(text: string, status: string): string {
  if (text) return text;
  return status === 'running' ? '…' : '';
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatTokens(input: number | null, output: number | null): string {
  if (input === null && output === null) return '—';
  return `${input ?? '?'} in / ${output ?? '?'} out`;
}

function formatCost(costUsd: number | null): string {
  // Subscription-backed CLI runs don't bill the user; the CLI-reported figure
  // is the API-equivalent price of the same call.
  if (costUsd === null) return 'included';
  return `included (API-equiv $${costUsd.toFixed(4)})`;
}

/**
 * Arena mode (#100): one prompt fanned out to the selected contestants,
 * streamed side-by-side with latency/token/cost metrics. Runs persist and
 * can be reloaded from the history dropdown.
 */
export const ArenaPanel: React.FC<ArenaPanelProps> = ({ onClose, groups, initialGroupId }) => {
  const [prompt, setPrompt] = useState('');
  const [contestants, setContestants] = useState<{ id: string; name: string; available: boolean }[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [run, setRun] = useState<ArenaRun | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<ArenaRun[]>([]);
  // '' = no folder scope; otherwise a group id from folderOptions.
  const [folderGroupId, setFolderGroupId] = useState<string>(initialGroupId ?? '');
  const runIdRef = useRef<string | null>(null);

  const folderOptions = useMemo(() => buildFolderOptions(groups), [groups]);
  const scopedDir = folderOptions.find(o => o.groupId === folderGroupId)?.dir ?? null;

  // "Ask Arena" from a group's context menu retargets an already-open panel.
  useEffect(() => {
    if (initialGroupId) setFolderGroupId(initialGroupId);
  }, [initialGroupId]);

  // Contestant list: detected provider CLIs plus the local Ollama daemon.
  useEffect(() => {
    window.electronAPI.detectProviders()
      .then((statuses: ProviderStatus[]) => {
        const cli = statuses.map(s => ({ id: s.id, name: s.name, available: s.installed }));
        const all = [...cli, { id: OLLAMA_ID, name: 'Ollama (local)', available: true }];
        setContestants(all);
        setSelected(new Set(cli.filter(c => c.available).map(c => c.id)));
      })
      .catch(() => setContestants([{ id: OLLAMA_ID, name: 'Ollama (local)', available: true }]));
    window.electronAPI.arenaListRuns().then(setHistory).catch(() => setHistory([]));
  }, []);

  const refreshHistory = useCallback(() => {
    window.electronAPI.arenaListRuns().then(setHistory).catch(() => undefined);
  }, []);

  // Live streaming updates for the active run.
  const handleUpdate = useCallback((update: ArenaUpdate) => {
    if (update.runId !== runIdRef.current) return;
    setRun(prev => (prev ? applyArenaUpdate(prev, update) : prev));
  }, []);

  useEffect(() => window.electronAPI.onArenaUpdate(handleUpdate), [handleUpdate]);

  // When every column has settled, unlock the Run button and refresh history.
  useEffect(() => {
    if (running && run && run.id === runIdRef.current && isRunSettled(run)) {
      setRunning(false);
      refreshHistory();
    }
  }, [run, running, refreshHistory]);

  const startRun = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || selected.size === 0 || running) return;
    setRunning(true);
    try {
      // Two-phase: subscribe with the run id BEFORE contestants launch, so
      // even an instantly-failing CLI's updates are never dropped.
      const newRun = await window.electronAPI.arenaStart(trimmed, Array.from(selected), scopedDir);
      runIdRef.current = newRun.id;
      setRun(newRun);
      await window.electronAPI.arenaLaunch(newRun.id);
    } catch (error) {
      console.error('Arena start failed:', error);
      setRunning(false);
    }
  }, [prompt, selected, running, scopedDir]);

  const cancelRun = useCallback(() => {
    if (runIdRef.current) {
      window.electronAPI.arenaCancel(runIdRef.current).catch(() => undefined);
    }
  }, []);

  const loadHistoryRun = useCallback(async (id: string) => {
    if (!id) return;
    const loaded = await window.electronAPI.arenaGetRun(id);
    if (loaded) {
      runIdRef.current = null; // viewing history — ignore live updates
      setRun(loaded);
      setPrompt(loaded.prompt);
      setRunning(false);
    }
  }, []);

  const toggleContestant = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  return (
    <div className="arena-panel">
      <div className="arena-header">
        <h2>Arena</h2>
        <span className="arena-subtitle">
          One prompt, every agent — runs use each CLI's own login/subscription.
        </span>
        <select
          className="arena-history-select"
          value=""
          onChange={e => loadHistoryRun(e.target.value)}
          aria-label="Run history"
        >
          <option value="">History…</option>
          {history.map(h => (
            <option key={h.id} value={h.id}>
              {new Date(h.createdAt).toLocaleString()} — {h.prompt.slice(0, 60)}
            </option>
          ))}
        </select>
        <button className="icon-button" onClick={onClose} aria-label="Close arena">✕</button>
      </div>

      <div className="arena-controls">
        <textarea
          className="arena-prompt"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          placeholder="Ask every agent the same thing…"
          rows={3}
        />
        <div className="arena-contestants">
          <select
            className="arena-folder-select"
            value={folderGroupId}
            onChange={e => setFolderGroupId(e.target.value)}
            title="Run inside a project folder so agents answer about that codebase"
            aria-label="Project folder scope"
          >
            <option value="">No folder (generic)</option>
            {folderOptions.map(o => (
              <option key={o.groupId} value={o.groupId}>{o.label}</option>
            ))}
          </select>
          {contestants.map(c => (
            <label key={c.id} className={`arena-contestant ${c.available ? '' : 'unavailable'}`}>
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                disabled={!c.available}
                onChange={() => toggleContestant(c.id)}
              />
              {c.name}{c.available ? '' : ' (not installed)'}
            </label>
          ))}
          <button
            className="confirm-btn arena-run-button"
            onClick={running ? cancelRun : startRun}
            disabled={!running && (!prompt.trim() || selected.size === 0)}
          >
            {running ? 'Cancel' : 'Run'}
          </button>
        </div>
      </div>

      {run?.workingDir && (
        <div className="arena-run-scope" title={run.workingDir}>
          📁 {run.workingDir}
        </div>
      )}

      <div className="arena-results">
        {run?.responses.map(r => (
          <div key={r.id} className={`arena-column ${r.status}`}>
            <div className="arena-column-header">
              <span className="arena-column-name">{r.provider}</span>
              <span className={`status-pill ${STATUS_PILL_CLASS[r.status]}`}>
                {r.status}
              </span>
            </div>
            <div className="arena-column-metrics">
              <span title="Time to first token">TTFT {formatMs(r.ttftMs)}</span>
              <span title="Total duration">total {formatMs(r.totalMs)}</span>
              <span title="Token usage">{formatTokens(r.inputTokens, r.outputTokens)}</span>
              <span title="Runs bill against the CLI's own subscription — no direct cost. When the CLI reports a figure, it's what the same call would cost on the provider's API.">
                {formatCost(r.costUsd)}
              </span>
            </div>
            {r.error && <div className="arena-column-error">{r.error}</div>}
            <pre className="arena-column-text">{columnText(r.text, r.status)}</pre>
          </div>
        ))}
        {!run && (
          <div className="arena-empty">
            Pick contestants, write a prompt, and hit Run to compare responses,
            latency, tokens, and cost side-by-side.
          </div>
        )}
      </div>
    </div>
  );
};
