import React, { useCallback, useState } from 'react';
import { RunArmResult } from '../../shared/types';
import './RunArm.css';

/**
 * Starting a run from the app (CO-722).
 *
 * A person picks a prepared initiative directory -- one `init-task.sh` and
 * `spawn.sh` have already set up -- and the engine checks the machine and
 * writes the run's rows, or refuses with a list of what to fix. Nothing is
 * launched here: the loop picks the armed run up on its next tick, and the
 * first gate it launches is the first thing that spends anything.
 *
 * The refusal list is the interesting state, not an error page: arming checks
 * everything before writing anything so a person fixes one machine once, and
 * the list is that whole check. It is shown in full.
 */
interface RunArmProps {
  /** Injected in tests; the real ones are the IPC channel. */
  pick?: () => Promise<string | null>;
  arm?: (initiativeDir: string) => Promise<RunArmResult>;
  /** Told once a run is armed, so the inbox beside this can refresh. */
  onArmed?: () => void;
}

export const RunArm: React.FC<RunArmProps> = ({ pick, arm, onArmed }) => {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunArmResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const chosen = await (pick ?? window.electronAPI.pickInitiativeDir)();
      if (chosen === null) return; // cancelled — not an error, not a result
      const armed = await (arm ?? window.electronAPI.armRun)(chosen);
      setResult(armed);
      if (armed.status === 'armed') onArmed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [arm, onArmed, pick]);

  return (
    <div className="run-arm">
      <button type="button" className="run-arm__start" disabled={busy} onClick={() => void start()}>
        {busy ? 'Arming…' : 'Arm a run…'}
      </button>

      {error !== null && (
        <p className="run-arm__error" role="alert">
          Could not arm: {error}
        </p>
      )}

      {result?.status === 'armed' && (
        // <output> carries role="status" implicitly and is announced more
        // reliably by assistive tech than a div with the role tacked on (S6819).
        <output className="run-arm__armed">
          <p>
            Armed <strong>{result.initiativeKey || result.runId}</strong>. The engine will drive it.
          </p>
          <ul>
            {Object.entries(result.owners).map(([repo, agent]) => (
              <li key={repo}>
                {repo} → {agent}
              </li>
            ))}
          </ul>
          {result.mergeOrder && result.mergeOrder.length > 1 && (
            <p className="run-arm__merge-order">
              Merge order: {result.mergeOrder.join(' → ')}
            </p>
          )}
        </output>
      )}

      {result?.status === 'refused' && (
        <div className="run-arm__refused" role="alert">
          <p>Not armed. Nothing was written. Fix these and try again:</p>
          <ul>
            {result.refusals.map((r) => (
              // Keyed by the reason itself: the list is a set of distinct
              // things to fix, so the text is the identity, not the position.
              <li key={`${r.what}::${r.fix}`}>
                <span className="run-arm__what">{r.what}</span>
                <span className="run-arm__fix">{r.fix}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
