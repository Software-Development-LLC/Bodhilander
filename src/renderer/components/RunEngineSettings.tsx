import React, { useCallback, useEffect, useState } from 'react';
import { RUN_ENGINE_PREF_KEYS } from '../../shared/types';
import './RunEngineSettings.css';

/**
 * Machine settings for the run engine (CO-722).
 *
 * These are what the run loop resolves before it can launch a gate or prepare
 * an initiative: the three binaries it shells out to, who reviews are sent to,
 * and the three paths preparing a run needs. Each is stored as a preference and
 * read preference -> `BODHI_*` env -> default, so a machine that already
 * exports the env keeps working and this is simply the friendlier way to set
 * them.
 *
 * Self-contained the way `ProviderSettings` is: it loads and saves its own
 * preferences through the generic `getPreference`/`setPreference` channel, so
 * the parent modal only has to render it. Each field saves on blur -- there is
 * no separate Save button to forget, and a path is not worth re-persisting on
 * every keystroke.
 */

interface FieldSpec {
  key: string;
  label: string;
  placeholder: string;
  hint: string;
}

const BINARY_FIELDS: FieldSpec[] = [
  { key: RUN_ENGINE_PREF_KEYS.claudePath, label: 'claude path', placeholder: 'claude', hint: 'The Claude CLI the loop launches gates with. A bare name is resolved on PATH.' },
  { key: RUN_ENGINE_PREF_KEYS.ghPath, label: 'gh path', placeholder: 'gh', hint: 'The GitHub CLI every check and review reads through.' },
  { key: RUN_ENGINE_PREF_KEYS.pythonPath, label: 'python path', placeholder: 'python', hint: 'The interpreter the harness scripts run under. On Windows, avoid the Store alias.' },
];

const PATH_FIELDS: FieldSpec[] = [
  { key: RUN_ENGINE_PREF_KEYS.harnessPath, label: 'harness path', placeholder: 'C:\\work\\repos\\claude-team-workflow', hint: 'The claude-team-workflow clone. Needed to prepare a run and to list its repos.' },
  { key: RUN_ENGINE_PREF_KEYS.bodhiRoot, label: 'workspace root (BODHI_ROOT)', placeholder: 'C:\\work\\repos', hint: 'The folder holding the repo clones worktrees are cut from.' },
  { key: RUN_ENGINE_PREF_KEYS.initiativesRoot, label: 'initiatives folder', placeholder: 'C:\\work\\initiatives', hint: 'Where a prepared initiative is written.' },
];

export const RunEngineSettings: React.FC = () => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const keys = [...BINARY_FIELDS, ...PATH_FIELDS].map((f) => f.key).concat(RUN_ENGINE_PREF_KEYS.approvers);
    Promise.all(keys.map((k) => window.electronAPI.getPreference(k)))
      .then((loaded) => {
        if (!live) return;
        const next: Record<string, string> = {};
        keys.forEach((k, i) => { next[k] = loaded[i] ?? ''; });
        setValues(next);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const set = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(async (key: string) => {
    try {
      await window.electronAPI.setPreference(key, (values[key] ?? '').trim());
      setSaved(key);
      window.setTimeout(() => setSaved((s) => (s === key ? null : s)), 1500);
    } catch {
      // A failed save is not silent data loss: the field keeps the typed value,
      // and the next blur retries. Nothing here is lost by not persisting once.
    }
  }, [values]);

  const field = (f: FieldSpec) => (
    <label key={f.key} className="run-engine-settings__field">
      <span className="run-engine-settings__label">
        {f.label}
        {saved === f.key && <span className="run-engine-settings__saved"> saved</span>}
      </span>
      <input
        type="text"
        value={values[f.key] ?? ''}
        placeholder={f.placeholder}
        onChange={(e) => set(f.key, e.target.value)}
        onBlur={() => void save(f.key)}
      />
      <span className="run-engine-settings__hint">{f.hint}</span>
    </label>
  );

  return (
    <div className="run-engine-settings">
      <p className="run-engine-settings__intro">
        The run engine reads each of these as a preference first, then the matching <code>BODHI_*</code>{' '}
        environment variable, then a built-in default. Leave one blank to fall back to the env or default.
      </p>

      <h3>Tools</h3>
      {BINARY_FIELDS.map(field)}

      <h3>Reviews</h3>
      <label className="run-engine-settings__field">
        <span className="run-engine-settings__label">
          approvers
          {saved === RUN_ENGINE_PREF_KEYS.approvers && <span className="run-engine-settings__saved"> saved</span>}
        </span>
        <input
          type="text"
          value={values[RUN_ENGINE_PREF_KEYS.approvers] ?? ''}
          placeholder="alice, bob"
          onChange={(e) => set(RUN_ENGINE_PREF_KEYS.approvers, e.target.value)}
          onBlur={() => void save(RUN_ENGINE_PREF_KEYS.approvers)}
        />
        <span className="run-engine-settings__hint">
          Comma-separated GitHub usernames a review request is sent to. The engine refuses a review gate clearly
          when this is empty.
        </span>
      </label>

      <h3>Preparing a run</h3>
      {PATH_FIELDS.map(field)}
    </div>
  );
};
