import React, { useCallback, useEffect, useState } from 'react';
import { RunArmResult, RunPrepareResult } from '../../shared/types';
import './RunPrepare.css';

/**
 * Starting a run from nothing (CO-722).
 *
 * `RunArm` operates an initiative the harness already set up; this is the step
 * before it, so a person never has to open a terminal. Pick a repo, name the
 * issue, and the app runs the harness's own bootstrap (init-task then spawn)
 * and, on success, arms the run it produced. The loop drives it from there.
 *
 * Everything that can go wrong -- the machine not yet configured, a bad issue
 * name, a repo not cloned where the workspace root says -- comes back as the
 * same "here is what to fix" list the rest of the run engine uses, because a
 * half-prepared initiative is not a state a person should have to reason about.
 */
interface RunPrepareProps {
  /** Injected in tests; the real ones are the IPC channel. */
  listRepos?: () => Promise<string[]>;
  prepare?: (issueId: string, repo: string, budgetUsd?: number) => Promise<RunPrepareResult>;
  arm?: (initiativeDir: string) => Promise<RunArmResult>;
  /** Told once a run is armed, so the inbox beside this can refresh. */
  onArmed?: () => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'working'; step: 'preparing' | 'arming' }
  | { kind: 'refused'; refusals: { what: string; fix: string }[]; log?: string }
  | { kind: 'armed'; result: Extract<RunArmResult, { status: 'armed' }> }
  | { kind: 'error'; message: string };

/** The action button's label for a phase; a plain lookup rather than a nested ternary. */
function startLabel(phase: Phase): string {
  if (phase.kind !== 'working') return 'Prepare & arm';
  return phase.step === 'preparing' ? 'Preparing…' : 'Arming…';
}

export const RunPrepare: React.FC<RunPrepareProps> = ({ listRepos, prepare, arm, onArmed }) => {
  const [repos, setRepos] = useState<string[]>([]);
  const [issueId, setIssueId] = useState('');
  const [repo, setRepo] = useState('');
  const [budget, setBudget] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    const load = listRepos ?? window.electronAPI.listHarnessRepos;
    load().then(setRepos).catch(() => setRepos([]));
  }, [listRepos]);

  const busy = phase.kind === 'working';

  const start = useCallback(async () => {
    // A typed-but-unparseable budget is a mistake to surface, not to drop: an
    // empty field means "use the harness default", but "50o" means the person
    // meant a number and got it wrong.
    const budgetText = budget.trim();
    let budgetUsd: number | undefined;
    if (budgetText) {
      const parsed = Number(budgetText);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setPhase({ kind: 'error', message: `"${budgetText}" is not a valid budget. Leave it blank for the harness default.` });
        return;
      }
      budgetUsd = parsed;
    }
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
  }, [arm, budget, issueId, onArmed, prepare, repo]);

  const canStart = issueId.trim().length > 0 && repo.trim().length > 0 && !busy;

  return (
    <div className="run-prepare">
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
        <button type="button" className="run-prepare__start" disabled={!canStart} onClick={() => void start()}>
          {startLabel(phase)}
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
