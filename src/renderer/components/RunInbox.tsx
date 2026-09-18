import React, { useCallback, useEffect, useState } from 'react';
import { RunInboxRow, RunPermissionRequest, SeamManifest } from '../../shared/types';
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
  failed: 'the run failed',
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
  // Busy is per request, not global: two owners can be blocked at once, and
  // answering one must not disable the other's buttons (CO-722 multi-owner).
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
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
      const key = `${repo}:${toolUseId}`;
      setBusy((prev) => new Set(prev).add(key));
      try {
        const send = answer ?? window.electronAPI.answerRunPermission;
        // Only a denial carries a message; the broker supplies its own words
        // when this is blank, so an empty reason is a plain deny, not a bug.
        const message = verdict === 'deny' ? (denyReasons[key] ?? '') : '';
        // The repo names which owner's channel this answer belongs to: two
        // owners can be blocked at once, and this must reach the right one.
        await send(runId, repo, toolUseId, verdict, message);
        await refresh();
        onAnswered?.();
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [answer, denyReasons, onAnswered, refresh, runId],
  );

  if (!requests || requests.length === 0) return null;

  return (
    <ul className="run-inbox__perms">
      {requests.map((req) => {
        const key = `${req.repo}:${req.toolUseId}`;
        return (
          <li key={key} className="run-inbox__perm">
            <div className="run-inbox__perm-tool">
              <span className="run-inbox__perm-repo">{req.repo}</span> {req.toolName}
            </div>
            <pre className="run-inbox__perm-input">{JSON.stringify(req.input, null, 2)}</pre>
            <div className="run-inbox__perm-actions">
              <button
                type="button"
                className="run-inbox__allow"
                disabled={busy.has(key)}
                onClick={() => void decide(req.repo, req.toolUseId, 'allow')}
              >
                Allow
              </button>
              <input
                type="text"
                className="run-inbox__deny-reason"
                aria-label="Reason for denying (optional)"
                placeholder="Reason (optional)"
                value={denyReasons[key] ?? ''}
                disabled={busy.has(key)}
                onChange={(e) =>
                  setDenyReasons((prev) => ({ ...prev, [key]: e.target.value }))
                }
              />
              <button
                type="button"
                className="run-inbox__deny"
                disabled={busy.has(key)}
                onClick={() => void decide(req.repo, req.toolUseId, 'deny')}
              >
                Deny
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
};

/**
 * A cross-repo run's seam manifest, awaiting approval before spawn (CO-722).
 *
 * The other control the loop cannot make for a person: whether the contracts
 * `arch` proposed are the ones to build against. Approving cuts the worktrees
 * ("the cheap place to be wrong" is here, before that); rejecting parks the run.
 * The manifest is shown WHOLE -- approving it is approving what each repo will
 * build to, and a summary would ask a person to agree to something they had not
 * read.
 */
interface ManifestApprovalProps {
  runId: string;
  /** Injected in tests; the real ones are the IPC channel. */
  loadManifest?: (runId: string) => Promise<SeamManifest | null>;
  approve?: (runId: string) => Promise<boolean>;
  reject?: (runId: string, reason: string) => Promise<boolean>;
  /** Told once a decision may have moved the run, to refresh the inbox. */
  onDecided?: () => void;
}

export const ManifestApproval: React.FC<ManifestApprovalProps> = ({
  runId,
  loadManifest,
  approve,
  reject,
  onDecided,
}) => {
  const [manifest, setManifest] = useState<SeamManifest | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  useEffect(() => {
    const load = loadManifest ?? window.electronAPI.readRunManifest;
    load(runId).then(setManifest).catch(() => setManifest(null));
  }, [loadManifest, runId]);

  const decide = useCallback(
    async (verdict: 'approve' | 'reject') => {
      setBusy(true);
      try {
        if (verdict === 'approve') {
          await (approve ?? window.electronAPI.approveRunManifest)(runId);
        } else {
          await (reject ?? window.electronAPI.rejectRunManifest)(runId, reason);
        }
        onDecided?.();
      } finally {
        setBusy(false);
      }
    },
    [approve, onDecided, reason, reject, runId],
  );

  if (manifest === undefined) return <p className="run-inbox__manifest-loading">Reading the manifest…</p>;
  if (manifest === null) return <p className="run-inbox__manifest-loading">The manifest is not ready yet.</p>;

  return (
    <div className="run-inbox__manifest">
      {manifest.mergeOrder.length > 0 && (
        <p className="run-inbox__merge-order">Merge order: {manifest.mergeOrder.join(' → ')}</p>
      )}
      <pre className="run-inbox__manifest-body">{manifest.seamsYaml}</pre>
      <div className="run-inbox__manifest-actions">
        <button type="button" className="run-inbox__allow" disabled={busy} onClick={() => void decide('approve')}>
          Approve &amp; spawn
        </button>
        <input
          type="text"
          className="run-inbox__deny-reason"
          aria-label="Reason for rejecting (optional)"
          placeholder="Reason (optional)"
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
        <button type="button" className="run-inbox__deny" disabled={busy} onClick={() => void decide('reject')}>
          Reject
        </button>
      </div>
    </div>
  );
};

interface RunInboxProps {
  /** Injected in tests; the real one is the read-only IPC channel. */
  load?: () => Promise<RunInboxRow[]>;
  /** Injected in tests; the real one halts a run over IPC. */
  abandon?: (runId: string) => Promise<boolean>;
  /** Injected in tests so "waiting 2h" is not a clock the suite races. */
  now?: () => number;
  /** How often to ask again. A minute in the app; milliseconds in tests. */
  pollMs?: number;
}

export const RunInbox: React.FC<RunInboxProps> = ({ load, abandon, now, pollMs }) => {
  const [rows, setRows] = useState<RunInboxRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [halting, setHalting] = useState<Set<string>>(new Set());
  // Per-run halt error, so a failed halt is visible rather than a no-op that
  // looks exactly like success. Keyed by run id; cleared when a halt is retried.
  const [haltError, setHaltError] = useState<Record<string, string>>({});

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

  const onHalt = useCallback(async (runId: string) => {
    setHalting((s) => new Set(s).add(runId));
    // Clear any prior error on retry (no unused-binding / delete smell).
    setHaltError((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== runId)));
    try {
      // The boolean result (false = already gone) needs no branch: either way a
      // refresh drops the row from the inbox.
      await (abandon ?? window.electronAPI.abandonRun)(runId);
      await fetch(); // it drops out of the inbox once abandoned
    } catch (err) {
      // A silent no-op catch would look identical to success — the operator
      // would believe a stuck run was halted when it wasn't. Surface it inline.
      setHaltError((e) => ({ ...e, [runId]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setHalting((s) => {
        const next = new Set(s);
        next.delete(runId);
        return next;
      });
    }
  }, [abandon, fetch]);

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
        <h2>Nothing needs your attention</h2>
        <p>Runs appear here when they stop, fail, or need a person.</p>
        {staleNote}
      </div>
    );
  }

  const clock = (now ?? Date.now)();
  return (
    <div className="run-inbox">
      {/* "Attention", not "waiting on you": the inbox now also carries failed
          runs, which are not waiting on anyone — they need to be seen and
          dismissed. */}
      <h2>
        {rows.length} run{rows.length === 1 ? '' : 's'} need{rows.length === 1 ? 's' : ''} your attention
      </h2>
      {staleNote}
      <ul className="run-inbox__list">
        {rows.map((row) => {
          // A failed run has already stopped, so "Halt" (stop driving) makes no
          // sense — the same action (abandon) reads as "Dismiss": acknowledge it
          // and clear it from the list. `isFailed` names exactly that case, not
          // "terminal in general", so a future terminal-but-inbox-visible state
          // has to opt in here rather than inherit this wording.
          const isFailed = row.state === 'failed';
          const busy = halting.has(row.id);
          const verb = isFailed ? 'Dismiss' : 'Halt';
          const gerund = isFailed ? 'Dismissing…' : 'Halting…';
          const actionLabel = busy ? gerund : verb;
          return (
          <li key={row.id} className={`run-inbox__row run-inbox__row--${row.state}`}>
            <div className="run-inbox__head">
              <span className="run-inbox__key">{row.initiativeKey || row.id}</span>
              <span className="run-inbox__waited" title={row.since}>
                {waitedFor(row.since, clock)}
              </span>
              <button
                type="button"
                className="run-inbox__halt"
                disabled={busy}
                onClick={() => void onHalt(row.id)}
                title={isFailed
                  ? 'Acknowledge this failed run and clear it from the list (leaves worktrees in place)'
                  : 'Stop driving this run and clear it from the inbox (leaves worktrees in place)'}
              >
                {actionLabel}
              </button>
            </div>
            {haltError[row.id] && (
              <p className="run-inbox__halt-error" role="alert">
                Could not {verb.toLowerCase()} this run: {haltError[row.id]}
              </p>
            )}
            <p className="run-inbox__reason">{reasonFor(row)}</p>
            {row.repos.length > 0 && (
              <p className="run-inbox__repos">{row.repos.join(', ')}</p>
            )}
            {/* A bypass gate has no in-app allow/deny (no broker), so a person
                answers by attaching to the session. Surface the exact command
                instead of leaving the row with nothing to act on. */}
            {row.owners.filter((o) => o.attachId).map((o) => (
              <p key={o.repo} className="run-inbox__attach">
                Answer it in a terminal: <code>claude attach {o.attachId}</code>
                {row.owners.length > 1 ? ` (${o.repo})` : ''}
              </p>
            ))}
            {row.state === 'waitingPermission' && (
              <PermissionRequests runId={row.id} onAnswered={() => void fetch()} />
            )}
            {row.state === 'waitingHumanGate' && (
              <ManifestApproval runId={row.id} onDecided={() => void fetch()} />
            )}
          </li>
          );
        })}
      </ul>
    </div>
  );
};
