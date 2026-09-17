/**
 * Groups repository tests — the board-driven orchestration association
 * (CO-722, Phase 2B): a group's optional GitHub-project number/name + clone
 * root must survive create/read and be updatable (including back to null).
 *
 * Uses bun:sqlite (API-compatible with better-sqlite3 for these statements) so
 * no native build is required.
 *
 * Run with: bun test src/main/repositories/__tests__/groups.test.ts
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Group } from '../../../shared/types';

let db: Database;

mock.module('../../database', () => ({
  getDatabase: () => db,
}));

const groupsRepo = await import('../groups');

function freshDb(): Database {
  const d = new Database(':memory:');
  // Post-migration groups schema.
  d.exec(`
    CREATE TABLE groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#888888',
      working_dir TEXT DEFAULT '',
      "order" INTEGER DEFAULT 0,
      created_at TEXT,
      parent_id TEXT DEFAULT NULL,
      collapsed INTEGER DEFAULT 0,
      claude_account_id TEXT DEFAULT NULL,
      github_project_number INTEGER DEFAULT NULL,
      github_project_name TEXT DEFAULT NULL,
      clone_root TEXT DEFAULT NULL
    )
  `);
  return d;
}

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 'g1',
    name: 'test',
    color: '#123456',
    workingDir: '/tmp',
    order: 0,
    createdAt: new Date('2026-07-13T00:00:00Z'),
    parentId: null,
    collapsed: false,
    claudeAccountId: null,
    githubProjectNumber: null,
    githubProjectName: null,
    cloneRoot: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = freshDb();
});

describe('board association', () => {
  test('createGroup/getAllGroups round-trips the project link and clone root', () => {
    groupsRepo.createGroup(makeGroup({
      id: 'linked',
      githubProjectNumber: 17,
      githubProjectName: 'Bodhi Pulse',
      cloneRoot: 'C:/work/repos',
    }));
    const g = groupsRepo.getAllGroups().find(x => x.id === 'linked');
    expect(g).toBeDefined();
    expect(g!.githubProjectNumber).toBe(17);
    expect(g!.githubProjectName).toBe('Bodhi Pulse');
    expect(g!.cloneRoot).toBe('C:/work/repos');
  });

  test('a group with no association reads back all-null (the default)', () => {
    groupsRepo.createGroup(makeGroup({ id: 'plain' }));
    const g = groupsRepo.getAllGroups().find(x => x.id === 'plain');
    expect(g!.githubProjectNumber).toBeNull();
    expect(g!.githubProjectName).toBeNull();
    expect(g!.cloneRoot).toBeNull();
  });

  test('updateGroup sets an association on a previously-unlinked group', () => {
    groupsRepo.createGroup(makeGroup({ id: 'g' }));
    groupsRepo.updateGroup('g', { githubProjectNumber: 42, githubProjectName: 'Ops', cloneRoot: '/srv' });
    const g = groupsRepo.getAllGroups().find(x => x.id === 'g');
    expect(g!.githubProjectNumber).toBe(42);
    expect(g!.githubProjectName).toBe('Ops');
    expect(g!.cloneRoot).toBe('/srv');
  });

  test('updateGroup can clear an association back to null (unlink)', () => {
    groupsRepo.createGroup(makeGroup({ id: 'g', githubProjectNumber: 7, githubProjectName: 'X', cloneRoot: '/x' }));
    groupsRepo.updateGroup('g', { githubProjectNumber: null, githubProjectName: null });
    const g = groupsRepo.getAllGroups().find(x => x.id === 'g');
    expect(g!.githubProjectNumber).toBeNull();
    expect(g!.githubProjectName).toBeNull();
    // cloneRoot was not in the update, so it is left as-is.
    expect(g!.cloneRoot).toBe('/x');
  });

  test('updateGroup leaves the association untouched when not in the patch', () => {
    groupsRepo.createGroup(makeGroup({ id: 'g', githubProjectNumber: 9, githubProjectName: 'Keep', cloneRoot: '/k' }));
    groupsRepo.updateGroup('g', { name: 'renamed' });
    const g = groupsRepo.getAllGroups().find(x => x.id === 'g');
    expect(g!.name).toBe('renamed');
    expect(g!.githubProjectNumber).toBe(9);
    expect(g!.githubProjectName).toBe('Keep');
    expect(g!.cloneRoot).toBe('/k');
  });
});
