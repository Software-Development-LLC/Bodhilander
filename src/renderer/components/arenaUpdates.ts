import { ArenaRun, ArenaUpdate } from '../../shared/types';

/**
 * Merge a streaming ArenaUpdate into the run state (#100): append the chunk
 * to the matching response and adopt any newly-reported metrics, keeping
 * previous values where the update carries null. Pure — extracted from
 * ArenaPanel for direct unit testing.
 */
export function applyArenaUpdate(run: ArenaRun, update: ArenaUpdate): ArenaRun {
  return {
    ...run,
    responses: run.responses.map((r) => {
      if (r.id !== update.responseId) return r;
      return {
        ...r,
        text: r.text + update.chunk,
        status: update.status,
        ttftMs: update.ttftMs ?? r.ttftMs,
        totalMs: update.totalMs ?? r.totalMs,
        inputTokens: update.inputTokens ?? r.inputTokens,
        outputTokens: update.outputTokens ?? r.outputTokens,
        costUsd: update.costUsd ?? r.costUsd,
        error: update.error ?? r.error,
      };
    }),
  };
}

/** True when every response in the run has settled (done or error). */
export function isRunSettled(run: ArenaRun): boolean {
  return run.responses.every((r) => r.status !== 'running');
}
