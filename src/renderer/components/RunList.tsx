import React, { useCallback, useEffect, useState } from 'react';
import { RunActiveRow } from '../../shared/types';
import { waitedFor } from './RunInbox';
import './RunList.css';

/**
 * What the engine is working on (CO-722).
 *
 * The complement of the inbox: the inbox answers "does anything need me?", this
 * answers "what is the engine doing?". It exists because a cross-repo run spends
 * minutes in `preparing` while it scopes and drives `arch` -- a phase the inbox
 * excludes (nothing needs a person yet), so without this list the run is
 * invisible exactly while the most is happening. Read-only, like the inbox.
 *
 * Rows the inbox already shows (a run that needs THIS person) are filtered out
 * here, so a run appears in one place or the other, not both.
 */

/** The states the inbox owns; this list leaves them to it. */
const IN_INBOX = new Set(['waitingPermission', 'waitingHumanGate', 'inconclusive']);

/** A cross-repo run's bootstrap phase, in the words a person reads. */
const BOOTSTRAP_PHASE: Record<string, string> = {
  scoping: 'Scoping…',
  architecting: 'Architecting seams…',
  awaitingManifest: 'Awaiting manifest approval',
  spawning: 'Spawning worktrees…',
  done: 'Starting…',
};

/** A run's state, as a friendly label when it is not in a bootstrap phase. */
const STATE_LABEL: Record<string, string> = {
  preparing: 'Preparing…',
  provisioning: 'Provisioning…',
  running: 'Running',
  waitingChecks: 'Waiting on checks',
  waitingReview: 'Waiting on review',
  reviewNotRequested: 'Requesting review',
  approved: 'Approved',
};

/**
 * The phase a run is in, for display. A multi run mid-bootstrap reads by its
 * bootstrap phase ("Architecting seams…"); everything else reads by its state.
 */
export function phaseFor(row: RunActiveRow): string {
  if (row.kind === 'multi' && row.bootstrapState) {
    return BOOTSTRAP_PHASE[row.bootstrapState] ?? STATE_LABEL[row.state] ?? row.state;
  }
  return STATE_LABEL[row.state] ?? row.state;
}

interface RunListProps {
  /** Injected in tests; the real one is the read-only IPC channel. */
  load?: () => Promise<RunActiveRow[]>;
  /** Injected in tests so "3m" is not a clock the suite races. */
  now?: () => number;
  pollMs?: number;
}

export const RunList: React.FC<RunListProps> = ({ load, now, pollMs }) => {
  const [rows, setRows] = useState<RunActiveRow[] | null>(null);

  const fetch = useCallback(async () => {
    try {
      const next = await (load ? load() : window.electronAPI.getActiveRuns());
      setRows(next);
    } catch {
      // A failed refresh keeps the last list rather than blanking it: a stale
      // "what's running" is better than a flash of nothing.
    }
  }, [load]);

  useEffect(() => {
    void fetch();
    const timer = setInterval(() => void fetch(), pollMs ?? 5_000);
    return () => clearInterval(timer);
  }, [fetch, pollMs]);

  // Nothing rendered until the first read: an empty list before loading would
  // read as "nothing running" when the truth is "not asked yet".
  if (rows === null) return null;
  const inFlight = rows.filter((row) => !IN_INBOX.has(row.state));
  // When nothing is in flight, render nothing -- the inbox below carries the
  // "you're all caught up" message, and two empty panels is one too many.
  if (inFlight.length === 0) return null;

  const clock = (now ?? Date.now)();
  return (
    <div className="run-list">
      <h2>
        {inFlight.length} run{inFlight.length === 1 ? '' : 's'} in flight
      </h2>
      <ul className="run-list__items">
        {inFlight.map((row) => (
          <li key={row.id} className={`run-list__row run-list__row--${row.state}`}>
            <div className="run-list__head">
              <span className="run-list__key">{row.initiativeKey || row.id}</span>
              <span className="run-list__phase">{phaseFor(row)}</span>
              <span className="run-list__since" title={row.since}>
                {waitedFor(row.since, clock)}
              </span>
            </div>
            {row.repos.length > 0 && <p className="run-list__repos">{row.repos.join(', ')}</p>}
            {row.blockedReason && <p className="run-list__reason">{row.blockedReason}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
};
