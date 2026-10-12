/**
 * Arm-a-run tests (CO-722).
 *
 * The refusal list is the state that matters -- arming checks everything
 * before writing anything so a person fixes one machine once -- so most of
 * these are about showing it in full, and about a cancelled pick being a
 * non-event rather than an error.
 */
import { describe, expect, test } from 'bun:test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { RunArm } from '../RunArm';
import type { RunArmResult } from '../../../shared/types';

describe('arming a run from the app', () => {
  test('a successful arm shows the run and its owners, and refreshes the inbox', async () => {
    let refreshed = 0;
    const armed: RunArmResult = {
      status: 'armed', runId: 'r1', initiativeKey: 'BDH-239', owners: { Bodhilander: 'bodhilander-lead' },
    };
    render(
      <RunArm pick={async () => 'C:/init/BDH-239'} arm={async () => armed} onArmed={() => { refreshed += 1; }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Arm a run…' }));
    await screen.findByText('BDH-239');
    expect(screen.getByText(/bodhilander-lead/)).toBeTruthy();
    await waitFor(() => expect(refreshed).toBe(1));
  });

  test('a refusal shows every reason and its fix, and does not refresh', async () => {
    let refreshed = 0;
    const refused: RunArmResult = {
      status: 'refused',
      refusals: [
        { what: 'python did not run', fix: 'Install Python' },
        { what: 'Bodhilander has 3 possible owners', fix: 'Name one for this run' },
      ],
    };
    render(<RunArm pick={async () => 'C:/x'} arm={async () => refused} onArmed={() => { refreshed += 1; }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Arm a run…' }));
    await screen.findByText('python did not run');
    expect(screen.getByText('Install Python')).toBeTruthy();
    expect(screen.getByText('Bodhilander has 3 possible owners')).toBeTruthy();
    expect(refreshed).toBe(0);
  });

  test('cancelling the picker does nothing at all', async () => {
    let armCalled = false;
    render(<RunArm pick={async () => null} arm={async () => { armCalled = true; return { status: 'armed', runId: 'r', initiativeKey: 'K', owners: {} }; }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Arm a run…' }));
    // Nothing to wait for; a microtask is enough for the click handler to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(armCalled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an IPC failure is shown, not swallowed', async () => {
    render(<RunArm pick={async () => 'C:/x'} arm={async () => { throw new Error('the store is locked'); }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Arm a run…' }));
    await screen.findByText(/the store is locked/);
  });
});
