/**
 * Sidebar group/session filter tests (#141).
 *
 * Run with: bun test src/renderer/store/__tests__
 */
import { describe, expect, test } from 'bun:test';
import { computeGroupFilter } from '../groupFilter';
import { Group, Session } from '../../../shared/types';

function group(id: string, name: string, parentId: string | null = null): Group {
  return {
    id,
    name,
    color: '#61afef',
    workingDir: '',
    order: 0,
    createdAt: new Date(0),
    parentId,
    collapsed: false,
    claudeAccountId: null,
  } as Group;
}

function session(id: string, name: string, groupId: string): Session {
  return { id, name, groupId } as Session;
}

// Tree used by most tests:
//   API        (top)  -> sessions: s-api
//     Auth     (sub)  -> sessions: s-login
//     Billing  (sub)  -> sessions: s-invoice
//   Web        (top)  -> sessions: s-home
const GROUPS = [
  group('api', 'API'),
  group('api-auth', 'Auth', 'api'),
  group('api-bill', 'Billing', 'api'),
  group('web', 'Web'),
];
const SESSIONS = [
  session('s-api', 'api scratch', 'api'),
  session('s-login', 'login flow', 'api-auth'),
  session('s-invoice', 'invoice bug', 'api-bill'),
  session('s-home', 'homepage', 'web'),
];

describe('computeGroupFilter', () => {
  test('empty query is inactive with empty sets', () => {
    const r = computeGroupFilter(GROUPS, SESSIONS, '');
    expect(r.active).toBe(false);
    expect(r.visibleGroupIds.size).toBe(0);
    expect(r.visibleSessionIds.size).toBe(0);
  });

  test('whitespace-only query is inactive', () => {
    expect(computeGroupFilter(GROUPS, SESSIONS, '   ').active).toBe(false);
  });

  test('matching a top-level group reveals its whole subtree', () => {
    const r = computeGroupFilter(GROUPS, SESSIONS, 'api');
    expect(r.active).toBe(true);
    expect([...r.visibleGroupIds].sort()).toEqual(['api', 'api-auth', 'api-bill']);
    expect([...r.visibleSessionIds].sort()).toEqual(['s-api', 's-invoice', 's-login']);
  });

  test('match is case-insensitive and trims the query', () => {
    const r = computeGroupFilter(GROUPS, SESSIONS, '  WEB  ');
    expect(r.visibleGroupIds.has('web')).toBe(true);
    expect(r.visibleSessionIds.has('s-home')).toBe(true);
  });

  test('matching a sub-group keeps the parent visible but hides siblings', () => {
    const r = computeGroupFilter(GROUPS, SESSIONS, 'auth');
    expect([...r.visibleGroupIds].sort()).toEqual(['api', 'api-auth']);
    // parent is context only: its own session is not revealed
    expect([...r.visibleSessionIds]).toEqual(['s-login']);
  });

  test('matching a session in a top-level group shows only that session', () => {
    const r = computeGroupFilter(GROUPS, SESSIONS, 'scratch');
    expect([...r.visibleGroupIds]).toEqual(['api']);
    expect([...r.visibleSessionIds]).toEqual(['s-api']);
  });

  test('matching a session in a sub-group reveals sub-group and parent', () => {
    const r = computeGroupFilter(GROUPS, SESSIONS, 'invoice');
    expect([...r.visibleGroupIds].sort()).toEqual(['api', 'api-bill']);
    expect([...r.visibleSessionIds]).toEqual(['s-invoice']);
  });

  test('no matches leaves active true with empty sets', () => {
    const r = computeGroupFilter(GROUPS, SESSIONS, 'zzzz');
    expect(r.active).toBe(true);
    expect(r.visibleGroupIds.size).toBe(0);
    expect(r.visibleSessionIds.size).toBe(0);
  });

  test('a name-matched group reveals descendants whose names do not match', () => {
    const r = computeGroupFilter(GROUPS, SESSIONS, 'billing');
    expect([...r.visibleGroupIds].sort()).toEqual(['api', 'api-bill']);
    // 'invoice bug' does not contain 'billing' but is revealed by its group
    expect([...r.visibleSessionIds]).toEqual(['s-invoice']);
  });

  test('a session whose group is missing does not throw', () => {
    const r = computeGroupFilter(GROUPS, [session('orphan', 'orphan', 'gone')], 'orphan');
    expect(r.visibleSessionIds.has('orphan')).toBe(true);
    expect(r.visibleGroupIds.size).toBe(0);
  });

  test('returns fresh sets on each call', () => {
    const a = computeGroupFilter(GROUPS, SESSIONS, '');
    const b = computeGroupFilter(GROUPS, SESSIONS, '');
    expect(a.visibleGroupIds).not.toBe(b.visibleGroupIds);
  });

  test('does not mutate its inputs', () => {
    const groups = [...GROUPS];
    const sessions = [...SESSIONS];
    computeGroupFilter(groups, sessions, 'api');
    expect(groups).toEqual(GROUPS);
    expect(sessions).toEqual(SESSIONS);
  });

  test('survives a cyclic parentId without infinite recursion', () => {
    const a = group('a', 'Alpha', 'b');
    const b = group('b', 'Beta', 'a');
    const r = computeGroupFilter([a, b], [], 'alpha');
    expect(r.visibleGroupIds.has('a')).toBe(true);
    expect(r.visibleGroupIds.has('b')).toBe(true);
  });
});
