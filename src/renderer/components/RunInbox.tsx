import React, { useCallback, useEffect, useState } from 'react';
import { RunInboxRow, RunPermissionRequest } from '../../shared/types';
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

/**
 * The tool calls a run is blocked on, and the two answers a person can give.
 *
 * This is the one control in the inbox that DOES something: the loop drives
 * everything else, but it cannot answer a permission prompt (that is the
 * whole reason a run reaches this state), so the decision is here. Allow and
 * deny both write into the channel the gate is polling; the loop returns the
 * run to running on the next tick.
 *
 * The tool input is shown WHOLE. A person approving a Bash call is approving
 * its command line, and a shortened view would be asking them to agree to
 * something they had not read.
 */
interface PermissionRequestsProps {
  runId: string;
  /** Injected in tests; the real ones are the IPC channel. */
  loadPermissions?: (runId: string) => Promise<RunPermissionRequest[]>;
  answer?: (runId: string, repo: string, toolUseId: string, verdict: 'allow' | 'deny', message: string) => Promise<boolean>;
  /** Told to refresh the inbox once a decision may have moved the run. */
  onAnswered?: () => void;
  pollMs?: number;
}

export const PermissionRequests: React.FC<PermissionRequestsProps> = ({
  runId,
  loadPermissions,
  answer,
  onAnswered,
  pollMs,
}) => {
  const [requests, setRequests] = useState<RunPermissionRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A denial can carry a reason the model reads back. Kept per request so two
  // pending calls do not share one box; allow needs none (there is nothing to
  // say to an approval), so only deny reads this.
  const [denyReasons, setDenyReasons] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      const load = loadPermissions ?? window.electronAPI.getRunPermissions;
      setRequests(await load(runId));
    } catch {
      // A failed read here is not the page: the row above still shows the run
      // is waiting. Leave whatever was last shown rather than blanking it.
    }
  }, [loadPermissions, runId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs ?? 5_000);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  const decide = useCallback(
    async (repo: string, toolUseId: string, verdict: 'allow' | 'deny') => {
      setBusy(toolUseId);
      try {
        const send = answer ?? window.electronAPI.answerRunPermission;
        // Only a denial carries a message; the broker supplies its own words
        // when this is blank, so an empty reason is a plain deny, not a bug.
        const message = verdict === 'deny' ? (denyReasons[toolUseId] ?? '') : '';
        // The repo names which owner's channel this answer belongs to: two
        // owners can be blocked at once, and this must reach the right one.
        await send(runId, repo, toolUseId, verdict, message);
        await refresh();
        onAnswered?.();
      } finally {
        setBusy(null);
      }
    },
    [answer, denyReasons, onAnswered, refresh, runId],
  );

  if (!requests || requests.length === 0) return null;

  return (
    <ul className="run-inbox__perms">
      {requests.map((req) => (
        <li key={`${req.repo}:${req.toolUseId}`} className="run-inbox__perm">
          <div className="run-inbox__perm-tool">
            <span className="run-inbox__perm-repo">{req.repo}</span> {req.toolName}
          </div>
          <pre className="run-inbox__perm-input">{JSON.stringify(req.input, null, 2)}</pre>
          <div className="run-inbox__perm-actions">
            <button
              type="button"
              className="run-inbox__allow"
              disabled={busy !== null}
              onClick={() => void decide(req.repo, req.toolUseId, 'allow')}
            >
              Allow
            </button>
            <input
              type="text"
              className="run-inbox__deny-reason"
              aria-label="Reason for denying (optional)"
              placeholder="Reason (optional)"
              value={denyReasons[req.toolUseId] ?? ''}
              disabled={busy !== null}
              onChange={(e) =>
                setDenyReasons((prev) => ({ ...prev, [req.toolUseId]: e.target.value }))
              }
            />
            <button
              type="button"
              className="run-inbox__deny"
              disabled={busy !== null}
              onClick={() => void decide(req.repo, req.toolUseId, 'deny')}
            >
              Deny
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
};

interface RunInboxProps {
  /** Injected in tests; the real one is the read-only IPC channel. */
  load?: () => Promise<RunInboxRow[]>;
  /** Injected in tests so "waiting 2h" is not a clock the suite races. */
  now?: () => number;
  /** How often to ask again. A minute in the app; milliseconds in tests. */
  pollMs?: number;
}

export const RunInbox: React.FC<RunInboxProps> = ({ load, now, pollMs }) => {
  const [rows, setRows] = useState<RunInboxRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    try {
      // Called through the object rather than detached. The preload's method
      // does not use `this` today, and a call written this way keeps working
      // if that ever stops being true -- which is the kind of thing that
      // breaks silently.
      const next = await (load ? load() : window.electronAPI.getRunInbox());
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
    const timer = setInterval(() => void fetch(), pollMs ?? 60_000);
    return () => clearInterval(timer);
  }, [fetch, pollMs]);

  // A failure with nothing to fall back on is the whole page: there is no
  // answer to show, and an empty list would be the wrong one.
  if (failed !== null && rows === null) {
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

  // A refresh that failed over a list we already have is a NOTE, not a page.
  // Blanking three waiting runs because the database was briefly locked loses
  // the answer to keep the warning, which is the wrong way round -- the list
  // is a minute stale, and the staleness is what the note says.
  const staleNote = failed !== null && (
    // <output>, not a <p role="status">: it carries that role implicitly and
    // is announced more reliably by assistive technology (S6819). The role is
    // the point here -- a person who cannot see the note is the one most
    // likely to act on a stale list believing it current.
    <output className="run-inbox__stale">
      Could not refresh ({failed}). Showing the last reading.
    </output>
  );

  if (rows.length === 0) {
    return (
      <div className="run-inbox run-inbox--empty">
        <h2>Nothing is waiting on you</h2>
        <p>Runs appear here when they stop and need a person.</p>
        {staleNote}
      </div>
    );
  }

  const clock = (now ?? Date.now)();
  return (
    <div className="run-inbox">
      <h2>
        {rows.length} run{rows.length === 1 ? '' : 's'} waiting on you
      </h2>
      {staleNote}
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
            {row.state === 'waitingPermission' && (
              <PermissionRequests runId={row.id} onAnswered={() => void fetch()} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};
