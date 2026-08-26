/**
 * The two ends of a handoff, as the window shows them. The offer is raised
 * unprompted, so what it must never do is appear after being turned down, or
 * vanish over a mistyped phrase somebody is still reading off another screen.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { HandoffOfferState, HandoffPrepareResult, PortableImportResult } from '../../../shared/types';
import { HandoffPreparePanel, HandoffRestoreOffer } from '../MachineHandoff';

const OFFER: HandoffOfferState = {
  offer: {
    id: 'handoff-1',
    sourceMachineId: 'machine-old',
    sourceMachineName: 'Old Laptop',
    byteSize: 4096,
    createdAt: 1756080000000,
    expiresAt: 1756684800000,
  },
  declined: false,
  sizeLabel: '4.0 KB',
};

let declined: string[];
let restoreWith: string[];
let peekResult: HandoffOfferState;
let restoreResult: PortableImportResult;
let prepareResult: HandoffPrepareResult;

beforeEach(() => {
  declined = [];
  restoreWith = [];
  peekResult = OFFER;
  restoreResult = { success: true, groupCount: 2, sessionCount: 5 };
  prepareResult = { success: true, phrase: 'agent album alloy amber', sizeLabel: '2.0 MB', groupCount: 2, sessionCount: 5 };

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    handoffPeek: async () => peekResult,
    handoffDecline: async (id: string) => {
      declined.push(id);
    },
    handoffRestore: async (phrase: string) => {
      restoreWith.push(phrase);
      return restoreResult;
    },
    handoffPrepare: async () => prepareResult,
  };
});

afterEach(cleanup);

/** Mount and let the offer lookup settle, so "no dialog" means an answer arrived. */
async function mountOffer(onRestored: () => void = () => {}) {
  await act(async () => {
    render(<HandoffRestoreOffer onRestored={onRestored} />);
  });
}

async function click(label: string) {
  await act(async () => {
    fireEvent.click(screen.getByText(label));
  });
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('the restore offer', () => {
  test('names the machine the state came from', async () => {
    await mountOffer();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Old Laptop');
    expect(dialog.textContent).toContain('4.0 KB');
  });

  test('falls back to plain language when the relay has no name for it', async () => {
    peekResult = { ...OFFER, offer: { ...OFFER.offer!, sourceMachineName: null } };
    await mountOffer();
    expect(screen.getByRole('dialog').textContent).toContain('your other machine');
  });

  test('stays away when there is nothing waiting', async () => {
    peekResult = { offer: null, declined: false };
    await mountOffer();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('stays away when this bundle was already turned down', async () => {
    peekResult = { ...OFFER, declined: true };
    await mountOffer();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('answering the offer', () => {
  test('"Not Now" records the bundle it declined and closes', async () => {
    await mountOffer();
    await click('Not Now');

    expect(declined).toEqual(['handoff-1']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a restore hands over the phrase as typed and tells the window to catch up', async () => {
    let restored = 0;
    await mountOffer(() => restored++);

    type('Recovery phrase', 'agent album alloy');
    await click('Restore');

    expect(restoreWith).toEqual(['agent album alloy']);
    expect(restored).toBe(1);
  });

  test('a wrong phrase leaves the offer up to be tried again', async () => {
    restoreResult = { success: false, error: 'That recovery phrase has a typo in it.' };
    await mountOffer();

    type('Recovery phrase', 'agent album');
    await click('Restore');

    expect(screen.getByRole('alert').textContent).toContain('typo');
    expect(screen.queryByRole('dialog')).not.toBeNull();
    expect(declined).toEqual([]);
  });

  test('counts the words entered, so a short phrase is visible before it is submitted', async () => {
    await mountOffer();
    type('Recovery phrase', 'agent album alloy');
    expect(screen.getByText('3 of 18 words')).not.toBeNull();
  });
});

describe('preparing one', () => {
  test('shows the phrase, and keeps showing it until it is dismissed', async () => {
    render(<HandoffPreparePanel />);
    await click('Send to Another Machine…');

    expect(screen.getByText('agent album alloy amber')).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Recovery phrase' }).textContent).toContain('2.0 MB');

    await click('I have written it down');
    expect(screen.queryByText('agent album alloy amber')).toBeNull();
  });

  test('says nothing when the person cancelled it themselves', async () => {
    prepareResult = { success: false, error: 'Handoff cancelled' };
    render(<HandoffPreparePanel />);
    await click('Send to Another Machine…');

    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('surfaces a refusal from the relay rather than swallowing it', async () => {
    prepareResult = { success: false, error: 'Link this machine to a relay account before moving it.' };
    render(<HandoffPreparePanel />);
    await click('Send to Another Machine…');

    expect(screen.getByRole('alert').textContent).toContain('Link this machine');
  });
});
