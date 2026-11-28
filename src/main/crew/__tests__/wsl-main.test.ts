import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as path from 'path';

mock.module('electron', () => ({ app: { getPath: () => path.join(path.sep, 'ud') } }));
mock.module('../../repositories/preferences', () => ({ getPreference: () => null }));
mock.module('../hub-service', () => ({ getCrewHub: () => null }));

const { windowsSetupDeps, windowsBackupDir } = await import('../wsl-main');

const saved = process.env.LOCALAPPDATA;
afterEach(() => {
  if (saved === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = saved;
});

describe('where Crew keeps its files on Windows', () => {
  test.each([
    ['set', path.join(path.sep, 'la')],
    ['unset', undefined],
  ])('with LOCALAPPDATA %s, Repair backs up where Saved copies looks', (_label, localAppData) => {
    if (localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAppData;
    const crewDir = windowsSetupDeps(async () => {}).crewDir;
    expect(crewDir).toBe(path.join(localAppData ?? path.join(path.sep, 'ud'), 'Bodhilander', 'crew'));
    expect(windowsBackupDir()).toBe(path.join(crewDir, 'backup'));
  });
});
