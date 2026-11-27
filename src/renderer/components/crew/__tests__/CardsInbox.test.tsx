import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { CardsInbox } from '../CardsInbox';
import type { CrewCard } from '../../../../shared/types';

afterEach(cleanup);

const NOW = Date.parse('2026-11-27T12:00:00Z');

const card = (over: Partial<CrewCard> = {}): CrewCard => ({
  raiseId: 'c1',
  hireId: 'h1',
  hireName: 'Fresh PO',
  kind: 'permission',
  summary: 'Run `git status` in bodhi-fresh',
  raisedAt: NOW - 5 * 60_000,
  decision: null,
  decidedBy: null,
  ...over,
});

describe('the cards inbox', () => {
  test('no cards is the good state, and says so', async () => {
    render(<CardsInbox load={async () => []} openCard={async () => true} pollMs={60_000} />);
    await screen.findByText('No cards waiting');
  });

  test('cards this machine cannot read are not shown as an empty inbox', async () => {
    render(<CardsInbox load={async () => null} openCard={async () => true} pollMs={60_000} />);
    await screen.findByText(/Cards aren't available on this machine yet/);
    expect(screen.queryByText('No cards waiting')).toBeNull();
  });

  test('a failed read is an alert, not an empty inbox', async () => {
    render(<CardsInbox load={async () => { throw new Error('ipc gone'); }} openCard={async () => true} pollMs={60_000} />);
    expect((await screen.findByRole('alert')).textContent).toContain('ipc gone');
    expect(screen.queryByText('No cards waiting')).toBeNull();
  });

  test('open cards come first, with what they ask and for which hire', async () => {
    render(
      <CardsInbox
        load={async () => [
          card({ raiseId: 'old', decision: 'approved', decidedBy: 'Brannon', summary: 'Already done' }),
          card({ raiseId: 'new', kind: 'outbound', summary: 'Message Ada about the rota' }),
        ]}
        openCard={async () => true}
        pollMs={60_000}
      />,
    );
    const items = await screen.findAllByRole('listitem');
    expect(items[0].textContent).toContain('Message Ada about the rota');
    expect(items[0].textContent).toContain('Send outside the circle');
    expect(items[0].textContent).toContain('Fresh PO');
    expect(items[1].textContent).toContain('Approved by Brannon');
  });

  test('a card is decided where Teams shows it; the desktop never decides', async () => {
    const opened: string[] = [];
    render(<CardsInbox load={async () => [card()]} openCard={async (id) => (opened.push(id), false)} pollMs={60_000} />);
    await screen.findByText('Run `git status` in bodhi-fresh');
    expect(screen.queryByRole('button', { name: /approve|deny/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open in Teams' }));
    await screen.findByText('Decide this card in Teams.');
    expect(opened).toEqual(['c1']);
  });
});

describe("a card's state", () => {
  const show = async (c: CrewCard) => {
    render(<CardsInbox load={async () => [c]} openCard={async () => true} pollMs={60_000} />);
    return (await screen.findByRole('listitem')).textContent ?? '';
  };

  test('a card the Hub has not acked says so, and has nothing to open yet', async () => {
    const text = await show(card({ state: 'sending' }));
    expect(text).toContain('Waiting for Crew Hub…');
    expect(screen.queryByRole('button', { name: 'Open in Teams' })).toBeNull();
  });

  test('an acked card waits for a decision in Teams', async () => {
    const text = await show(card({ state: 'waiting' }));
    expect(text).toContain('Waiting for a decision');
    expect(text).not.toContain('Crew Hub');
    expect(screen.getByRole('button', { name: 'Open in Teams' })).toBeTruthy();
  });

  test('a parked card still waits, and says the run resumes on the decision', async () => {
    const text = await show(card({ state: 'parked' }));
    expect(text).toMatch(/Parked/);
    expect(text).toMatch(/resumes/);
    expect(screen.getByRole('button', { name: 'Open in Teams' })).toBeTruthy();
  });

  test('a closed card says its run ended, and is no longer opened', async () => {
    const text = await show(card({ state: 'closed' }));
    expect(text).toMatch(/Closed/);
    expect(text).not.toContain('Waiting for a decision');
    expect(screen.queryByRole('button', { name: 'Open in Teams' })).toBeNull();
  });

  test('a decided card says how and by whom, and is no longer opened', async () => {
    const text = await show(card({ state: 'decided', decision: 'denied', decidedBy: 'Brannon' }));
    expect(text).toContain('Denied by Brannon');
    expect(screen.queryByRole('button', { name: 'Open in Teams' })).toBeNull();
  });

  test('a decision wins over a stale state', async () => {
    const text = await show(card({ state: 'waiting', decision: 'approved', decidedBy: 'Ada' }));
    expect(text).toContain('Approved by Ada');
    expect(text).not.toContain('Waiting for a decision');
  });

  test('cards still waiting come before closed and decided ones', async () => {
    render(
      <CardsInbox
        load={async () => [
          card({ raiseId: 'closed', state: 'closed', summary: 'Closed one', raisedAt: NOW }),
          card({ raiseId: 'decided', state: 'decided', decision: 'approved', decidedBy: 'Ada', summary: 'Decided one', raisedAt: NOW }),
          card({ raiseId: 'parked', state: 'parked', summary: 'Parked one', raisedAt: NOW - 60 * 60_000 }),
          card({ raiseId: 'sending', state: 'sending', summary: 'Sending one', raisedAt: NOW - 30 * 60_000 }),
        ]}
        openCard={async () => true}
        pollMs={60_000}
      />,
    );
    const items = (await screen.findAllByRole('listitem')).map((li) => li.querySelector('.crew-card__summary')?.textContent);
    expect(items.slice(0, 2)).toEqual(['Sending one', 'Parked one']);
    expect(new Set(items.slice(2))).toEqual(new Set(['Closed one', 'Decided one']));
  });

  test('an unreadable inbox never reads as zero cards', async () => {
    render(<CardsInbox load={async () => null} openCard={async () => true} pollMs={60_000} />);
    await screen.findByText(/Cards aren't available/);
    expect(document.querySelector('.crew-cards')?.textContent).not.toMatch(/\b0\b|No cards/);
  });
});
