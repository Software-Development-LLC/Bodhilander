/**
 * Run inbox tests (CO-722).
 *
 * The inbox answers one question — is anything waiting on me? — and the
 * answer it gives most of the time is no. So the tests are largely about the
 * ways it could say "no" WRONGLY: a failed load rendering as empty, a stopped
 * run losing the sentence that says why, a wait shown in units nobody thinks
 * in.
 *
 * Run with: bun test src/renderer/components
 */
import { describe, expect, test } from 'bun:test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { RunInbox, PermissionRequests, ManifestApproval, reasonFor, waitedFor } from '../RunInbox';
import type { RunInboxRow, RunPermissionRequest, SeamManifest } from '../../../shared/types';

const NOW = Date.parse('2026-09-14T12:00:00Z');

function row(over: Partial<RunInboxRow> = {}): RunInboxRow {
  return {
    id: 'run-1',
    initiativeKey: 'CO-722',
    state: 'inconclusive',
    blockedReason: null,
    since: '2026-09-14T11:00:00Z',
    repos: [],
    owners: [],
    ...over,
  };
}

describe('what it says when nothing is waiting', () => {
  test('an empty inbox is the good state, and says so', async () => {
    const { container } = render(<RunInbox load={async () => []} now={() => NOW} />);
    await screen.findByText('Nothing needs your attention');
    expect(container.querySelector('.run-inbox--empty')).not.toBeNull();
  });

  test('a failed load does NOT say nothing is waiting', async () => {
    // The one wrong answer this surface can give. An inbox that fails to load
    // and renders empty tells a person everything is fine, which is exactly
    // when it is not.
    render(
      <RunInbox load={async () => { throw new Error('database is locked'); }} now={() => NOW} />,
    );
    await screen.findByRole('alert');
    expect(screen.queryByText('Nothing needs your attention')).toBeNull();
    expect(screen.getByText('database is locked')).toBeTruthy();
  });

  test('and it is not silently empty before it has loaded either', () => {
    // Never resolves: the first paint must not claim an answer it does not
    // have yet.
    render(<RunInbox load={() => new Promise(() => {})} now={() => NOW} />);
    expect(screen.queryByText('Nothing needs your attention')).toBeNull();
  });
});

describe('what it says when something is', () => {
  test('a run is named by its initiative, not its id', async () => {
    render(<RunInbox load={async () => [row()]} now={() => NOW} />);
    await screen.findByText('CO-722');
  });

  test('a run with no initiative key still has something to click', async () => {
    // A run armed against a directory whose team.yaml carries no key would
    // otherwise render as a blank line.
    render(<RunInbox load={async () => [row({ initiativeKey: '' })]} now={() => NOW} />);
    await screen.findByText('run-1');
  });

  test('a blocked run shows the reason it stopped, not a state name', async () => {
    // The run's own sentence was composed where it stopped, by whatever knew
    // why. Anything this file could write instead is a worse answer.
    render(
      <RunInbox
        load={async () => [row({ blockedReason: 'no expected_checks recorded for this repo' })]}
        now={() => NOW}
      />,
    );
    await screen.findByText('no expected_checks recorded for this repo');
  });

  test('a run waiting by design gets a sentence a person can read', async () => {
    render(<RunInbox load={async () => [row({ state: 'waitingPermission' })]} now={() => NOW} />);
    await screen.findByText('a tool is asking for permission');
  });

  test('a state nobody wrote a sentence for still shows something', async () => {
    // Better a bare state name than an empty line: a new state should look
    // unfamiliar, not look like nothing.
    render(<RunInbox load={async () => [row({ state: 'somethingNew' })]} now={() => NOW} />);
    await screen.findByText('somethingNew');
  });

  test('the repos come with it, for a line a person recognises', async () => {
    render(
      <RunInbox load={async () => [row({ repos: ['bodhi-service-api', 'bodhi-web-apps'] })]} now={() => NOW} />,
    );
    await screen.findByText('bodhi-service-api, bodhi-web-apps');
  });

  test('the count is the headline, and it is grammatical', async () => {
    render(<RunInbox load={async () => [row()]} now={() => NOW} />);
    await screen.findByText('1 run needs your attention');
  });

  test('and plural when it should be', async () => {
    render(
      <RunInbox load={async () => [row(), row({ id: 'run-2' })]} now={() => NOW} />,
    );
    await screen.findByText('2 runs need your attention');
  });

  test('the order it was given is the order shown', async () => {
    // The query sorts oldest-wait-first. Re-sorting here would undo the one
    // decision that keeps a forgotten run from sinking.
    const rows = [
      row({ id: 'oldest', initiativeKey: 'OLD', since: '2026-09-10T09:00:00Z' }),
      row({ id: 'newest', initiativeKey: 'NEW', since: '2026-09-14T11:59:00Z' }),
    ];
    const { container } = render(<RunInbox load={async () => rows} now={() => NOW} />);
    await screen.findByText('OLD');
    const keys = [...container.querySelectorAll('.run-inbox__key')].map((n) => n.textContent);
    expect(keys).toEqual(['OLD', 'NEW']);
  });
});

describe('how long it has been waiting', () => {
  test('in the units a person thinks in', () => {
    expect(waitedFor('2026-09-14T11:00:00Z', NOW)).toBe('1h');
    expect(waitedFor('2026-09-14T11:45:00Z', NOW)).toBe('15m');
    expect(waitedFor('2026-09-10T12:00:00Z', NOW)).toBe('4d');
  });

  test('anything under a minute is just now, not a countdown', () => {
    // "waiting 43 seconds" invites watching it, and nothing here changes in
    // seconds.
    expect(waitedFor('2026-09-14T11:59:30Z', NOW)).toBe('just now');
  });

  test('a timestamp that will not parse says so rather than lying', () => {
    // NaN arithmetic renders "NaNm", which reads as a number.
    expect(waitedFor('not a date', NOW)).toBe('unknown');
  });

  test('the exact time is kept where somebody can find it', async () => {
    render(<RunInbox load={async () => [row()]} now={() => NOW} />);
    const waited = await screen.findByText('1h');
    expect(waited.getAttribute('title')).toBe('2026-09-14T11:00:00Z');
  });
});

describe('the reason line', () => {
  test('a blocked reason wins over the state description', () => {
    const reason = reasonFor(row({ state: 'waitingPermission', blockedReason: 'budget ceiling' }));
    expect(reason).toBe('budget ceiling');
  });

  test('and the state description is the fallback, not the other way round', () => {
    expect(reasonFor(row({ state: 'waitingPermission' }))).toBe('a tool is asking for permission');
  });
});

describe('a refresh that fails over a list we already have', () => {
  test('keeps the list and says it is stale', async () => {
    // Blanking three waiting runs because the database was briefly locked
    // loses the answer to keep the warning, which is the wrong way round.
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) return [row({ initiativeKey: 'CO-722' })];
      throw new Error('database is locked');
    };
    render(<RunInbox load={load} now={() => NOW} pollMs={5} />);
    await screen.findByText('CO-722');
    await screen.findByRole('status');
    // Still there, and still the answer.
    expect(screen.getByText('CO-722')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('but a first load that fails has nothing to keep', async () => {
    // CONTROL for the rule above: with no previous reading, an empty list is
    // the wrong answer and the error is the whole page.
    render(
      <RunInbox load={async () => { throw new Error('locked'); }} now={() => NOW} pollMs={5} />,
    );
    await screen.findByRole('alert');
    expect(screen.queryByText('Nothing needs your attention')).toBeNull();
  });
});

describe('asking again', () => {
  test('it polls', async () => {
    // The inbox has no way of being told a run stopped, so the only thing
    // keeping it current is this.
    let calls = 0;
    const load = async () => {
      calls += 1;
      return [];
    };
    render(<RunInbox load={load} now={() => NOW} pollMs={5} />);
    await waitFor(() => expect(calls).toBeGreaterThan(1));
  });

  test('and stops when the view goes away', async () => {
    // An interval left running in a long-lived app is a query every minute
    // for a window nobody is looking at, forever.
    let calls = 0;
    const load = async () => {
      calls += 1;
      return [];
    };
    const view = render(<RunInbox load={load} now={() => NOW} pollMs={5} />);
    await waitFor(() => expect(calls).toBeGreaterThan(1));
    view.unmount();
    const after = calls;
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    expect(calls).toBe(after);
  });
});

describe('halting a run', () => {
  test('a row offers exactly one run-acting control: Halt', async () => {
    // The inbox is otherwise read-only (the loop drives everything else), but a
    // person must be able to STOP a stuck or unwanted run — the one thing the
    // loop cannot do for them. On a plain inconclusive row that is the only
    // button present.
    const { container } = render(
      <RunInbox load={async () => [row()]} abandon={async () => true} now={() => NOW} />,
    );
    await screen.findByText('CO-722');
    await waitFor(() => {
      const buttons = container.querySelectorAll('button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0].textContent).toBe('Halt');
    });
  });

  test('clicking Halt calls abandon with the run id, then refreshes', async () => {
    const halted: string[] = [];
    let loads = 0;
    render(
      <RunInbox
        load={async () => { loads++; return loads === 1 ? [row()] : []; }}
        abandon={async (id) => { halted.push(id); return true; }}
        now={() => NOW}
      />,
    );
    fireEvent.click(await screen.findByText('Halt'));
    await waitFor(() => expect(halted).toEqual(['run-1']));
    // After the abandon, the refresh returns [] and the row is gone.
    await screen.findByText('Nothing needs your attention');
  });

  test('a FAILED run is surfaced (not vanished) with its reason, and Dismiss clears it', async () => {
    // The gap this fixes: a failed run is terminal, so it used to fall out of
    // both the active list and the inbox — the operator saw it disappear with no
    // idea it failed or why. Now it shows here with its reason, dismissible.
    const dismissed: string[] = [];
    let loads = 0;
    render(
      <RunInbox
        load={async () => { loads++; return loads === 1 ? [row({ state: 'failed', blockedReason: 'install failed: yarn ELIFECYCLE' })] : []; }}
        abandon={async (id) => { dismissed.push(id); return true; }}
        now={() => NOW}
      />,
    );
    await screen.findByText('install failed: yarn ELIFECYCLE');
    // The action reads as Dismiss, not Halt — the run has already stopped.
    const dismiss = screen.getByText('Dismiss');
    fireEvent.click(dismiss);
    // It invokes abandon for THIS run and, once gone, the inbox is empty.
    await waitFor(() => expect(dismissed).toEqual(['run-1']));
    await screen.findByText('Nothing needs your attention');
  });

  test('a bypass gate waiting on a person shows the attach command to answer it', async () => {
    // Bypass has no in-app allow/deny (no broker), so the row would otherwise
    // leave the operator nothing to do. Surface the exact `claude attach`.
    render(
      <RunInbox
        now={() => NOW}
        load={async () => [row({
          state: 'waitingPermission',
          owners: [{ repo: 'insights', agent: 'bsa-platform', state: 'waitingPermission', gate: 2, attachId: '7365f43b' }],
        })]}
      />,
    );
    await screen.findByText(/claude attach 7365f43b/);
  });

  test('a failed halt surfaces an error instead of a silent no-op', async () => {
    render(
      <RunInbox
        load={async () => [row()]}
        abandon={async () => { throw new Error('IPC exploded'); }}
        now={() => NOW}
      />,
    );
    fireEvent.click(await screen.findByText('Halt'));
    // The operator sees it failed rather than believing the run was halted.
    await screen.findByText(/Could not halt this run: IPC exploded/);
    // And the run is still there to try again.
    expect(screen.getByText('CO-722')).toBeDefined();
  });
});

describe('answering a permission request', () => {
  const req = (over: Partial<RunPermissionRequest> = {}): RunPermissionRequest => ({
    repo: 'Bodhilander',
    toolUseId: 'toolu_01',
    toolName: 'Bash',
    input: { command: 'rm -rf build', description: 'Clean' },
    askedAt: '2026-09-14T11:41:45.000Z',
    ...over,
  });

  test('shows the tool and its input whole, and both answers', async () => {
    render(
      <PermissionRequests runId="run-1" loadPermissions={async () => [req()]} answer={async () => true} />,
    );
    await screen.findByText('Bash');
    // The command line is shown in full -- a person approves what runs, not a summary.
    expect(screen.getByText(/rm -rf build/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
  });

  test('Allow sends allow for that request, then refreshes the inbox', async () => {
    const sent: Array<[string, string]> = [];
    let answered = 0;
    render(
      <PermissionRequests
        runId="run-1"
        loadPermissions={async () => [req()]}
        answer={async (_r, _repo, id, verdict) => { sent.push([id, verdict]); return true; }}
        onAnswered={() => { answered += 1; }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(sent).toEqual([['toolu_01', 'allow']]));
    await waitFor(() => expect(answered).toBe(1));
  });

  test('Deny with no reason sends an empty message, letting the broker word it', async () => {
    const sent: Array<[string, string]> = [];
    render(
      <PermissionRequests
        runId="run-1"
        loadPermissions={async () => [req()]}
        answer={async (_r, _repo, _id, verdict, message) => { sent.push([verdict, message]); return true; }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(sent).toEqual([['deny', '']]));
  });

  test('a typed reason is carried on the deny, so the model reads why', async () => {
    const sent: Array<[string, string]> = [];
    render(
      <PermissionRequests
        runId="run-1"
        loadPermissions={async () => [req()]}
        answer={async (_r, _repo, _id, verdict, message) => { sent.push([verdict, message]); return true; }}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Reason for denying (optional)'), {
      target: { value: 'delete the dist dir, not the whole build' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(sent).toEqual([['deny', 'delete the dist dir, not the whole build']]));
  });

  test('an allow never carries the deny reason box', async () => {
    const sent: Array<[string, string]> = [];
    render(
      <PermissionRequests
        runId="run-1"
        loadPermissions={async () => [req()]}
        answer={async (_r, _repo, _id, verdict, message) => { sent.push([verdict, message]); return true; }}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Reason for denying (optional)'), {
      target: { value: 'ignored on allow' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(sent).toEqual([['allow', '']]));
  });

  test('nothing pending renders nothing at all', () => {
    const { container } = render(
      <PermissionRequests runId="run-1" loadPermissions={async () => []} answer={async () => true} />,
    );
    // A row with no requests must add no empty scaffolding to the inbox.
    expect(container.querySelector('.run-inbox__perms')).toBeNull();
  });

  test('an answer names the repo it belongs to, so two blocked owners do not cross', async () => {
    // Two owners are blocked at once. Each request shows its repo, and
    // answering one carries that repo -- so the reply reaches the right gate.
    const sent: Array<[string, string, string]> = [];
    render(
      <PermissionRequests
        runId="run-1"
        loadPermissions={async () => [
          req({ repo: 'repo-a', toolUseId: 'a1' }),
          req({ repo: 'repo-b', toolUseId: 'b1' }),
        ]}
        answer={async (_r, repo, id, verdict) => { sent.push([repo, id, verdict]); return true; }}
      />,
    );
    await screen.findByText('repo-a');
    expect(screen.getByText('repo-b')).toBeTruthy();
    // Answer the SECOND request (repo-b's).
    const allows = screen.getAllByRole('button', { name: 'Allow' });
    fireEvent.click(allows[1]);
    await waitFor(() => expect(sent).toEqual([['repo-b', 'b1', 'allow']]));
  });

  test('answering one owner leaves the other owner’s buttons usable', async () => {
    // The busy-lock is per request, not global: while repo-a's answer is in
    // flight, repo-b can still be acted on.
    let release: () => void = () => {};
    const hang = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    render(
      <PermissionRequests
        runId="run-1"
        loadPermissions={async () => [
          req({ repo: 'repo-a', toolUseId: 'a1' }),
          req({ repo: 'repo-b', toolUseId: 'b1' }),
        ]}
        answer={async () => hang}
      />,
    );
    await screen.findByText('repo-a');
    const allows = screen.getAllByRole('button', { name: 'Allow' }) as HTMLButtonElement[];
    fireEvent.click(allows[0]); // repo-a, which now hangs
    await waitFor(() => expect(allows[0].disabled).toBe(true));
    // repo-b's button is NOT disabled by repo-a's in-flight answer.
    expect(allows[1].disabled).toBe(false);
    release();
  });
});

describe('the manifest approval panel', () => {
  const manifest = (): SeamManifest => ({
    mergeOrder: ['bodhi-service-api', 'bodhi-web-apps'],
    seamsYaml: 'initiative: BWA-1\nmerge_order: [bodhi-service-api, bodhi-web-apps]\nseams: []\n',
  });

  test('shows the merge order and the whole manifest', async () => {
    render(<ManifestApproval runId="run-1" loadManifest={async () => manifest()} approve={async () => true} reject={async () => true} />);
    await screen.findByText(/Merge order:/);
    // Shown whole: approving is approving what each repo builds to.
    expect(screen.getByText(/merge_order: \[bodhi-service-api, bodhi-web-apps\]/)).toBeTruthy();
  });

  test('approve calls through, and tells the inbox to refresh', async () => {
    let approved: string | null = null;
    let refreshed = 0;
    render(
      <ManifestApproval
        runId="run-9"
        loadManifest={async () => manifest()}
        approve={async (id) => { approved = id; return true; }}
        reject={async () => true}
        onDecided={() => { refreshed += 1; }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }));
    await waitFor(() => expect(approved).toBe('run-9'));
    expect(refreshed).toBe(1);
  });

  test('reject carries the typed reason', async () => {
    let seen: { id: string; reason: string } | null = null;
    render(
      <ManifestApproval
        runId="run-9"
        loadManifest={async () => manifest()}
        approve={async () => true}
        reject={async (id, reason) => { seen = { id, reason }; return true; }}
      />,
    );
    await screen.findByText(/Merge order:/);
    fireEvent.change(screen.getByPlaceholderText('Reason (optional)'), { target: { value: 'no producer for the scan seam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(seen).toEqual({ id: 'run-9', reason: 'no producer for the scan seam' }));
  });

  test('a manifest that is not ready yet says so, with no buttons', async () => {
    render(<ManifestApproval runId="run-1" loadManifest={async () => null} approve={async () => true} reject={async () => true} />);
    await screen.findByText(/not ready yet/);
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });
});
