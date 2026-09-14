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
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { RunInbox, reasonFor, waitedFor } from '../RunInbox';
import type { RunInboxRow } from '../../../shared/types';

const NOW = Date.parse('2026-09-14T12:00:00Z');

function row(over: Partial<RunInboxRow> = {}): RunInboxRow {
  return {
    id: 'run-1',
    initiativeKey: 'CO-722',
    state: 'inconclusive',
    blockedReason: null,
    since: '2026-09-14T11:00:00Z',
    repos: [],
    ...over,
  };
}

describe('what it says when nothing is waiting', () => {
  test('an empty inbox is the good state, and says so', async () => {
    const { container } = render(<RunInbox load={async () => []} now={() => NOW} />);
    await screen.findByText('Nothing is waiting on you');
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
    expect(screen.queryByText('Nothing is waiting on you')).toBeNull();
    expect(screen.getByText('database is locked')).toBeTruthy();
  });

  test('and it is not silently empty before it has loaded either', () => {
    // Never resolves: the first paint must not claim an answer it does not
    // have yet.
    render(<RunInbox load={() => new Promise(() => {})} now={() => NOW} />);
    expect(screen.queryByText('Nothing is waiting on you')).toBeNull();
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
    await screen.findByText('1 run waiting on you');
  });

  test('and plural when it should be', async () => {
    render(
      <RunInbox load={async () => [row(), row({ id: 'run-2' })]} now={() => NOW} />,
    );
    await screen.findByText('2 runs waiting on you');
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
    expect(screen.queryByText('Nothing is waiting on you')).toBeNull();
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

describe('what it cannot do', () => {
  test('there is nothing here that acts on a run', async () => {
    // Read-only by design, matching the channel behind it: no start, no stop,
    // no advance. The only button in this component is on the error path.
    const { container } = render(<RunInbox load={async () => [row()]} now={() => NOW} />);
    await screen.findByText('CO-722');
    await waitFor(() => {
      expect(container.querySelectorAll('button')).toHaveLength(0);
    });
  });
});
