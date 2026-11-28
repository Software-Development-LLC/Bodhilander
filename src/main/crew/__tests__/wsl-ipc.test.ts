import { describe, expect, test } from 'bun:test';
import type { CrewWindowsProgress } from '../../../shared/types';
import { registerWindowsSetup, WINDOWS_ONLY } from '../wsl-ipc';
import type { WindowsSetupService } from '../wsl-setup-service';

function wire(service: Partial<WindowsSetupService> | null) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const sent: Array<[string, unknown]> = [];
  registerWindowsSetup((c, fn) => void handlers.set(c, fn), (c, p) => void sent.push([c, p]), () => service as WindowsSetupService | null);
  return { call: (c: string, ...a: unknown[]) => handlers.get(c)!(...a), sent, channels: [...handlers.keys()] };
}

describe('the Windows setup channels', () => {
  test('are the check, setup and Repair', () => {
    expect(wire(null).channels).toEqual(['crew:windowsCheckState', 'crew:windowsSetup', 'crew:windowsRepair']);
  });

  test('off Windows, or before Crew starts, nothing runs and the state is null', async () => {
    const t = wire(null);
    expect(await t.call('crew:windowsCheckState')).toBeNull();
    expect(await t.call('crew:windowsSetup')).toEqual({ ok: false, message: WINDOWS_ONLY, repair: false });
    expect(await t.call('crew:windowsRepair', true)).toEqual({ ok: false, message: WINDOWS_ONLY, repair: false });
  });

  test("setup's progress is sent as events; Repair is confirmed only by a literal true", async () => {
    const asked: boolean[] = [];
    const t = wire({
      state: async () => ({ state: 'ready' }),
      setup: async (onProgress: (p: CrewWindowsProgress) => void) => (onProgress({ step: 'download' }), { ok: true }),
      repair: async (confirmed: boolean) => (asked.push(confirmed), { ok: true }),
    });
    expect(await t.call('crew:windowsCheckState')).toEqual({ state: 'ready' });
    expect(await t.call('crew:windowsSetup')).toEqual({ ok: true });
    expect(t.sent).toEqual([['crew:windowsSetupProgress', { step: 'download' }]]);
    await t.call('crew:windowsRepair', 'yes');
    await t.call('crew:windowsRepair', true);
    expect(asked).toEqual([false, true]);
  });
});
