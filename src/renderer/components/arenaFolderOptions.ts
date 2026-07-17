import { Group } from '../../shared/types';

export interface ArenaFolderOption {
  groupId: string;
  /** Group name plus its directory, for the folder select. */
  label: string;
  dir: string;
}

/**
 * Build the arena folder-scope options from the sidebar groups: one option
 * per group that has a working directory set, in sidebar order. Groups
 * without a directory can't scope a run, so they don't appear. Duplicate
 * directories are kept — the group name is what the user recognizes.
 *
 * Pure — extracted from ArenaPanel for direct unit testing.
 */
export function buildFolderOptions(
  groups: Pick<Group, 'id' | 'name' | 'workingDir'>[]
): ArenaFolderOption[] {
  return groups
    .filter((g) => g.workingDir && g.workingDir.trim() !== '')
    .map((g) => ({ groupId: g.id, label: `${g.name} — ${g.workingDir}`, dir: g.workingDir }));
}
