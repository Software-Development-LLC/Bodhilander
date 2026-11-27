import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { CrewPanel } from '../CrewPanel';
import type { CrewHireSummary, CrewLinkView, CrewStatus } from '../../../../shared/types';

afterEach(cleanup);

const hire = (over: Partial<CrewHireSummary>): CrewHireSummary => ({
  hireId: 'h1',
  name: 'Fresh PO',
  roleId: 'fresh-po',
  state: 'active',
  activity: 'idle',
  cause: null,
  accountLabel: 'Work',
  ...over,
});

const online: CrewStatus = { availability: 'online', owner: { name: 'Brannon', upn: 'b@x.com' } };

function panel(props: Partial<React.ComponentProps<typeof CrewPanel>> = {}) {
  return render(
    <CrewPanel
      status={online}
      hires={[]}
      error={null}
      selectedHireId={null}
      onSelectHire={() => {}}
      onOpenCards={() => {}}
      beginLink={async () => ({ step: 'stopped', message: 'x' })}
      confirmLinkOwner={async () => true}
      {...props}
    />,
  );
}

describe('the Crew sidebar section', () => {
  test('is always there, and says nothing it does not know before the first read', () => {
    panel({ status: null, hires: null });
    expect(screen.getByRole('heading', { name: 'Crew' })).toBeTruthy();
    expect(screen.queryByText('No hires yet')).toBeNull();
  });

  test('renders each state a hire can be in', () => {
    panel({
      hires: [
        hire({ hireId: 'a', name: 'Ada', activity: 'running' }),
        hire({ hireId: 'b', name: 'Bo', activity: 'idle' }),
        hire({ hireId: 'c', name: 'Cy', activity: 'held', cause: 'signed-out' }),
        hire({ hireId: 'd', name: 'Di', activity: 'elsewhere' }),
      ],
    });
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Idle')).toBeTruthy();
    expect(screen.getByText('Held: signed out')).toBeTruthy();
    expect(screen.getByText('On another machine')).toBeTruthy();
  });

  test('a Hub that cannot be reached is unavailable, not an error, and the cached hires stay', () => {
    panel({ status: { availability: 'unavailable', owner: null }, hires: [hire({ name: 'Ada' })] });
    expect(screen.getByText("Crew isn't available right now")).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Ada')).toBeTruthy();
  });

  test('an older Bodhilander is asked to update', () => {
    panel({ status: { availability: 'update-required', owner: null } });
    expect(screen.getByText('Update Bodhilander to use Crew')).toBeTruthy();
  });

  test('a read that failed is an alert, not an empty list', () => {
    panel({ status: null, hires: null, error: 'database is locked' });
    expect(screen.getByRole('alert').textContent).toContain('database is locked');
    expect(screen.queryByText('No hires yet')).toBeNull();
  });

  test('an online machine with no hires says so', () => {
    panel({ hires: [] });
    expect(screen.getByText('No hires yet')).toBeTruthy();
  });

  test('choosing a hire opens it', () => {
    const chosen: string[] = [];
    panel({ hires: [hire({ hireId: 'h9', name: 'Ada' })], onSelectHire: (id) => chosen.push(id) });
    fireEvent.click(screen.getByText('Ada'));
    expect(chosen).toEqual(['h9']);
  });

  test('the cards inbox is one click away', () => {
    let opened = 0;
    panel({ onOpenCards: () => (opened += 1) });
    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    expect(opened).toBe(1);
  });
});

describe('linking this machine', () => {
  test('an unlinked machine is offered the link, and shows the confirm code', async () => {
    const view: CrewLinkView = { step: 'show-codes', name: 'Studio Mac', confirmCode: 'K7Q2ZP' };
    panel({ status: { availability: 'unlinked', owner: null }, beginLink: async () => view });
    fireEvent.click(screen.getByRole('button', { name: 'Link this machine' }));
    await screen.findByText('K7Q2ZP');
    expect(screen.getByText(/Studio Mac/)).toBeTruthy();
  });

  test('a machine already linked names its owner and waits for an answer', async () => {
    const answers: boolean[] = [];
    panel({
      status: { availability: 'unlinked', owner: null },
      beginLink: async () => ({ step: 'confirm-owner', ownerName: 'Ada Lovelace', ownerUpn: 'ada@x.com' }),
      confirmLinkOwner: async (isMe) => (answers.push(isMe), isMe),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link this machine' }));
    await screen.findByText(/Ada Lovelace \(ada@x.com\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Not me' }));
    expect(answers).toEqual([false]);
  });

  test('a link that stops says why', async () => {
    panel({ status: { availability: 'link-again', owner: null }, beginLink: async () => ({ step: 'stopped', message: 'Crew needs the system keychain.' }) });
    fireEvent.click(screen.getByRole('button', { name: 'Link this machine' }));
    await screen.findByText('Crew needs the system keychain.');
  });

  test('an online machine is not offered a link', () => {
    panel();
    expect(screen.queryByRole('button', { name: 'Link this machine' })).toBeNull();
  });

  test('Hire is offered only while Crew is online', () => {
    let opened = 0;
    panel({ onHire: () => opened++ });
    fireEvent.click(screen.getByRole('button', { name: 'Hire' }));
    expect(opened).toBe(1);
    cleanup();
    panel({ status: { availability: 'unavailable', owner: null }, onHire: () => opened++ });
    expect(screen.queryByRole('button', { name: 'Hire' })).toBeNull();
  });
});

describe('unlinking this machine', () => {
  test('offered while online, asks to confirm, and says what happens', async () => {
    const calls: string[] = [];
    panel({ status: { availability: 'offline', owner: null }, unlink: async () => (calls.push('unlink'), { ok: true }) });
    expect(screen.queryByText('Unlink…')).toBeNull();
    cleanup();
    panel({ unlink: async () => (calls.push('unlink'), { ok: true }) });
    fireEvent.click(screen.getByText('Unlink…'));
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByText('Unlink this machine'));
    await screen.findByText('Unlinking this machine. Its hires wait for a new home.');
    expect(calls).toEqual(['unlink']);
  });
});
