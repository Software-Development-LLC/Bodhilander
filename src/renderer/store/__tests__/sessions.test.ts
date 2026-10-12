/**
 * The sessions store, which is where the renderer's copy of a session comes
 * from. Part of a session is derived in main from the filesystem, so a local
 * merge of a patch cannot produce it — these pin that the copy the UI reads
 * is reconciled rather than guessed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useSessions } from '../sessions';

interface Row {
  id: string;
  workingDir: string;
  state: string;
  name: string;
}

/** Directories that exist on this pretend machine. */
let onDisk: Set<string>;
let rows: Row[];
let refreshCallbacks: (() => void)[];
let updateFails: boolean;

function session(id: string, workingDir: string, state = 'stopped'): Row {
  return { id, workingDir, state, name: id };
}

/**
 * Stands in for main: reads answer from the row AND the filesystem, exactly as
 * the sessions repository derives workingDirMissing on every read.
 */
function serve() {
  return rows.map(r => ({
    ...r,
    groupId: 'g1',
    shellType: 'claude',
    provider: 'claude',
    order: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActivityAt: new Date('2026-01-01T00:00:00Z'),
    claudeSessionId: null,
    endedAt: null,
    durationSeconds: 0,
    claudeAccountId: null,
    workingDirMissing: !onDisk.has(r.workingDir),
  }));
}

beforeEach(() => {
  onDisk = new Set(['/real/dir']);
  rows = [session('s1', '/gone/dir')];
  refreshCallbacks = [];
  updateFails = false;

  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getAllSessions: async () => serve(),
    updateDbSession: async (id: string, updates: Record<string, unknown>) => {
      if (updateFails) throw new Error('main refused the write');
      const row = rows.find(r => r.id === id);
      if (row) Object.assign(row, updates);
    },
    onStateChange: () => () => {},
    onSessionsRefresh: (cb: () => void) => {
      refreshCallbacks.push(cb);
      return () => {};
    },
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function mounted() {
  const view = renderHook(() => useSessions());
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

describe('a session whose working directory is missing', () => {
  test('arrives parked from main', async () => {
    const { result } = await mounted();
    expect(result.current.sessions[0].workingDirMissing).toBe(true);
  });

  test('is no longer parked once it is pointed at a folder that exists', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.updateSession('s1', { workingDir: '/real/dir', state: 'stopped' });
    });

    // The bug this pins: the patch carries no workingDirMissing, so a merge
    // alone left the stale true and the blocked pane named a folder that
    // existed. Only main can answer, so the store has to ask.
    expect(result.current.sessions[0].workingDir).toBe('/real/dir');
    expect(result.current.sessions[0].workingDirMissing).toBe(false);
  });

  test('relinking twice does not toggle it back on', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.updateSession('s1', { workingDir: '/real/dir', state: 'stopped' });
    });
    await act(async () => {
      await result.current.updateSession('s1', { workingDir: '/real/dir', state: 'stopped' });
    });

    expect(result.current.sessions[0].workingDirMissing).toBe(false);
  });
});

describe('a folder that changes under a running app', () => {
  test('parks a healthy session when the window is next focused', async () => {
    rows = [session('s1', '/real/dir')];
    const { result } = await mounted();
    expect(result.current.sessions[0].workingDirMissing).toBe(false);

    onDisk.delete('/real/dir');
    await act(async () => { window.dispatchEvent(new Event('focus')); });

    await waitFor(() => expect(result.current.sessions[0].workingDirMissing).toBe(true));
  });

  test('unparks one the same way, without an app restart', async () => {
    const { result } = await mounted();
    expect(result.current.sessions[0].workingDirMissing).toBe(true);

    onDisk.add('/gone/dir');
    await act(async () => { window.dispatchEvent(new Event('focus')); });

    await waitFor(() => expect(result.current.sessions[0].workingDirMissing).toBe(false));
  });

  test('stops asking once the hook is gone', async () => {
    const { unmount, result } = await mounted();
    unmount();

    onDisk.add('/gone/dir');
    await act(async () => { window.dispatchEvent(new Event('focus')); });

    expect(result.current.sessions[0].workingDirMissing).toBe(true);
  });
});

describe('the rest of the update path', () => {
  test('a rename still lands', async () => {
    const { result } = await mounted();

    await act(async () => {
      await result.current.updateSession('s1', { name: 'renamed' });
    });

    expect(result.current.sessions[0].name).toBe('renamed');
  });

  test('a refused write leaves the list as main last reported it', async () => {
    const { result } = await mounted();
    updateFails = true;

    await act(async () => {
      await result.current.updateSession('s1', { workingDir: '/real/dir' });
    });

    expect(result.current.sessions[0].workingDir).toBe('/gone/dir');
    expect(result.current.sessions[0].workingDirMissing).toBe(true);
  });

  test('a remote session creation still refetches', async () => {
    const { result } = await mounted();
    rows.push(session('s2', '/real/dir'));

    await act(async () => { refreshCallbacks.forEach(cb => cb()); });

    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
  });
});
