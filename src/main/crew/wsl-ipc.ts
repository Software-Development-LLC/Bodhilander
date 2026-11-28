/** The Windows setup screen's channels: the state check, Set up Crew on Windows with progress events, and Repair. */
import type { CrewWindowsRepairResult, CrewWindowsSetupResult, CrewWindowsState } from '../../shared/types';
import type { WindowsSetupService } from './wsl-setup-service';

export const WINDOWS_ONLY = 'Crew setup runs on Windows only, once Crew has started.';
export const SETUP_PROGRESS = 'crew:windowsSetupProgress';

const unavailable: CrewWindowsSetupResult = { ok: false, message: WINDOWS_ONLY, repair: false };

export function registerWindowsSetup(
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => void,
  send: (channel: string, payload: unknown) => void,
  current: () => WindowsSetupService | null,
): void {
  handle('crew:windowsCheckState', async (): Promise<CrewWindowsState | null> => (await current()?.state()) ?? null);
  handle('crew:windowsSetup', async (): Promise<CrewWindowsSetupResult> => {
    const s = current();
    return s ? s.setup((p) => send(SETUP_PROGRESS, p)) : unavailable;
  });
  handle('crew:windowsRepair', async (confirmed: unknown): Promise<CrewWindowsRepairResult> => {
    const s = current();
    return s ? s.repair(confirmed === true) : unavailable;
  });
}
