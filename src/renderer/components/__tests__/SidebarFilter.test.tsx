/**
 * Sidebar filter UI acceptance tests (#141).
 *
 * Run with: bun test src/renderer/components/__tests__/SidebarFilter.test.tsx
 */
import React, { useState } from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SidebarFilter } from '../SidebarFilter';

afterEach(cleanup);

/** Mirrors how App.tsx owns the value, so tests exercise the real interaction. */
function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <SidebarFilter value={value} onChange={setValue} />
      <span data-testid="value">{value}</span>
    </>
  );
}

const input = () => screen.getByLabelText('Filter groups and sessions') as HTMLInputElement;
const currentValue = () => screen.getByTestId('value').textContent;

describe('SidebarFilter', () => {
  test('renders an empty, labelled input with a placeholder', () => {
    render(<Harness />);
    expect(input().value).toBe('');
    expect(input().placeholder).toBe('Filter groups & sessions…');
  });

  test('typing updates the value', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'api' } });
    expect(currentValue()).toBe('api');
  });

  test('the clear button is hidden while the box is empty', () => {
    render(<Harness />);
    expect(screen.queryByLabelText('Clear filter')).toBeNull();
  });

  test('the clear button appears once there is text', () => {
    render(<Harness initial="api" />);
    expect(screen.queryByLabelText('Clear filter')).not.toBeNull();
  });

  test('clicking clear empties the box and refocuses the input', () => {
    render(<Harness initial="api" />);
    fireEvent.click(screen.getByLabelText('Clear filter'));
    expect(currentValue()).toBe('');
    expect(document.activeElement).toBe(input());
  });

  test('Escape clears a non-empty box', () => {
    render(<Harness initial="api" />);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(currentValue()).toBe('');
  });

  test('Escape on a non-empty box does not reach app-level handlers', () => {
    render(<Harness initial="api" />);
    let sawEscape = false;
    const listener = () => { sawEscape = true; };
    document.addEventListener('keydown', listener);
    fireEvent.keyDown(input(), { key: 'Escape', bubbles: true });
    document.removeEventListener('keydown', listener);
    expect(sawEscape).toBe(false);
  });

  test('Escape on an empty box blurs and still reaches app-level handlers', () => {
    render(<Harness />);
    input().focus();
    let sawEscape = false;
    const listener = () => { sawEscape = true; };
    document.addEventListener('keydown', listener);
    fireEvent.keyDown(input(), { key: 'Escape', bubbles: true });
    document.removeEventListener('keydown', listener);
    expect(sawEscape).toBe(true);
    expect(document.activeElement).not.toBe(input());
  });

  test('other keys are left alone', () => {
    render(<Harness initial="api" />);
    fireEvent.keyDown(input(), { key: 'a' });
    expect(currentValue()).toBe('api');
  });
});
