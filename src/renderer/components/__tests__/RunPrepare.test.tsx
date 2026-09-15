/**
 * Prepare-and-arm tests (CO-722).
 *
 * The component's job is to turn "a repo and an issue" into an armed run in one
 * gesture, and to show every way that can fail as the same fixable list. These
 * cover the happy path (prepare -> arm -> owners shown, inbox refreshed) and
 * that a refusal from either step is shown in full and never silently armed.
 */
import { describe, expect, test } from 'bun:test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { RunPrepare } from '../RunPrepare';
import type { RunArmResult, RunPrepareResult } from '../../../shared/types';

const fill = (issue: string, repo: string) => {
  fireEvent.change(screen.getByPlaceholderText('BDH-241'), { target: { value: issue } });
  const repoInput = screen.getByPlaceholderText(/Start typing|Set the harness/);
  fireEvent.change(repoInput, { target: { value: repo } });
};

describe('preparing and arming a run from the app', () => {
  test('prepares, arms, shows the owners, and refreshes the inbox', async () => {
    let refreshed = 0;
    const prepared: RunPrepareResult = { status: 'prepared', initiativeDir: 'C:/init/BDH-239', log: 'wrote team.yaml' };
    const armed: RunArmResult = { status: 'armed', runId: 'r1', initiativeKey: 'BDH-239', owners: { Bodhilander: 'bodhilander-lead' } };
    let armedDir: string | null = null;
    render(
      <RunPrepare
        listRepos={async () => ['Bodhilander']}
        prepare={async () => prepared}
        arm={async (dir) => { armedDir = dir; return armed; }}
        onArmed={() => { refreshed += 1; }}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button')).toBeTruthy());
    fill('BDH-239', 'Bodhilander');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare & arm' }));
    await screen.findByText(/Prepared and armed/);
    expect(screen.getByText(/bodhilander-lead/)).toBeTruthy();
    expect(armedDir).toBe('C:/init/BDH-239');
    await waitFor(() => expect(refreshed).toBe(1));
  });

  test('a prepare refusal is shown in full and nothing is armed', async () => {
    let armCalled = false;
    const refused: RunPrepareResult = {
      status: 'refused',
      refusals: [{ what: 'no harness is configured', fix: 'Set the harness path in Settings → Run engine.' }],
      log: 'stderr here',
    };
    render(
      <RunPrepare
        listRepos={async () => ['Bodhilander']}
        prepare={async () => refused}
        arm={async () => { armCalled = true; return { status: 'armed', runId: 'r', initiativeKey: 'K', owners: {} }; }}
      />,
    );
    fill('BDH-1', 'Bodhilander');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare & arm' }));
    await screen.findByText('no harness is configured');
    expect(screen.getByText('Set the harness path in Settings → Run engine.')).toBeTruthy();
    expect(screen.getByText('stderr here')).toBeTruthy();
    expect(armCalled).toBe(false);
  });

  test('an arm refusal after a good prepare is shown, not swallowed', async () => {
    const prepared: RunPrepareResult = { status: 'prepared', initiativeDir: 'C:/init/X', log: '' };
    const armRefused: RunArmResult = { status: 'refused', refusals: [{ what: 'python did not run', fix: 'Install Python' }] };
    render(
      <RunPrepare listRepos={async () => []} prepare={async () => prepared} arm={async () => armRefused} />,
    );
    fill('BDH-1', 'Bodhilander');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare & arm' }));
    await screen.findByText('python did not run');
  });

  test('the button stays disabled until an issue and a repo are given', async () => {
    render(<RunPrepare listRepos={async () => ['Bodhilander']} prepare={async () => ({ status: 'prepared', initiativeDir: 'd', log: '' })} arm={async () => ({ status: 'armed', runId: 'r', initiativeKey: 'K', owners: {} })} />);
    const button = screen.getByRole('button', { name: 'Prepare & arm' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fill('BDH-1', '');
    expect(button.disabled).toBe(true);
    fill('BDH-1', 'Bodhilander');
    expect(button.disabled).toBe(false);
  });

  test('a non-numeric budget is flagged, and prepare is never called', async () => {
    let prepareCalled = false;
    render(
      <RunPrepare
        listRepos={async () => ['Bodhilander']}
        prepare={async () => { prepareCalled = true; return { status: 'prepared', initiativeDir: 'd', log: '' }; }}
        arm={async () => ({ status: 'armed', runId: 'r', initiativeKey: 'K', owners: {} })}
      />,
    );
    fill('BDH-1', 'Bodhilander');
    fireEvent.change(screen.getByPlaceholderText('harness default'), { target: { value: '50o' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare & arm' }));
    await screen.findByText(/not a valid budget/);
    expect(prepareCalled).toBe(false);
  });

  test('an IPC throw is shown, not swallowed', async () => {
    render(
      <RunPrepare listRepos={async () => []} prepare={async () => { throw new Error('the store is locked'); }} arm={async () => ({ status: 'armed', runId: 'r', initiativeKey: 'K', owners: {} })} />,
    );
    fill('BDH-1', 'Bodhilander');
    fireEvent.click(screen.getByRole('button', { name: 'Prepare & arm' }));
    await screen.findByText(/the store is locked/);
  });
});
