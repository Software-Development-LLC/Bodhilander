/**
 * Persistence round-trip for the active-only toggle (#149).
 *
 * Run with: bun test src/renderer/hooks/__tests__/useActiveOnlyPreference.test.ts
 */
import { describe, test, expect, afterEach, mock } from 'bun:test';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import { useActiveOnlyPreference, ACTIVE_ONLY_PREF_KEY } from '../useActiveOnlyPreference';

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/** Installs a mock electronAPI whose getPreference resolves only when told. */
function installApi(stored: string | null) {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const getPreference = mock(() => gate.then(() => stored));
  const setPreference = mock(() => Promise.resolve());
  (window as unknown as { electronAPI: unknown }).electronAPI = { getPreference, setPreference };
  return { getPreference, setPreference, resolveLoad: release };
}

describe('useActiveOnlyPreference', () => {
  test('defaults to off before the preference loads', () => {
    installApi('true');
    const { result } = renderHook(() => useActiveOnlyPreference());
    expect(result.current[0]).toBe(false);
  });

  test('adopts a stored "true" once the read resolves', async () => {
    const api = installApi('true');
    const { result } = renderHook(() => useActiveOnlyPreference());
    await act(async () => { api.resolveLoad(); await Promise.resolve(); });
    await waitFor(() => expect(result.current[0]).toBe(true));
    expect(api.getPreference).toHaveBeenCalledWith(ACTIVE_ONLY_PREF_KEY);
  });

  test('a missing preference stays off', async () => {
    const api = installApi(null);
    const { result } = renderHook(() => useActiveOnlyPreference());
    await act(async () => { api.resolveLoad(); await Promise.resolve(); });
    expect(result.current[0]).toBe(false);
  });

  test('setting it persists the string value', async () => {
    const api = installApi(null);
    const { result } = renderHook(() => useActiveOnlyPreference());
    act(() => { result.current[1](true); });
    expect(result.current[0]).toBe(true);
    expect(api.setPreference).toHaveBeenCalledWith(ACTIVE_ONLY_PREF_KEY, 'true');
    act(() => { result.current[1](false); });
    expect(api.setPreference).toHaveBeenLastCalledWith(ACTIVE_ONLY_PREF_KEY, 'false');
  });

  test('a user toggle before the load resolves is not clobbered by the stale read', async () => {
    const api = installApi('true');           // stored ON
    const { result } = renderHook(() => useActiveOnlyPreference());
    // User turns it OFF while the read is still in flight.
    act(() => { result.current[1](false); });
    expect(result.current[0]).toBe(false);
    // Now the stale 'true' read resolves — it must be ignored.
    await act(async () => { api.resolveLoad(); await Promise.resolve(); });
    expect(result.current[0]).toBe(false);
    expect(api.setPreference).toHaveBeenCalledWith(ACTIVE_ONLY_PREF_KEY, 'false');
  });
});
