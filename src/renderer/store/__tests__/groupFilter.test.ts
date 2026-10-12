/**
 * Sidebar group/session filter tests (#141).
 *
 * Run with: bun test src/renderer/store/__tests__
 */
import { describe, expect, test } from 'bun:test';
import { computeGroupFilter, buildNavItems } from '../groupFilter';
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

function session(
  id: string,
  name: string,
  groupId: string,
  state: Session['state'] = 'idle',
): Session {
  return { id, name, groupId, state } as Session;
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
    // Deep snapshots — a shallow [...copy] shares element references, so
    // per-element mutation would go undetected.
    const groups = GROUPS.map(g => ({ ...g }));
    const sessions = SESSIONS.map(s => ({ ...s }));
    const groupsBefore = JSON.stringify(groups);
    const sessionsBefore = JSON.stringify(sessions);

    computeGroupFilter(groups, sessions, 'api');

    expect(JSON.stringify(groups)).toBe(groupsBefore);
    expect(JSON.stringify(sessions)).toBe(sessionsBefore);
  });

  test('survives a cyclic parentId without infinite recursion', () => {
    const a = group('a', 'Alpha', 'b');
    const b = group('b', 'Beta', 'a');
    const r = computeGroupFilter([a, b], [], 'alpha');
    expect(r.visibleGroupIds.has('a')).toBe(true);
    expect(r.visibleGroupIds.has('b')).toBe(true);
  });
});

describe('buildNavItems', () => {
  const noFilter = () => computeGroupFilter(GROUPS, SESSIONS, '');

  test('unfiltered list walks groups, their sessions, then sub-groups', () => {
    const items = buildNavItems(GROUPS, SESSIONS, noFilter());
    expect(items.map(i => i.id)).toEqual([
      'api', 's-api', 'api-auth', 's-login', 'api-bill', 's-invoice',
      'web', 's-home',
    ]);
  });

  test('collapsed group hides its children when no filter is active', () => {
    const collapsed = GROUPS.map(g => (g.id === 'api' ? { ...g, collapsed: true } : g));
    const items = buildNavItems(collapsed, SESSIONS, computeGroupFilter(collapsed, SESSIONS, ''));
    expect(items.map(i => i.id)).toEqual(['api', 'web', 's-home']);
  });

  test('only rendered rows are navigable while filtering', () => {
    const items = buildNavItems(GROUPS, SESSIONS, computeGroupFilter(GROUPS, SESSIONS, 'invoice'));
    // parent shown as context, sub-group and its matching session navigable
    expect(items.map(i => i.id)).toEqual(['api', 'api-bill', 's-invoice']);
  });

  test('a collapsed group is navigable while filtering (matches auto-expand)', () => {
    const collapsed = GROUPS.map(g => (g.id === 'api' ? { ...g, collapsed: true } : g));
    const items = buildNavItems(collapsed, SESSIONS, computeGroupFilter(collapsed, SESSIONS, 'invoice'));
    // force-expanded on screen, so the row must be reachable by keyboard
    expect(items.map(i => i.id)).toEqual(['api', 'api-bill', 's-invoice']);
  });

  test('activeOnly does NOT force-expand: a collapsed group keeps its sessions off the nav list (#149)', () => {
    const groups = [
      { ...group('a', 'Alpha'), collapsed: true },
      { ...group('b', 'Beta') },
    ];
    const sessions = [
      session('s1', 'x', 'a', 'working'),
      session('s2', 'y', 'b', 'working'),
    ];
    // forceExpand defaults to filter.active; pass `false` as the caller (App)
    // does for the active-only toggle (no text search).
    const f = computeGroupFilter(groups, sessions, '', true);
    const items = buildNavItems(groups, sessions, f, false);
    // 'a' is visible (has an active session) but collapsed, so its session is
    // not walked; 'b' is expanded so its session is.
    expect(items.map(i => i.id)).toEqual(['a', 'b', 's2']);
  });

  test('a text search still force-expands (forceExpand defaults to filter.active)', () => {
    const groups = [{ ...group('a', 'Alpha'), collapsed: true }];
    const sessions = [session('s1', 'x', 'a', 'working')];
    const f = computeGroupFilter(groups, sessions, 'alpha');
    const items = buildNavItems(groups, sessions, f); // default forceExpand
    expect(items.map(i => i.id)).toEqual(['a', 's1']);
  });

  test('no matches yields an empty nav list', () => {
    const items = buildNavItems(GROUPS, SESSIONS, computeGroupFilter(GROUPS, SESSIONS, 'zzzz'));
    expect(items).toEqual([]);
  });

  test('rows are ordered by their order field', () => {
    const groups = [group('g', 'G')];
    const sessions = [
      session('s2', 'second', 'g'),
      session('s1', 'first', 'g'),
    ];
    sessions[0].order = 2;
    sessions[1].order = 1;
    const items = buildNavItems(groups, sessions, computeGroupFilter(groups, sessions, ''));
    expect(items.map(i => i.id)).toEqual(['g', 's1', 's2']);
  });
});

describe('computeGroupFilter — activeOnly (#149)', () => {
  test('with no query, hides groups whose sessions are all stopped', () => {
    const groups = [group('a', 'Alpha'), group('b', 'Beta')];
    const sessions = [
      session('s1', 'x', 'a', 'working'),
      session('s2', 'y', 'b', 'stopped'),
    ];
    const r = computeGroupFilter(groups, sessions, '', true);
    expect(r.active).toBe(true);
    expect([...r.visibleGroupIds]).toEqual(['a']);
    expect([...r.visibleSessionIds]).toEqual(['s1']);
  });

  test('error counts as active', () => {
    const r = computeGroupFilter([group('a', 'Alpha')], [session('s1', 'x', 'a', 'error')], '', true);
    expect(r.visibleSessionIds.has('s1')).toBe(true);
    expect(r.visibleGroupIds.has('a')).toBe(true);
  });

  test('every non-stopped state counts as active', () => {
    const groups = [group('a', 'Alpha')];
    for (const st of ['idle', 'working', 'waiting', 'error'] as const) {
      const r = computeGroupFilter(groups, [session('s', 'x', 'a', st)], '', true);
      expect(r.visibleSessionIds.has('s')).toBe(true);
    }
    const stopped = computeGroupFilter(groups, [session('s', 'x', 'a', 'stopped')], '', true);
    expect(stopped.visibleSessionIds.size).toBe(0);
  });

  test('an active sub-group keeps its parent visible', () => {
    const groups = [group('a', 'Alpha'), group('a1', 'Child', 'a')];
    const sessions = [session('s1', 'x', 'a1', 'waiting')];
    const r = computeGroupFilter(groups, sessions, '', true);
    expect([...r.visibleGroupIds].sort()).toEqual(['a', 'a1']);
  });

  test('a stopped sub-group under an active parent is hidden', () => {
    const groups = [group('a', 'Alpha'), group('a1', 'Child', 'a'), group('a2', 'Other', 'a')];
    const sessions = [
      session('s1', 'x', 'a1', 'working'),
      session('s2', 'y', 'a2', 'stopped'),
    ];
    const r = computeGroupFilter(groups, sessions, '', true);
    expect([...r.visibleGroupIds].sort()).toEqual(['a', 'a1']);
    expect([...r.visibleSessionIds]).toEqual(['s1']);
  });

  test('activeOnly + text is AND: only active sessions matching text', () => {
    const groups = [group('a', 'Alpha')];
    const sessions = [
      session('s1', 'login', 'a', 'working'),
      session('s2', 'login', 'a', 'stopped'),
      session('s3', 'logout', 'a', 'working'),
    ];
    const r = computeGroupFilter(groups, sessions, 'login', true);
    expect([...r.visibleSessionIds]).toEqual(['s1']);
    expect([...r.visibleGroupIds]).toEqual(['a']);
  });

  test('name-matched group with only stopped sessions is hidden when activeOnly', () => {
    const r = computeGroupFilter([group('a', 'Alpha')], [session('s1', 'x', 'a', 'stopped')], 'alpha', true);
    expect(r.visibleGroupIds.size).toBe(0);
    expect(r.visibleSessionIds.size).toBe(0);
  });

  test('name-matched group reveals its active sessions when activeOnly', () => {
    const groups = [group('a', 'Alpha')];
    const sessions = [session('s1', 'x', 'a', 'idle'), session('s2', 'y', 'a', 'stopped')];
    const r = computeGroupFilter(groups, sessions, 'alpha', true);
    expect([...r.visibleGroupIds]).toEqual(['a']);
    expect([...r.visibleSessionIds]).toEqual(['s1']);
  });

  test('activeOnly off leaves the result identical to a plain text filter', () => {
    const groups = [group('a', 'Alpha'), group('a1', 'Child', 'a')];
    const sessions = [session('s1', 'x', 'a', 'stopped'), session('s2', 'y', 'a1', 'stopped')];
    const withFlag = computeGroupFilter(groups, sessions, 'alpha', false);
    const plain = computeGroupFilter(groups, sessions, 'alpha');
    expect([...withFlag.visibleGroupIds].sort()).toEqual([...plain.visibleGroupIds].sort());
    expect([...withFlag.visibleSessionIds].sort()).toEqual([...plain.visibleSessionIds].sort());
  });

  test('empty query and activeOnly off is inactive', () => {
    const r = computeGroupFilter([group('a', 'Alpha')], [], '', false);
    expect(r.active).toBe(false);
    expect(r.visibleGroupIds.size).toBe(0);
  });
});
