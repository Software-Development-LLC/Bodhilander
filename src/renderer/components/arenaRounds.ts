import { ArenaResponse, ArenaRun } from '../../shared/types';

/**
 * Round-aware view of an arena run: one column per provider holding its
 * responses in round order. Pure — extracted from ArenaPanel for direct
 * unit testing.
 */
export interface ArenaColumn {
  provider: string;
  /** This provider's responses, round-ascending. */
  responses: ArenaResponse[];
  /** The response driving the column's header pill (latest round). */
  latest: ArenaResponse;
}

export function buildColumns(run: ArenaRun): ArenaColumn[] {
  const byProvider = new Map<string, ArenaResponse[]>();
  // run.responses arrive round-then-provider ordered from the repo; live
  // follow-up rows are appended in round order too, so per-provider lists
  // stay round-ascending either way.
  for (const response of run.responses) {
    const list = byProvider.get(response.provider);
    if (list) {
      list.push(response);
    } else {
      byProvider.set(response.provider, [response]);
    }
  }
  return Array.from(byProvider, ([provider, responses]) => ({
    provider,
    responses,
    latest: responses[responses.length - 1],
  }));
}

/**
 * True when a settled run has at least one column that can continue: the
 * provider's latest round finished cleanly and left something to resume —
 * a CLI session ref, or (Ollama) prior text to replay as chat history.
 * The engine re-checks this authoritatively; here it only gates the reply UI.
 */
export function canFollowUp(run: ArenaRun): boolean {
  if (run.responses.some((r) => r.status === 'running')) return false;
  return buildColumns(run).some(
    ({ latest }) => latest.status === 'done' && (latest.sessionRef !== null || latest.text.length > 0)
  );
}
