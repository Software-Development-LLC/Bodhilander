/**
 * Saved copies: Repair's `BodhiCrew-<date>.tar` exports, listed and deleted
 * only on the person's confirmation. A delete holds the Repair lock for its
 * whole duration, so a copy is never deleted while an import from it runs.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { CrewEditResult, CrewSavedCopy } from '../../shared/types';
import { repairLock, type RepairLock } from './wsl';

export const COPY_IN_USE = 'Repair is using this copy';
const COPY_NAME = /^BodhiCrew-\d{4}-\d{2}-\d{2}(-\d+)?\.tar$/;

export interface BackupFs {
  readdirSync(dir: string): string[];
  statSync(p: string): { size: number; mtimeMs: number; isFile(): boolean };
  rmSync(p: string, opts: { force: boolean }): void;
}

export function listSavedCopies(dir: string, fsx: BackupFs = fs): CrewSavedCopy[] {
  let names: string[];
  try {
    names = fsx.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CrewSavedCopy[] = [];
  for (const name of names.filter((n) => COPY_NAME.test(n))) {
    try {
      const st = fsx.statSync(path.join(dir, name));
      if (st.isFile()) out.push({ name, sizeBytes: st.size, savedAt: st.mtimeMs });
    } catch {
      // Removed between the listing and the stat.
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Refused, never waited on, while a Repair holds the lock. */
export function deleteSavedCopy(dir: string, name: string, lock: RepairLock = repairLock, fsx: BackupFs = fs): CrewEditResult {
  if (!COPY_NAME.test(name)) return { ok: false, error: 'That is not a saved copy.' };
  const release = lock.tryAcquire();
  if (!release) return { ok: false, error: COPY_IN_USE };
  try {
    fsx.rmSync(path.join(dir, name), { force: true });
    return { ok: true };
  } catch {
    return { ok: false, error: "The copy couldn't be deleted." };
  } finally {
    release();
  }
}

export interface SavedCopiesDeps {
  handle(channel: string, fn: (...args: unknown[]) => unknown): void;
  /** %LOCALAPPDATA%\Bodhilander\crew\backup, or null off Windows. */
  backupDir: string | null;
  lock?: RepairLock;
  fsx?: BackupFs;
}

export function registerSavedCopies(deps: SavedCopiesDeps): void {
  deps.handle('crew:listSavedCopies', () => (deps.backupDir ? listSavedCopies(deps.backupDir, deps.fsx) : []));
  deps.handle('crew:deleteSavedCopy', (name: unknown): CrewEditResult => {
    if (!deps.backupDir || typeof name !== 'string') return { ok: false, error: 'That is not a saved copy.' };
    return deleteSavedCopy(deps.backupDir, name, deps.lock, deps.fsx);
  });
}
