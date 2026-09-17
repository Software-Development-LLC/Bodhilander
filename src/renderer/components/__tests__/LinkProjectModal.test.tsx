/**
 * LinkProjectModal smoke tests (CO-722, Phase 2B).
 *
 * The modal is built on a native <dialog>, so the risk is in the lifecycle
 * (open/close), the number validation, and the three ways it can resolve:
 * confirm a number, confirm empty (unlink), and cancel. Escape/backdrop close
 * are the platform's job; here we exercise the branches we own.
 *
 * Run with: bun test src/renderer/components/__tests__/LinkProjectModal.test.tsx
 */
import React from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LinkProjectModal } from '../LinkProjectModal';

afterEach(cleanup);

function setup(overrides: Record<string, unknown> = {}) {
  const calls: { confirm: (number | null)[]; cancel: number } = { confirm: [], cancel: 0 };
  const props = {
    isOpen: true,
    groupName: 'Repos',
    initialNumber: null as number | null,
    onConfirm: (n: number | null) => { calls.confirm.push(n); },
    onCancel: () => { calls.cancel++; },
    ...overrides,
  };
  const utils = render(<LinkProjectModal {...(props as never)} />);
  return { calls, ...utils };
}

describe('LinkProjectModal', () => {
  test('opens as a modal dialog showing the group name', () => {
    setup();
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(screen.getByText(/Link GitHub Project — Repos/)).toBeDefined();
  });

  test('confirms a valid number', () => {
    const { calls } = setup();
    const input = screen.getByPlaceholderText(/Project number/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '17' } });
    fireEvent.click(screen.getByText('Link'));
    expect(calls.confirm).toEqual([17]);
  });

  test('an empty value confirms as an unlink (null), and the button says Unlink', () => {
    const { calls } = setup({ initialNumber: 9 });
    const input = screen.getByPlaceholderText(/Project number/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('Unlink')).toBeDefined();
    fireEvent.click(screen.getByText('Unlink'));
    expect(calls.confirm).toEqual([null]);
  });

  test('a non-numeric value is rejected without confirming', () => {
    const { calls } = setup();
    const input = screen.getByPlaceholderText(/Project number/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.click(screen.getByText('Link'));
    expect(calls.confirm).toEqual([]);
    expect(screen.getByText(/positive whole number/)).toBeDefined();
  });

  test('cancel calls onCancel and confirms nothing', () => {
    const { calls } = setup();
    fireEvent.click(screen.getByText('Cancel'));
    expect(calls.cancel).toBe(1);
    expect(calls.confirm).toEqual([]);
  });

  test('a backdrop click (target is the dialog itself) cancels', () => {
    const { calls } = setup();
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    fireEvent.click(dialog); // event target === the dialog element = the backdrop
    expect(calls.cancel).toBe(1);
  });

  test('pre-fills the current number when already linked', () => {
    setup({ initialNumber: 42 });
    const input = screen.getByPlaceholderText(/Project number/) as HTMLInputElement;
    expect(input.value).toBe('42');
  });
});
