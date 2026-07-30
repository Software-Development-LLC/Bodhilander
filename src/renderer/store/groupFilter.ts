import { Group, Session } from '../../shared/types';

/**
 * Result of applying the sidebar filter (#141).
 *
 * `visibleGroupIds` covers both top-level groups and sub-groups; the renderer
 * only ever asks "should this row render?", so one set serves both levels.
 */
export interface GroupFilterResult {
  /** False when the query is empty/whitespace — callers render everything. */
  active: boolean;
  visibleGroupIds: Set<string>;
  visibleSessionIds: Set<string>;
}

/**
 * Decide which groups, sub-groups and sessions survive the sidebar filters.
 *
 * Two orthogonal narrowings, combined as AND:
 *  - Text query (#141): a group matched by name reveals its whole subtree; a
 *    matching sub-group or session keeps its ancestors visible as context.
 *  - `activeOnly` (#149): a session counts only when `state !== 'stopped'`, and
 *    a group survives only if its subtree holds at least one such session. A
 *    name-matched-but-all-stopped group is therefore hidden while it is on.
 *
 * With `activeOnly` false the output is identical to the pure text filter.
 * Pure and total: no I/O, no mutation of the inputs.
 */
export function computeGroupFilter(
  groups: Group[],
  sessions: Session[],
  rawQuery: string,
  activeOnly = false,
): GroupFilterResult {
  const visibleGroupIds = new Set<string>();
  const visibleSessionIds = new Set<string>();

  const query = rawQuery.trim().toLowerCase();
  const qActive = query !== '';
  if (!qActive && !activeOnly) {
    return { active: false, visibleGroupIds, visibleSessionIds };
  }

  const byId = new Map(groups.map(g => [g.id, g]));

  const nameMatches = (name: string) => name.toLowerCase().includes(query);
  const isActive = (s: Session) => s.state !== 'stopped';

  // True when `start` lies in the subtree of a name-matched group (itself or an
  // ancestor name-matches) — the "a name match reveals its whole subtree" rule.
  // The `seen` guard also stops a malformed parentId cycle.
  const chainMatchesInclusive = (start: Group | undefined): boolean => {
    const seen = new Set<string>();
    let cur = start;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (nameMatches(cur.name)) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
  };

  /** Reveal a group and its ancestors as context (their children untouched). */
  const revealAncestry = (groupId: string | null | undefined) => {
    const seen = new Set<string>();
    let cur = groupId ? byId.get(groupId) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      visibleGroupIds.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  };

  // Pass 1 — session visibility, intersecting the text and active filters.
  for (const s of sessions) {
    if (activeOnly && !isActive(s)) continue;
    const textOK = !qActive || nameMatches(s.name) || chainMatchesInclusive(byId.get(s.groupId));
    if (!textOK) continue;
    visibleSessionIds.add(s.id);
    revealAncestry(s.groupId);
  }

  // Pass 2 — a name-matched group (or one under a name-matched group) is
  // revealed even with no visible session, but only when we are NOT requiring
  // active sessions. This preserves #141's "empty matched group still shows".
  if (qActive && !activeOnly) {
    for (const g of groups) {
      if (!chainMatchesInclusive(g)) continue;
      visibleGroupIds.add(g.id);
      revealAncestry(g.parentId);
    }
  }

  return { active: true, visibleGroupIds, visibleSessionIds };
}

export interface NavItem {
  id: string;
  type: 'group' | 'session';
  parentId?: string;
}

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;

/**
 * Flat top-to-bottom list of the sidebar rows that are actually rendered.
 *
 * Keyboard navigation walks this list, so it must mirror the render pass
 * exactly: rows hidden by the filter are excluded, and a collapsed group is
 * treated as expanded while the filter is active (matching the view-only
 * auto-expand). Otherwise arrow keys land on invisible rows, or skip rows the
 * user can plainly see.
 */
export function buildNavItems(
  groups: Group[],
  sessions: Session[],
  filter: GroupFilterResult,
): NavItem[] {
  const items: NavItem[] = [];

  const groupVisible = (g: Group) => !filter.active || filter.visibleGroupIds.has(g.id);
  const sessionVisible = (s: Session) => !filter.active || filter.visibleSessionIds.has(s.id);
  const expanded = (g: Group) => filter.active || !g.collapsed;

  const sessionsOf = (groupId: string) =>
    sessions.filter(s => s.groupId === groupId && sessionVisible(s)).sort(byOrder);

  const subGroupsOf = (parentId: string) =>
    groups.filter(g => g.parentId === parentId && groupVisible(g)).sort(byOrder);

  const topLevel = groups.filter(g => !g.parentId && groupVisible(g)).sort(byOrder);

  for (const group of topLevel) {
    items.push({ id: group.id, type: 'group' });
    if (!expanded(group)) continue;

    for (const s of sessionsOf(group.id)) {
      items.push({ id: s.id, type: 'session', parentId: group.id });
    }

    for (const subGroup of subGroupsOf(group.id)) {
      items.push({ id: subGroup.id, type: 'group', parentId: group.id });
      if (!expanded(subGroup)) continue;
      for (const s of sessionsOf(subGroup.id)) {
        items.push({ id: s.id, type: 'session', parentId: subGroup.id });
      }
    }
  }

  return items;
}
