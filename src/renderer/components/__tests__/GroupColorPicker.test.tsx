/**
 * GroupColorPicker tests (#141).
 *
 * Run with: bun test src/renderer/components/__tests__/GroupColorPicker.test.tsx
 */
import React from 'react';
import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { GroupColorPicker } from '../GroupColorPicker';

afterEach(cleanup);

const COLORS = ['#e06c75', '#98c379', '#61afef'];

describe('GroupColorPicker', () => {
  test('renders one labelled swatch per colour', () => {
    render(<GroupColorPicker colors={COLORS} selected={COLORS[0]} onSelect={() => {}} />);
    expect(document.querySelectorAll('.color-option').length).toBe(3);
    expect(screen.getByLabelText('Set color to #98c379')).toBeTruthy();
  });

  test('only the applied colour is marked selected', () => {
    render(<GroupColorPicker colors={COLORS} selected={COLORS[1]} onSelect={() => {}} />);
    const selected = document.querySelectorAll('.color-option.selected');
    expect(selected.length).toBe(1);
    expect((selected[0] as HTMLElement).getAttribute('aria-label')).toBe('Set color to #98c379');
  });

  test('clicking a swatch reports that colour', () => {
    const picked: string[] = [];
    render(<GroupColorPicker colors={COLORS} selected={COLORS[0]} onSelect={(c) => picked.push(c)} />);
    fireEvent.click(screen.getByLabelText('Set color to #61afef'));
    expect(picked).toEqual(['#61afef']);
  });

  test('a colour matching nothing selects none', () => {
    render(<GroupColorPicker colors={COLORS} selected="#000000" onSelect={() => {}} />);
    expect(document.querySelectorAll('.color-option.selected').length).toBe(0);
  });
});
