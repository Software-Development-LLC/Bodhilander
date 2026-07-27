# Sidebar Group/Session Filter — Design

**Issue:** [#141](https://github.com/Software-Development-LLC/Bodhilander/issues/141)
**Date:** 2026-07-23

## Problem

The sidebar renders top-level **groups**, each with one level of nested **sub-groups**, and **sessions** inside groups and sub-groups. Users with many groups/sub-groups have to scroll and visually hunt for what they want. There is no way to narrow the list.

## Goal

Add a text filter box at the top of the sidebar that instantly narrows the visible groups, sub-groups, and sessions as the user types.

## Scope

**In scope:** filtering which group / sub-group / session rows render in the sidebar; the filter input UI; auto-expanding collapsed groups while filtering; an empty-state message.

**Out of scope (unchanged):** drag-and-drop reordering, keyboard navigation (Ctrl+Q sidebar focus, arrow nav, etc.), and the memory / analytics / arena panels. The filter only affects which rows render.

## UI

A single-line text input placed at the top of the sidebar, directly under the `sidebar-header` (the "Groups" title + action buttons row) and above the group list.

- Placeholder: `Filter groups & sessions…`
- A clear (`×`) button appears at the right edge of the input only when it contains text; clicking it empties the filter and returns focus to the input.
- Pressing **Escape** while the input is focused clears it.
- The filter value is **ephemeral** React state — it starts empty on every launch and is never persisted.
- An empty filter renders the normal, fully unfiltered sidebar (identical to today's behavior).

## Filtering logic

The matching logic lives in a new pure, unit-tested module so `App.tsx` only consumes a result object.

### Module: `src/renderer/store/groupFilter.ts`

```ts
export interface GroupFilterResult {
  active: boolean;                 // true when query is non-empty after trim
  visibleGroupIds: Set<string>;    // groups + sub-groups that should render
  visibleSessionIds: Set<string>;  // sessions that should render
}

export function computeGroupFilter(
  groups: Group[],
  sessions: Session[],
  rawQuery: string,
): GroupFilterResult;
```

Two sets are sufficient. A third "fully matched" set is unnecessary because when a
group matches by name the module already walks its subtree and adds every
descendant session id to `visibleSessionIds` — so the renderer only ever asks
"is this group visible?" and "is this session visible?".

### Definitions

Let `q = rawQuery.trim().toLowerCase()`.

- If `q === ''` → `active: false`; all sets empty. Callers treat `active === false` as "show everything" and skip filtering entirely.
- `groupMatches(g)  = g.name.toLowerCase().includes(q)`
- `sessionMatches(s) = s.name.toLowerCase().includes(q)`

Matching is a plain case-insensitive substring test (no fuzzy matching, no regex).

### Rules (when `active`)

The tree is exactly two levels deep: top-level group → sub-group → session (sessions also attach directly to top-level groups). `groups` is a flat list where sub-groups carry `parentId`; sessions carry a `groupId` that may point at either a top-level group or a sub-group.

1. **A group/sub-group matched by name is "fully matched"** — it and its entire subtree render. Every descendant group + session id is added to the visible sets. This covers: a matched top-level group reveals all its sub-groups and all sessions beneath it; a matched sub-group reveals all its sessions.

2. **A matching session makes its ancestry visible** — the session id → `visibleSessionIds`; its owning group and (if that group is a sub-group) the sub-group's parent → `visibleGroupIds`.

3. **A matching sub-group (by name) makes its parent visible** — parent top-level group id → `visibleGroupIds` (rule 1 already added the sub-group and its sessions).

4. **Everything else is hidden** — a group/sub-group whose subtree contains no name match and no session match is absent from `visibleGroupIds`; a session that neither matches nor lives under a fully-matched group is absent from `visibleSessionIds`.

Consequently, within a group that is visible only because a child matched (i.e. it was not itself name-matched), only its matching sessions render — exactly the intent that a non-name-matched group shows only its matching sessions.

## App.tsx integration

1. Add `const [filterText, setFilterText] = useState('')`.
2. `const filter = useMemo(() => computeGroupFilter(groups, sessions, filterText), [groups, sessions, filterText])`.
3. Render the filter input in the sidebar (below `sidebar-header`).
4. In the render pipeline:
   - **Top-level groups:** when `filter.active`, render only groups whose id ∈ `filter.visibleGroupIds`.
   - **Sub-groups:** when `filter.active`, render only sub-groups whose id ∈ `filter.visibleGroupIds`.
   - **Sessions:** when `filter.active`, render only sessions whose id ∈ `filter.visibleSessionIds`. (Applies to both the direct-sessions list of a top-level group and the sessions list of a sub-group.)
   - **Auto-expand:** the two `!group.collapsed` / `!subGroup.collapsed` guards become `(filter.active || !group.collapsed)`. This is view-only — no call to `toggleCollapse` / `updateGroup`, so the persisted `collapsed` flag is never written by filtering. Clearing the filter restores each group's real collapse state.
5. **Empty state:** when `filter.active` and `filter.visibleGroupIds.size === 0`, render a muted line (e.g. `No groups or sessions match`) in place of the group list.

The existing helpers `getTopLevelGroups()` and `getSubGroups(parentId)` already return correctly ordered lists; filtering is applied as a `.filter(...)` on top of them at render time, preserving order.

## Error handling

Filtering is pure and total over in-memory arrays — there is no I/O and nothing to fail. A malformed/empty query simply yields `active: false`. No new IPC, no DB writes.

## Testing

Unit tests for `computeGroupFilter` in `src/renderer/store/__tests__/groupFilter.test.ts` (`bun:test`, matching the existing `__tests__` convention; run with `bun test`):

- Empty / whitespace-only query → `active: false`, empty sets.
- Case-insensitive substring match on a top-level group name → group fully matched, all sub-groups + sessions visible.
- Match on a sub-group name → sub-group fully matched (its sessions visible) **and** parent top-level group visible, but sibling sub-groups hidden.
- Match on a session name (in a top-level group) → that session + its group visible; sibling sessions hidden; group not fully matched.
- Match on a session name inside a sub-group → session + sub-group + parent group all visible; group/sub-group not fully matched.
- No matches anywhere → `active: true`, all sets empty (drives the empty-state UI).
- A group matched by name whose sub-group/session names do **not** match → still shows all descendants (fully-matched precedence).

## Rollout

Single PR to `development`, closing #141. No migration, no settings, no channel/version implications.
