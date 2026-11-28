import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { WindowsSettings } from '../WindowsSettings';

afterEach(cleanup);

describe('Crew Windows settings', () => {
  test('mount nothing off Windows', () => {
    const { container } = render(<WindowsSettings platform="darwin" />);
    expect(container.textContent).toBe('');
  });
});
