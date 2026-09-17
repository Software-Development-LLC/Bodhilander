/**
 * Board view tests (board-driven orchestration, Phase 1).
 *
 * Read-only surface. What matters: eligible initiatives are shown as ready,
 * cross-repo children render under their initiative, and a "couldn't read it"
 * problem is shown loudly (never a silently empty board — the one wrong answer).
 *
 * Run with: bun test src/renderer/components/__tests__/BoardView.test.tsx
 */
import { describe, expect, test } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { BoardView } from '../BoardView';
import type { BoardInitiative, BoardResult } from '../../../shared/types';

const init = (over: Partial<BoardInitiative> & { number: number; title?: string; status?: string | null; eligible?: boolean }): BoardInitiative => ({
  item: { number: over.number, title: over.title ?? `#${over.number}`, repo: over.item?.repo ?? 'bodhi-code', state: 'OPEN', status: over.status ?? 'Todo', url: 'u', assignees: [] },
  children: over.children ?? [],
  repos: over.repos ?? ['bodhi-code'],
  eligible: over.eligible ?? false,
});

const ok = (initiatives: BoardInitiative[]): BoardResult => ({ status: 'ok', project: { title: 'Bodhi Pulse', number: 17, initiatives } });

describe('BoardView', () => {
  test('shows eligible initiatives under "Ready to start"', async () => {
    render(<BoardView load={async () => ok([
      init({ number: 130, title: '[CO-130] Cross thing', status: 'Approved', eligible: true,
             repos: ['bodhi-code', 'bodhi-service-api'],
             children: [{ number: 2561, title: 'child', repo: 'bodhi-service-api', state: 'OPEN', status: 'Todo', url: 'u', assignees: [] }] }),
      init({ number: 900, title: '[CO-900] Later', status: 'Todo', eligible: false }),
    ])} />);
    await screen.findByText(/Ready to start/);
    expect(screen.getByText('[CO-130] Cross thing')).toBeTruthy();
    expect(screen.getByText(/Other initiatives/)).toBeTruthy();
    // Cross-repo child renders under its initiative.
    expect(screen.getByText('bodhi-service-api')).toBeTruthy();
    expect(screen.getByText(/2 repos:/)).toBeTruthy();
  });

  test('a read problem is shown loudly, not as an empty board', async () => {
    render(<BoardView load={async () => ({ status: 'problem', problem: 'No GitHub org configured' })} />);
    await screen.findByRole('alert');
    expect(screen.getByText('No GitHub org configured')).toBeTruthy();
    expect(screen.queryByText(/Ready to start/)).toBeNull();
  });

  test('an IPC throw becomes a shown problem, not a crash', async () => {
    render(<BoardView load={async () => { throw new Error('the store is locked'); }} />);
    await screen.findByText(/the store is locked/);
  });

  test('does not claim an empty board before it has loaded', () => {
    render(<BoardView load={() => new Promise(() => {})} />);
    expect(screen.queryByText(/initiatives/)).toBeNull();
    expect(screen.getByText(/Reading the board/)).toBeTruthy();
  });

  test('an empty board says so rather than looking broken', async () => {
    render(<BoardView load={async () => ok([])} />);
    await screen.findByText(/No initiatives on this board yet/);
  });
});
