import { describe, expect, test } from 'bun:test';
import { COPY_IN_USE, deleteSavedCopy, listSavedCopies, registerSavedCopies, type BackupFs } from '../wsl-backup';
import { RepairLock } from '../wsl';

function memFs(files: Record<string, { size: number; mtimeMs: number }>) {
  const removed: string[] = [];
  const fsx: BackupFs & { removed: string[] } = {
    removed,
    readdirSync: () => Object.keys(files).map((p) => p.split(/[\\/]/).pop() as string),
    statSync: (p) => ({ ...files[Object.keys(files).find((k) => p.endsWith(k.split(/[\\/]/).pop() as string)) as string], isFile: () => true }),
    rmSync: (p) => void removed.push(p),
  };
  return fsx;
}

const files = { 'BodhiCrew-2026-11-01.tar': { size: 10, mtimeMs: 1 }, 'BodhiCrew-2026-11-27-2.tar': { size: 20, mtimeMs: 2 }, 'notes.txt': { size: 1, mtimeMs: 3 } };

describe('Saved copies', () => {
  test('lists only Repair exports, newest first, with size and date', () => {
    expect(listSavedCopies('/b', memFs(files))).toEqual([
      { name: 'BodhiCrew-2026-11-27-2.tar', sizeBytes: 20, savedAt: 2 },
      { name: 'BodhiCrew-2026-11-01.tar', sizeBytes: 10, savedAt: 1 },
    ]);
    expect(listSavedCopies('/missing', { ...memFs({}), readdirSync: () => { throw new Error('ENOENT'); } })).toEqual([]);
  });

  test('a delete takes the Repair lock for its whole duration and releases it', () => {
    const lock = new RepairLock();
    let heldDuring = false;
    const fsx = memFs(files);
    fsx.rmSync = () => void (heldDuring = lock.held);
    expect(deleteSavedCopy('/b', 'BodhiCrew-2026-11-01.tar', lock, fsx)).toEqual({ ok: true });
    expect(heldDuring).toBe(true);
    expect(lock.held).toBe(false);
  });

  test('refused while a Repair holds the lock, and nothing is deleted', () => {
    const lock = new RepairLock();
    const release = lock.tryAcquire();
    const fsx = memFs(files);
    expect(deleteSavedCopy('/b', 'BodhiCrew-2026-11-01.tar', lock, fsx)).toEqual({ ok: false, error: COPY_IN_USE });
    expect(fsx.removed).toEqual([]);
    release?.();
    expect(deleteSavedCopy('/b', 'BodhiCrew-2026-11-01.tar', lock, fsx).ok).toBe(true);
  });

  test('a name that is not a saved copy, or a path, is refused', () => {
    const fsx = memFs(files);
    for (const n of ['notes.txt', '../BodhiCrew-2026-11-01.tar', 'BodhiCrew-2026-11-01.tar/../../x']) expect(deleteSavedCopy('/b', n, new RepairLock(), fsx).ok).toBe(false);
    expect(fsx.removed).toEqual([]);
  });

  test('off Windows the channels list nothing and delete nothing', async () => {
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    registerSavedCopies({ handle: (c, fn) => void (handlers[c] = fn), backupDir: null });
    expect(await handlers['crew:listSavedCopies']()).toEqual([]);
    expect((await handlers['crew:deleteSavedCopy']('BodhiCrew-2026-11-01.tar')) as { ok: boolean }).toMatchObject({ ok: false });
  });
});
