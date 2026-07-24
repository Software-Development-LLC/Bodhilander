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
 * Decide which groups, sub-groups and sessions survive a text filter.
 *
 * Rules:
 *  - A group matched by name reveals its entire subtree (sub-groups + sessions).
 *  - A matching sub-group or session keeps its ancestors visible as context,
 *    without revealing that ancestor's other children.
 *  - Anything with no match in its subtree is omitted.
 *
 * Pure and total: no I/O, no mutation of the inputs.
 */
export function computeGroupFilter(
  groups: Group[],
  sessions: Session[],
  rawQuery: string,
): GroupFilterResult {
  const visibleGroupIds = new Set<string>();
  const visibleSessionIds = new Set<string>();

  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return { active: false, visibleGroupIds, visibleSessionIds };
  }

  const byId = new Map(groups.map(g => [g.id, g]));

  const childrenOf = new Map<string, Group[]>();
  for (const g of groups) {
    if (!g.parentId) continue;
    const siblings = childrenOf.get(g.parentId);
    if (siblings) siblings.push(g);
    else childrenOf.set(g.parentId, [g]);
  }

  const sessionsOf = new Map<string, Session[]>();
  for (const s of sessions) {
    const existing = sessionsOf.get(s.groupId);
    if (existing) existing.push(s);
    else sessionsOf.set(s.groupId, [s]);
  }

  const matches = (name: string) => name.toLowerCase().includes(query);

  // Guards against re-walking a subtree, and against infinite recursion if a
  // malformed parentId ever produced a cycle.
  const revealed = new Set<string>();

  /** Reveal a matched group and everything beneath it. */
  const revealSubtree = (group: Group) => {
    if (revealed.has(group.id)) return;
    revealed.add(group.id);
    visibleGroupIds.add(group.id);
    for (const s of sessionsOf.get(group.id) ?? []) visibleSessionIds.add(s.id);
    for (const child of childrenOf.get(group.id) ?? []) revealSubtree(child);
  };

  /** Reveal a group and its ancestors as context (their children untouched). */
  const revealAncestry = (groupId: string | null | undefined) => {
    const seen = new Set<string>();
    let current = groupId ? byId.get(groupId) : undefined;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      visibleGroupIds.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  };

  for (const group of groups) {
    if (!matches(group.name)) continue;
    revealSubtree(group);
    revealAncestry(group.parentId);
  }

  for (const s of sessions) {
    if (!matches(s.name)) continue;
    visibleSessionIds.add(s.id);
    revealAncestry(s.groupId);
  }

  return { active: true, visibleGroupIds, visibleSessionIds };
}
