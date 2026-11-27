import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { SavedCopies } from '../SavedCopies';

afterEach(cleanup);

const copy = { name: 'BodhiCrew-2026-11-27.tar', sizeBytes: 3 * 1024 ** 3, savedAt: Date.parse('2026-11-27T10:00:00Z') };

describe('Saved copies', () => {
  test('lists each copy with its size', async () => {
    render(<SavedCopies load={async () => [copy]} remove={async () => ({ ok: true })} />);
    await screen.findByText('BodhiCrew-2026-11-27.tar');
    expect(screen.getByText(/3\.0 GB/)).toBeTruthy();
  });

  test('deletes only after the person confirms', async () => {
    const removed: string[] = [];
    render(<SavedCopies load={async () => [copy]} remove={async (n) => (removed.push(n), { ok: true })} />);
    fireEvent.click(await screen.findByText('Delete…'));
    expect(removed).toEqual([]);
    fireEvent.click(screen.getByText('Keep'));
    expect(removed).toEqual([]);
    fireEvent.click(screen.getByText('Delete…'));
    fireEvent.click(screen.getByText('Delete'));
    await screen.findByText('Deleted BodhiCrew-2026-11-27.tar.');
    expect(removed).toEqual(['BodhiCrew-2026-11-27.tar']);
  });

  test('a delete refused during a Repair says so', async () => {
    render(<SavedCopies load={async () => [copy]} remove={async () => ({ ok: false, error: 'Repair is using this copy' })} />);
    fireEvent.click(await screen.findByText('Delete…'));
    fireEvent.click(screen.getByText('Delete'));
    await screen.findByText('Repair is using this copy');
  });

  test('no copies is said plainly', async () => {
    render(<SavedCopies load={async () => []} remove={async () => ({ ok: true })} />);
    await screen.findByText(/No saved copies/);
  });
});
