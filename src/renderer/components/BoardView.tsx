import React, { useCallback, useEffect, useState } from 'react';
import { BoardInitiative, BoardResult, RunCrossRepoPrepareResult } from '../../shared/types';
import './BoardView.css';

/**
 * The board (board-driven orchestration).
 *
 * A view onto a GitHub Projects v2 board: the project's initiatives, which repos
 * each touches (cross-repo children grouped under their initiative), each one's
 * Status + Priority, and which are **eligible** to start (the "Approved for
 * Development" gate). Eligible ones carry an **Initiate** button (Phase 4) that
 * creates a cross-repo run from the initiative; the rest are read-only.
 */

/** Friendly label for a Status value; unknown values pass through. */
const STATUS_LABEL: Record<string, string> = {
  Todo: 'Todo',
  'In Progress': 'In progress',
  Done: 'Done',
  Approved: 'Approved',
};

/** Priority order for sorting the eligible queue (highest first); unknown/absent sort last. */
const PRIORITY_RANK: Record<string, number> = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
const priorityRank = (p: string | null): number => (p !== null && p in PRIORITY_RANK ? PRIORITY_RANK[p] : 99);

interface BoardViewProps {
  /** Injected in tests; the real one is the read-only IPC channel. */
  load?: (projectNumber?: number) => Promise<BoardResult>;
  /** Injected in tests; the real one creates a cross-repo run from the initiative. */
  initiate?: (projectNumber: number, repo: string, issueNumber: number) => Promise<RunCrossRepoPrepareResult>;
  projectNumber?: number;
  pollMs?: number;
}

/** Per-initiative initiate feedback, keyed by `repo#number`. */
type InitiateState = { kind: 'busy' } | { kind: 'started' } | { kind: 'error'; reason: string };

export const BoardView: React.FC<BoardViewProps> = ({ load, initiate, projectNumber, pollMs }) => {
  const [result, setResult] = useState<BoardResult | null>(null);
  const [initiated, setInitiated] = useState<Record<string, InitiateState>>({});

  const refresh = useCallback(async () => {
    try {
      const next = await (load ?? window.electronAPI.getProjectBoard)(projectNumber);
      setResult(next);
    } catch (err) {
      setResult({ status: 'problem', problem: err instanceof Error ? err.message : String(err) });
    }
  }, [load, projectNumber]);

  const onInitiate = useCallback(async (boardNumber: number, init: BoardInitiative) => {
    const key = `${init.item.repo}#${init.item.number}`;
    setInitiated((s) => ({ ...s, [key]: { kind: 'busy' } }));
    try {
      const res = await (initiate ?? window.electronAPI.initiateFromBoard)(boardNumber, init.item.repo, init.item.number);
      setInitiated((s) => ({
        ...s,
        [key]: res.status === 'prepared'
          ? { kind: 'started' }
          : { kind: 'error', reason: res.refusals.map((r) => `${r.what} — ${r.fix}`).join('; ') },
      }));
    } catch (err) {
      setInitiated((s) => ({ ...s, [key]: { kind: 'error', reason: err instanceof Error ? err.message : String(err) } }));
    }
  }, [initiate]);

  useEffect(() => {
    void refresh();
    // A board changes on GitHub's timescale, not the app's; a slow poll keeps it
    // fresh without spending the API budget. Read-only, so nothing races.
    const timer = setInterval(() => void refresh(), pollMs ?? 60_000);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  if (result === null) return <div className="board board--loading">Reading the board…</div>;

  if (result.status === 'problem') {
    return (
      <div className="board board--problem" role="alert">
        <h2>The board could not be read</h2>
        <p>{result.problem}</p>
        <button type="button" onClick={() => void refresh()}>Try again</button>
      </div>
    );
  }

  const { project } = result;
  // Eligible initiatives surface highest-priority-first — the order the driving
  // phases will pull them in.
  const eligible = project.initiatives
    .filter((i) => i.eligible)
    .sort((a, b) => priorityRank(a.item.priority) - priorityRank(b.item.priority));
  const rest = project.initiatives.filter((i) => !i.eligible);

  return (
    <div className="board">
      <h2 className="board__title">
        {project.title} <span className="board__count">· {project.initiatives.length} initiatives</span>
      </h2>

      {project.initiatives.length === 0 && (
        <p className="board__empty">No initiatives on this board yet.</p>
      )}

      {eligible.length > 0 && (
        <section className="board__section">
          <h3 className="board__section-head">Ready to start ({eligible.length})</h3>
          <ul className="board__list">
            {eligible.map((init) => (
              <li key={`${init.item.repo}#${init.item.number}`} className="board__init board__init--eligible">
                <Initiative
                  init={init}
                  initiate={() => void onInitiate(project.number, init)}
                  initiateState={initiated[`${init.item.repo}#${init.item.number}`]}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {rest.length > 0 && (
        <section className="board__section">
          <h3 className="board__section-head">Other initiatives ({rest.length})</h3>
          <ul className="board__list">
            {rest.map((init) => (
              <li key={`${init.item.repo}#${init.item.number}`} className="board__init">
                <Initiative init={init} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

const Initiative: React.FC<{
  init: BoardInitiative;
  initiate?: () => void;
  initiateState?: InitiateState;
}> = ({ init, initiate, initiateState }) => {
  const { item, children, repos, eligible } = init;
  // A run already exists for this initiative (annotated from the DB, so it
  // survives navigating away and back — unlike the ephemeral initiateState).
  // It takes precedence over the Initiate button so the same initiative can't be
  // started twice.
  const running = init.inProgress === true;
  return (
    <>
      <div className="board__init-head">
        {eligible && <span className="board__badge">Ready</span>}
        {item.priority && <span className={`board__priority board__priority--${item.priority.toLowerCase()}`}>{item.priority}</span>}
        <a className="board__init-title" href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
        {item.approval && <span className="board__approval">{item.approval}</span>}
        {item.status && <span className={`board__status board__status--${item.status.replace(/\s+/g, '-').toLowerCase()}`}>{STATUS_LABEL[item.status] ?? item.status}</span>}
        {running && <span className="board__initiated">In progress</span>}
        {!running && initiate && initiateState?.kind !== 'started' && (
          <button type="button" className="board__initiate" disabled={initiateState?.kind === 'busy'} onClick={initiate}>
            {initiateState?.kind === 'busy' ? 'Initiating…' : 'Initiate'}
          </button>
        )}
        {!running && initiateState?.kind === 'started' && <span className="board__initiated">Started ✓</span>}
      </div>
      {initiateState?.kind === 'error' && <p className="board__initiate-error" role="alert">{initiateState.reason}</p>}
      <p className="board__repos">
        {repos.length > 1 ? `${repos.length} repos: ` : ''}{repos.join(' · ')}
      </p>
      {children.length > 0 && (
        <ul className="board__children">
          {children.map((c) => (
            <li key={`${c.repo}#${c.number}`} className="board__child">
              <span className="board__child-repo">{c.repo}</span>
              <a href={c.url} target="_blank" rel="noreferrer">#{c.number}</a>
              {c.status && <span className="board__child-status">{STATUS_LABEL[c.status] ?? c.status}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
};
