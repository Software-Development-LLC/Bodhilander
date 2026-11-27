import { afterEach, describe, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { CrewWindowsProgress, CrewWindowsRepairResult, CrewWindowsState } from '../../../../../shared/types';
import { WindowsSetup } from '../WindowsSetup';

afterEach(cleanup);

const PROMPT = "Repair will move Crew's Windows setup to WSL2. Crew will save a copy first. If the move fails, hire folders will need restoring.";

function mount(state: CrewWindowsState | null, over: Partial<React.ComponentProps<typeof WindowsSetup>> = {}) {
  let push: (p: CrewWindowsProgress) => void = () => {};
  render(
    <WindowsSetup
      checkState={async () => state}
      setup={async () => ({ ok: true })}
      repair={async () => ({ ok: true })}
      onProgress={(cb) => ((push = cb), () => {})}
      {...over}
    />,
  );
  return { progress: (p: CrewWindowsProgress) => act(() => push(p)) };
}

describe('Crew on Windows setup', () => {
  test("a build that can't set up Crew on Windows says so and offers nothing to press", async () => {
    mount({ state: 'unbuilt', message: "This build of Bodhilander can't set up Crew on Windows yet." });
    expect(await screen.findByText("This build of Bodhilander can't set up Crew on Windows yet.")).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  test('off Windows it shows nothing', async () => {
    const { container } = render(<WindowsSetup checkState={async () => null} />);
    await act(async () => {});
    expect(container.textContent).toBe('');
  });

  test('no WSL2 gives the install steps and a way to check again', async () => {
    mount({ state: 'no-wsl', message: 'Crew needs WSL2' });
    await screen.findByText('Crew needs WSL2');
    expect(screen.getByText(/wsl --install/)).toBeTruthy();
    expect(screen.getByText('Check again')).toBeTruthy();
    expect(screen.queryByText('Set up Crew on Windows')).toBeNull();
  });

  test('a missing setup offers Set up Crew on Windows, with each step shown as it runs', async () => {
    let finish: () => void = () => {};
    const t = mount({ state: 'missing', message: 'Set up Crew on Windows to start.' }, { setup: () => new Promise((r) => (finish = () => r({ ok: true }))) });
    fireEvent.click(await screen.findByText('Set up Crew on Windows'));
    t.progress({ step: 'download' });
    expect(screen.getByText("Downloading Crew's Linux image")).toBeTruthy();
    t.progress({ step: 'link', message: 'Approve the link in Teams. Setup carries on by itself once you do' });
    expect(screen.getByText(/Approve the link in Teams/)).toBeTruthy();
    await act(async () => finish());
    expect(screen.getByText("Crew's Windows setup is ready.")).toBeTruthy();
  });

  test('a setup that fails says why and offers Repair when Repair can fix it', async () => {
    mount({ state: 'missing', message: 'm' }, { setup: async () => ({ ok: false, message: 'Crew setup on this PC needs repair', repair: true }) });
    fireEvent.click(await screen.findByText('Set up Crew on Windows'));
    await screen.findByText('Crew setup on this PC needs repair');
    expect(screen.getByText('Repair')).toBeTruthy();
  });

  test('Repair asks with the prompt first, and Cancel changes nothing', async () => {
    const asked: boolean[] = [];
    const repair = async (confirmed: boolean): Promise<CrewWindowsRepairResult> => (asked.push(confirmed), confirmed ? { ok: true } : { confirm: PROMPT });
    mount({ state: 'wsl1', message: "Crew's Windows setup is on WSL1. Repair converts it to WSL2" }, { repair });
    fireEvent.click(await screen.findByText('Repair'));
    await screen.findByText(PROMPT);
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(asked).toEqual([false]);
    fireEvent.click(screen.getByText('Repair'));
    fireEvent.click(await screen.findByText('Continue'));
    await screen.findByText("Crew's Windows setup is ready.");
    expect(asked).toEqual([false, false, true]);
  });

  test("a Repair that ends in a fallback keeps its restore message on screen", async () => {
    mount({ state: 'needs-repair', message: 'needs repair' }, { repair: async () => ({ ok: true, message: 'hire folders need restoring' }) });
    fireEvent.click(await screen.findByText('Repair'));
    await screen.findByText('hire folders need restoring');
  });
});
