/**
 * Active-runs list tests (CO-722).
 *
 * This list exists to make a cross-repo run visible while it bootstraps -- the
 * phase the inbox excludes. So the tests are about naming that phase ("Scoping…"
 * not "preparing"), and about the one thing that would make it redundant:
 * showing a run the inbox already owns.
 *
 * Run with: bun test src/renderer/components
 */
import { describe, expect, test } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { RunList, phaseFor } from '../RunList';
import type { RunActiveRow } from '../../../shared/types';

const NOW = Date.parse('2026-09-16T12:00:00Z');

function row(over: Partial<RunActiveRow> = {}): RunActiveRow {
  return {
    id: 'run-1', initiativeKey: 'BWA-1', state: 'preparing', kind: 'single',
    bootstrapState: null, blockedReason: null, since: '2026-09-16T11:57:00Z', repos: [],
    ...over,
  };
}

describe('phaseFor names the phase a person reads', () => {
  test('a multi run reads by its bootstrap phase, not its bare state', () => {
    expect(phaseFor(row({ kind: 'multi', state: 'preparing', bootstrapState: 'scoping' }))).toBe('Scoping…');
    expect(phaseFor(row({ kind: 'multi', state: 'preparing', bootstrapState: 'architecting' }))).toBe('Architecting seams…');
    expect(phaseFor(row({ kind: 'multi', state: 'preparing', bootstrapState: 'spawning' }))).toBe('Spawning worktrees…');
  });

  test('a single run reads by its state', () => {
    expect(phaseFor(row({ state: 'running' }))).toBe('Running');
    expect(phaseFor(row({ state: 'preparing' }))).toBe('Preparing…');
    expect(phaseFor(row({ state: 'waitingChecks' }))).toBe('Waiting on checks');
  });

  test('an unknown state still shows something, not a blank', () => {
    expect(phaseFor(row({ state: 'somethingNew' }))).toBe('somethingNew');
  });
});

describe('what the list renders', () => {
  test('a bootstrapping run shows its phase, so it is no longer invisible', async () => {
    render(
      <RunList
        load={async () => [row({ kind: 'multi', state: 'preparing', bootstrapState: 'architecting', repos: ['api', 'web'] })]}
        now={() => NOW}
      />,
    );
    await screen.findByText('Architecting seams…');
    expect(screen.getByText('api, web')).toBeTruthy();
    expect(screen.getByText('1 run in flight')).toBeTruthy();
  });

  test('runs the inbox owns are left to it, not shown twice', async () => {
    const { container } = render(
      <RunList
        load={async () => [
          row({ id: 'a', state: 'running' }),
          row({ id: 'b', state: 'waitingHumanGate' }),
          row({ id: 'c', state: 'waitingPermission' }),
          row({ id: 'd', state: 'inconclusive' }),
        ]}
        now={() => NOW}
      />,
    );
    await screen.findByText('1 run in flight'); // only the running one
    expect(container.querySelectorAll('.run-list__row')).toHaveLength(1);
  });

  test('nothing in flight renders nothing (the inbox carries the empty message)', async () => {
    const { container } = render(
      <RunList load={async () => [row({ state: 'waitingHumanGate' })]} now={() => NOW} />,
    );
    // Give the effect a tick; the panel must stay empty.
    await waitFor(() => expect(container.querySelector('.run-list')).toBeNull());
  });

  test('it does not flash "nothing running" before it has loaded', () => {
    const { container } = render(<RunList load={() => new Promise(() => {})} now={() => NOW} />);
    expect(container.querySelector('.run-list')).toBeNull();
  });
});
