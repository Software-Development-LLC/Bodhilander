import React, { useCallback, useEffect, useState } from 'react';
import { RunArmResult, RunCrossRepoPrepareResult, RunPrepareResult } from '../../shared/types';
import './RunPrepare.css';

/**
 * Starting a run from nothing (CO-722).
 *
 * `RunArm` operates an initiative the harness already set up; this is the step
 * before it, so a person never has to open a terminal.
 *
 * Two modes:
 *  - **Single repo**: pick a repo, name the issue, and the app runs the
 *    harness's own bootstrap (init-task then spawn) and arms the run it
 *    produced. The loop drives it from there.
 *  - **Cross-repo**: pick the repos in scope, name the issue, and the app
 *    creates a `multi` run that the loop bootstraps -- writing team.yaml from the
 *    picks, driving `arch` for the seam manifest, parking for your approval, then
 *    spawning. Nothing is armed eagerly; you watch it in the Runs view.
 *
 * Everything that can go wrong -- the machine not yet configured, a bad issue
 * name, a repo not cloned where the workspace root says -- comes back as the
 * same "here is what to fix" list the rest of the run engine uses.
 */
interface RunPrepareProps {
  /** Injected in tests; the real ones are the IPC channel. */
  listRepos?: () => Promise<string[]>;
  prepare?: (issueId: string, repo: string, budgetUsd?: number) => Promise<RunPrepareResult>;
  prepareCrossRepo?: (issueId: string, repos: string[], budgetUsd?: number) => Promise<RunCrossRepoPrepareResult>;
  arm?: (initiativeDir: string) => Promise<RunArmResult>;
  /** Told once a run is armed or a cross-repo run is created, so the inbox beside this can refresh. */
  onArmed?: () => void;
}

type Mode = 'single' | 'multi';

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; step: 'preparing' | 'arming' | 'bootstrapping' }
  | { kind: 'refused'; refusals: { what: string; fix: string }[]; log?: string }
  | { kind: 'armed'; result: Extract<RunArmResult, { status: 'armed' }> }
  | { kind: 'bootstrapping'; runId: string }
  | { kind: 'error'; message: string };

/** The action button's label for a phase and mode; a plain lookup, not a nested ternary. */
function startLabel(phase: Phase, mode: Mode): string {
  if (phase.kind === 'working') {
    if (phase.step === 'preparing') return 'Preparing…';
    if (phase.step === 'arming') return 'Arming…';
    return 'Starting…';
  }
  return mode === 'multi' ? 'Start bootstrap' : 'Prepare & arm';
}

/** A budget field parsed, or an error message to show. Empty means "harness default". */
function parseBudget(text: string): { ok: true; value?: number } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, message: `"${trimmed}" is not a valid budget. Leave it blank for the harness default.` };
  }
  return { ok: true, value: parsed };
}

export const RunPrepare: React.FC<RunPrepareProps> = ({ listRepos, prepare, prepareCrossRepo, arm, onArmed }) => {
  const [repos, setRepos] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>('single');
  const [issueId, setIssueId] = useState('');
  const [repo, setRepo] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [budget, setBudget] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    const load = listRepos ?? window.electronAPI.listHarnessRepos;
    load().then(setRepos).catch(() => setRepos([]));
  }, [listRepos]);

  const busy = phase.kind === 'working';

  const toggleRepo = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const startSingle = useCallback(async (budgetUsd?: number) => {
    setPhase({ kind: 'working', step: 'preparing' });
    try {
      const runPrepare = prepare ?? window.electronAPI.prepareInitiative;
      const prepared = await runPrepare(issueId.trim(), repo.trim(), budgetUsd);
      if (prepared.status === 'refused') {
        setPhase({ kind: 'refused', refusals: prepared.refusals, log: prepared.log });
        return;
      }
      // Prepared. Arm it straight away -- the whole point was to reach a run.
      setPhase({ kind: 'working', step: 'arming' });
      const armed = await (arm ?? window.electronAPI.armRun)(prepared.initiativeDir);
      if (armed.status === 'armed') {
        setPhase({ kind: 'armed', result: armed });
        onArmed?.();
      } else {
        setPhase({ kind: 'refused', refusals: armed.refusals, log: prepared.log });
      }
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [arm, issueId, onArmed, prepare, repo]);

  const startMulti = useCallback(async (budgetUsd?: number) => {
    setPhase({ kind: 'working', step: 'bootstrapping' });
    try {
      const run = prepareCrossRepo ?? window.electronAPI.prepareCrossRepoRun;
      const result = await run(issueId.trim(), [...selected], budgetUsd);
      if (result.status === 'refused') {
        setPhase({ kind: 'refused', refusals: result.refusals });
        return;
      }
      setPhase({ kind: 'bootstrapping', runId: result.runId });
      onArmed?.();
    } catch (err) {
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [issueId, onArmed, prepareCrossRepo, selected]);

  const start = useCallback(() => {
    // A typed-but-unparseable budget is a mistake to surface, not to drop.
    const parsed = parseBudget(budget);
    if (!parsed.ok) {
      setPhase({ kind: 'error', message: parsed.message });
      return;
    }
    void (mode === 'multi' ? startMulti(parsed.value) : startSingle(parsed.value));
  }, [budget, mode, startMulti, startSingle]);

  const canStart =
    issueId.trim().length > 0 &&
    !busy &&
    (mode === 'multi' ? selected.size > 0 : repo.trim().length > 0);

  return (
    <div className="run-prepare">
      <div className="run-prepare__mode" role="radiogroup" aria-label="Run kind">
        <button
          type="button"
          className={`run-prepare__mode-btn${mode === 'single' ? ' run-prepare__mode-btn--on' : ''}`}
          aria-pressed={mode === 'single'}
          disabled={busy}
          onClick={() => setMode('single')}
        >
          Single repo
        </button>
        <button
          type="button"
          className={`run-prepare__mode-btn${mode === 'multi' ? ' run-prepare__mode-btn--on' : ''}`}
          aria-pressed={mode === 'multi'}
          disabled={busy}
          onClick={() => setMode('multi')}
        >
          Cross-repo
        </button>
      </div>

      <div className="run-prepare__form">
        <label className="run-prepare__field">
          <span>Issue id</span>
          <input
            type="text"
            value={issueId}
            placeholder="BDH-241"
            disabled={busy}
            onChange={(e) => setIssueId(e.target.value)}
          />
        </label>

        {mode === 'single' ? (
          <label className="run-prepare__field">
            <span>Repo</span>
            <input
              type="text"
              list="run-prepare-repos"
              value={repo}
              placeholder={repos.length ? 'Start typing…' : 'Set the harness in Settings first'}
              disabled={busy}
              onChange={(e) => setRepo(e.target.value)}
            />
            <datalist id="run-prepare-repos">
              {repos.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
        ) : (
          <fieldset className="run-prepare__field run-prepare__repos" disabled={busy}>
            <legend>Repos in scope</legend>
            {repos.length === 0 ? (
              <p className="run-prepare__repos-empty">Set the harness in Settings first.</p>
            ) : (
              <div className="run-prepare__repo-list">
                {repos.map((r) => (
                  <label key={r} className="run-prepare__repo">
                    <input type="checkbox" checked={selected.has(r)} onChange={() => toggleRepo(r)} />
                    <span>{r}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}

        <label className="run-prepare__field run-prepare__field--budget">
          <span>Budget $ (optional)</span>
          <input
            type="text"
            inputMode="numeric"
            value={budget}
            placeholder="harness default"
            disabled={busy}
            onChange={(e) => setBudget(e.target.value)}
          />
        </label>
        <button type="button" className="run-prepare__start" disabled={!canStart} onClick={start}>
          {startLabel(phase, mode)}
        </button>
      </div>

      {phase.kind === 'error' && (
        <p className="run-prepare__error" role="alert">
          Could not prepare: {phase.message}
        </p>
      )}

      {phase.kind === 'armed' && (
        <output className="run-prepare__armed">
          <p>
            Prepared and armed <strong>{phase.result.initiativeKey || phase.result.runId}</strong>. The engine will
            drive it.
          </p>
          <ul>
            {Object.entries(phase.result.owners).map(([r, agent]) => (
              <li key={r}>
                {r} → {agent}
              </li>
            ))}
          </ul>
          {phase.result.mergeOrder && phase.result.mergeOrder.length > 1 && (
            <p className="run-prepare__merge-order">
              Merge order: {phase.result.mergeOrder.join(' → ')}
            </p>
          )}
        </output>
      )}

      {phase.kind === 'bootstrapping' && (
        <output className="run-prepare__armed">
          <p>
            Cross-repo run created. The engine is bootstrapping it now — scoping, then the seam manifest, then it will
            ask you to approve before spawning. Watch it in the <strong>Runs</strong> view.
          </p>
        </output>
      )}

      {phase.kind === 'refused' && (
        <div className="run-prepare__refused" role="alert">
          <p>Not prepared. Fix these and try again:</p>
          <ul>
            {phase.refusals.map((r) => (
              <li key={`${r.what}::${r.fix}`}>
                <span className="run-prepare__what">{r.what}</span>
                <span className="run-prepare__fix">{r.fix}</span>
              </li>
            ))}
          </ul>
          {phase.log && <pre className="run-prepare__log">{phase.log}</pre>}
        </div>
      )}
    </div>
  );
};
