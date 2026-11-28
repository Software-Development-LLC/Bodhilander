/** The Electron-side pieces Set up Crew on Windows and Repair need: where they keep files, the link state and the Hub. */
import * as path from 'path';
import { app } from 'electron';
import { getPreference } from '../repositories/preferences';
import { MACHINE_ID_PREF } from './hub-client';
import { getCrewHub } from './hub-service';
import type { ArtifactHub } from './artifacts';
import type { WindowsCrewDeps } from './wsl-runtime';

/** Setup, Repair and Saved copies all read this, so a backup is listed wherever it was written. */
export function windowsCrewDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'Bodhilander', 'crew');
}

export function windowsBackupDir(): string {
  return path.join(windowsCrewDir(), 'backup');
}

export function windowsSetupDeps(onRepaired: () => Promise<void>): Pick<WindowsCrewDeps, 'crewDir' | 'linked' | 'artifactHub' | 'onRepaired'> {
  return {
    crewDir: windowsCrewDir(),
    linked: () => !!getPreference(MACHINE_ID_PREF),
    artifactHub: () => getCrewHub() as unknown as ArtifactHub | null,
    onRepaired,
  };
}
