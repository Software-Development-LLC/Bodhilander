import React, { useCallback, useEffect, useState } from 'react';
import { RunInboxRow } from '../../shared/types';
import './RunInbox.css';

/**
 * What needs a person, and why (CO-722).
 *
 * The engine decides, acts and waits on its own. This is the one surface that
 * answers the question a person actually has — *is anything waiting on me?* —
 * and the answer it gives most of the time should be no.
 *
 * So an empty inbox is the good state and says so, rather than reading as a
 * feature that has not loaded. Everything here is read-only: there is no
 * control that starts, stops or advances a run, because the channel behind it
 * has none either.
 */

/** What each state means to the person reading it, not to the machine. */
const WHY: Record<string, string> = {
  waitingPermission: 'a tool is asking for permission',
  waitingHumanGate: 'waiting for you to approve the gate',
  inconclusive: 'stopped — nobody could establish an answer',
};

/**
 * How long a run has been waiting, in the units a person thinks in.
 *
 * Rounded down and never smaller than a minute: "waiting 43 seconds" invites
 * watching it, and nothing here changes in seconds.
 */
export function waitedFor(since: string, now: number): string {
  const started = Date.parse(since);
  if (Number.isNaN(started)) return 'unknown';
  const minutes = Math.floor((now - started) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The line under a run's name.
 *
 * A blocked run's own reason beats anything this file could write: it was
 * composed where the run stopped, by whatever knew why. The state description
 * is the fallback for runs that are waiting rather than stopped.
 */
export function reasonFor(row: RunInboxRow): string {
  return row.blockedReason ?? WHY[row.state] ?? row.state;
}

interface RunInboxProps {
  /** Injected in tests; the real one is the read-only IPC channel. */
  load?: () => Promise<RunInboxRow[]>;
  /** Injected in tests so "waiting 2h" is not a clock the suite races. */
  now?: () => number;
}

export const RunInbox: React.FC<RunInboxProps> = ({ load, now }) => {
  const [rows, setRows] = useState<RunInboxRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    try {
      const next = await (load ?? window.electronAPI.getRunInbox)();
      setRows(next);
      setFailed(null);
    } catch (err) {
      // Shown, not swallowed. An inbox that fails to load and renders empty
      // says "nothing needs you" — the one wrong answer it can give.
      setFailed(err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  useEffect(() => {
    void fetch();
    // A run enters the inbox when the engine stops it, which this window has
    // no way of being told about yet. A minute is far below anything a person
    // is waiting on and far above anything that costs.
    const timer = setInterval(() => void fetch(), 60_000);
    return () => clearInterval(timer);
  }, [fetch]);

  if (failed !== null) {
    return (
      <div className="run-inbox run-inbox--problem" role="alert">
        <h2>The inbox could not be read</h2>
        <p>{failed}</p>
        <button type="button" onClick={() => void fetch()}>Try again</button>
      </div>
    );
  }

  if (rows === null) {
    return <div className="run-inbox run-inbox--loading">Reading the inbox…</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="run-inbox run-inbox--empty">
        <h2>Nothing is waiting on you</h2>
        <p>Runs appear here when they stop and need a person.</p>
      </div>
    );
  }

  const clock = (now ?? Date.now)();
  return (
    <div className="run-inbox">
      <h2>
        {rows.length} run{rows.length === 1 ? '' : 's'} waiting on you
      </h2>
      <ul className="run-inbox__list">
        {rows.map((row) => (
          <li key={row.id} className={`run-inbox__row run-inbox__row--${row.state}`}>
            <div className="run-inbox__head">
              <span className="run-inbox__key">{row.initiativeKey || row.id}</span>
              <span className="run-inbox__waited" title={row.since}>
                {waitedFor(row.since, clock)}
              </span>
            </div>
            <p className="run-inbox__reason">{reasonFor(row)}</p>
            {row.repos.length > 0 && (
              <p className="run-inbox__repos">{row.repos.join(', ')}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};
