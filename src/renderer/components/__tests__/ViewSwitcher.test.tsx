/**
 * View switcher acceptance tests.
 *
 * The regression these exist for: the arrow-key handler resolved the next tab
 * with `e.currentTarget.querySelector(...)`. Because the handler lives on the
 * tab BUTTONS (they are what take focus), currentTarget is a SIBLING of the tab
 * being moved to — so the query always returned null and `?.focus()` silently
 * no-opped. Selection moved, DOM focus did not, which breaks the roving
 * tabindex contract: the tab still holding focus was left at tabIndex={-1}.
 *
 * Run with: bun test src/renderer/components/__tests__/ViewSwitcher.test.tsx
 */
import React, { useState } from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ViewSwitcher, ContentView, VIEW_TABS } from '../ViewSwitcher';

afterEach(cleanup);

/** Mirrors how App.tsx owns the value, so tests exercise the real interaction. */
function Harness({ initial = 'terminal' as ContentView }) {
  const [value, setValue] = useState<ContentView>(initial);
  return (
    <>
      <ViewSwitcher value={value} onChange={setValue} shortcutPrefix="⌘" />
      <span data-testid="value">{value}</span>
    </>
  );
}

const tab = (name: string) => screen.getByRole('tab', { name }) as HTMLButtonElement;
const current = () => screen.getByTestId('value').textContent;

describe('ViewSwitcher', () => {
  test('renders one tab per destination, with the active one selected', () => {
    render(<Harness />);
    expect(screen.getAllByRole('tab')).toHaveLength(VIEW_TABS.length);
    expect(tab('Terminal').getAttribute('aria-selected')).toBe('true');
    expect(tab('Analytics').getAttribute('aria-selected')).toBe('false');
  });

  test('each tab points at its panel via aria-controls', () => {
    render(<Harness />);
    expect(tab('Terminal').getAttribute('aria-controls')).toBe('view-panel-terminal');
    expect(tab('Analytics').getAttribute('aria-controls')).toBe('view-panel-analytics');
    expect(tab('Arena').getAttribute('aria-controls')).toBe('view-panel-arena');
  });

  test('roving tabIndex: only the selected tab is in the tab order', () => {
    render(<Harness />);
    expect(tab('Terminal').tabIndex).toBe(0);
    expect(tab('Analytics').tabIndex).toBe(-1);
    expect(tab('Arena').tabIndex).toBe(-1);
  });

  test('clicking a tab selects it', () => {
    render(<Harness />);
    fireEvent.click(tab('Arena'));
    expect(current()).toBe('arena');
    expect(tab('Arena').getAttribute('aria-selected')).toBe('true');
  });

  // --- The regression ------------------------------------------------------

  test('ArrowRight moves selection AND DOM focus to the next tab', () => {
    render(<Harness />);
    tab('Terminal').focus();

    fireEvent.keyDown(tab('Terminal'), { key: 'ArrowRight' });

    expect(current()).toBe('analytics');
    // This is the assertion that fails when focus is resolved from
    // e.currentTarget rather than from the tablist.
    expect(document.activeElement).toBe(tab('Analytics'));
  });

  test('focus and the roving tabIndex stay in agreement after moving', () => {
    render(<Harness />);
    tab('Terminal').focus();
    fireEvent.keyDown(tab('Terminal'), { key: 'ArrowRight' });

    // The focused element must be the one in the tab order, or a keyboard user
    // is left on an element Tab can no longer reach.
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
    expect(tab('Terminal').tabIndex).toBe(-1);
  });

  test('ArrowLeft moves backwards and wraps', () => {
    render(<Harness />);
    tab('Terminal').focus();
    fireEvent.keyDown(tab('Terminal'), { key: 'ArrowLeft' });

    expect(current()).toBe('arena');
    expect(document.activeElement).toBe(tab('Arena'));
  });

  test('ArrowRight wraps from the last tab back to the first', () => {
    render(<Harness initial="arena" />);
    tab('Arena').focus();
    fireEvent.keyDown(tab('Arena'), { key: 'ArrowRight' });

    expect(current()).toBe('terminal');
    expect(document.activeElement).toBe(tab('Terminal'));
  });

  test('Home and End jump to the ends', () => {
    render(<Harness initial="analytics" />);
    tab('Analytics').focus();

    fireEvent.keyDown(tab('Analytics'), { key: 'End' });
    expect(current()).toBe('arena');
    expect(document.activeElement).toBe(tab('Arena'));

    fireEvent.keyDown(tab('Arena'), { key: 'Home' });
    expect(current()).toBe('terminal');
    expect(document.activeElement).toBe(tab('Terminal'));
  });

  test('ArrowDown/ArrowUp behave like Right/Left', () => {
    render(<Harness />);
    tab('Terminal').focus();
    fireEvent.keyDown(tab('Terminal'), { key: 'ArrowDown' });
    expect(current()).toBe('analytics');

    fireEvent.keyDown(tab('Analytics'), { key: 'ArrowUp' });
    expect(current()).toBe('terminal');
  });

  test('an unrelated key changes nothing and is left to propagate', () => {
    render(<Harness />);
    tab('Terminal').focus();
    fireEvent.keyDown(tab('Terminal'), { key: 'a' });
    expect(current()).toBe('terminal');
    expect(document.activeElement).toBe(tab('Terminal'));
  });

  test('tooltips carry the platform-correct shortcut', () => {
    render(<Harness />);
    expect(tab('Terminal').title).toBe('Terminal (⌘1)');
    expect(tab('Arena').title).toBe('Arena (⌘3)');
  });
});
