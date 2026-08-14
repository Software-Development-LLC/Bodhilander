/**
 * AccountChip — how an account is named everywhere in the UI (#165).
 *
 * Accounts are all created grey with no email, so the label is the only
 * reliable identifier. These tests pin that: the label always renders, the
 * swatch is decorative, and the tooltip carries the rest.
 *
 * Run with: bun test src/renderer/components/__tests__/AccountChip.test.tsx
 */
import React from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { AccountChip } from '../AccountChip';
import { ClaudeAccount } from '../../../shared/types';

afterEach(cleanup);

function account(overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    id: 'a1',
    label: 'Personal',
    email: 'me@example.com',
    color: '#61afef',
    ...overrides,
  } as ClaudeAccount;
}

const chip = () => document.querySelector('.account-chip') as HTMLElement;
const swatch = () => document.querySelector('.account-chip-swatch') as HTMLElement;

describe('AccountChip', () => {
  test('names the account by label and email', () => {
    render(<AccountChip account={account()} />);
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(screen.getByText('me@example.com')).toBeTruthy();
  });

  test('an account with no email renders no second segment at all', () => {
    // "Not yet logged in" beside a running session's account is a lie the
    // header used to tell on every machine that keeps its tokens outside the
    // config dir. Silence is the only safe default; the accounts panel opts in.
    render(<AccountChip account={account({ email: null })} detail="running under this account" />);
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(document.querySelector('.account-chip-email')).toBeNull();
    expect(document.body.textContent).not.toContain('Not yet logged in');
  });

  test('a padded email renders trimmed, in the text and the tooltip alike', () => {
    // The stored value is whatever parseAccountEmail read out of the
    // credentials file, newline and all. The falsiness check below already
    // treated '   ' as unidentified; rendering the untrimmed string meant a
    // real address still arrived with its padding attached, so the chip's one
    // line of room went on whitespace and the tooltip disagreed with the text.
    render(<AccountChip account={account({ email: '  a@b.com  ' })} />);
    const rendered = document.querySelector('.account-chip-email') as HTMLElement;
    expect(rendered.textContent).toBe('a@b.com');
    expect(chip().getAttribute('title')).toContain('(a@b.com)');
    expect(chip().getAttribute('title')).not.toContain('(  a@b.com  )');
  });

  test('a whitespace-only email is as unidentified as a missing one', () => {
    render(<AccountChip account={account({ email: '   ' })} noEmailLabel="Not yet logged in" />);
    expect(screen.getByText('Not yet logged in')).toBeTruthy();
    // And the tooltip agrees — it used to append an empty parenthetical.
    expect(chip().getAttribute('title')).toBe('Claude account: Personal');
  });

  test('a caller that can act on a missing login may name it', () => {
    render(<AccountChip account={account({ email: null })} noEmailLabel="Not yet logged in" />);
    expect(screen.getByText('Not yet logged in')).toBeTruthy();
  });

  test('the detail can be spoken as well as hovered', () => {
    render(<AccountChip account={account()} detail="running under this account" announceDetail />);
    // A title on a non-focusable span is not reliably announced, and "is it
    // running or will it run" is the whole point of the indicator.
    expect(document.querySelector('.sr-only')!.textContent).toContain('running under this account');
  });

  test('the swatch carries the colour but no accessible name', () => {
    render(<AccountChip account={account()} />);
    expect(swatch().getAttribute('aria-hidden')).toBe('true');
    expect(swatch().style.background).toContain('#61afef');
  });

  test('a null account renders the empty label and the neutral swatch', () => {
    render(<AccountChip account={null} emptyLabel="Removed account" />);
    expect(screen.getByText('Removed account')).toBeTruthy();
    expect(document.querySelector('.account-chip-email')).toBeNull();
    expect(swatch().style.background).toContain('#888888');
  });

  test('the tooltip carries label, email and the caller detail', () => {
    render(<AccountChip account={account()} detail="running under this account" />);
    const title = chip().getAttribute('title')!;
    expect(title).toContain('Personal');
    expect(title).toContain('me@example.com');
    expect(title).toContain('running under this account');
  });

  test('the size picks the layout class', () => {
    render(<AccountChip account={account()} size="md" />);
    expect(chip().className).toContain('account-chip-md');
  });

  test('the chip is inert — never a drag source in a drag-enabled row', () => {
    render(<AccountChip account={account()} />);
    expect(chip().getAttribute('draggable')).toBe('false');
  });
});
