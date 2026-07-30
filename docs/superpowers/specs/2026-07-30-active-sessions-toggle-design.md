# Sidebar "Show only active" Toggle — Design

**Issue:** [#149](https://github.com/Software-Development-LLC/Bodhilander/issues/149)
**Date:** 2026-07-30

## Problem

Users with many groups want to collapse the sidebar down to just what is live. The text filter (#141) narrows by name; this adds an orthogonal narrowing by session activity.

## Definition

A session is **active** when `state !== 'stopped'`. All of `idle`, `working`, `waiting`, and `error` count as active — an errored session is a live pane the user likely wants to see. Only `stopped` is inactive.

A group (top-level or sub-group) is **active** when it, or any descendant in its subtree, has at least one active session.

## Scope

**In scope:** a persisted toggle in the sidebar; extending the pure filter module so it narrows by activity, combined with the text query as AND; the empty-state wording.

**Out of scope (unchanged):** drag-drop, keyboard navigation, the text filter's own matching, and every panel.

## UI

An icon toggle button sits inline to the **left of the filter input**, on the `.sidebar-filter` row, so the two filter controls read as one cluster:

`[⚡ toggle] [ Filter groups & sessions… ]`

- Pressed/active visual state when on (accent border + background), `aria-pressed={showActiveOnly}`, `title`/`aria-label` "Show only groups with active sessions".
- Clicking flips the state and persists it.

## Persistence

Stored via the existing preferences API (`window.electronAPI.getPreference` / `setPreference`, SQLite-backed — the same mechanism as the update channel):

- Key: `sidebar.showActiveOnly`, value `'true'` / `'false'`.
- Loaded once on mount; default **off** when unset.
- Async read means the sidebar briefly renders unfiltered on launch before the stored value applies. Acceptable and consistent with how the update-channel setting loads.

## Filter logic

`computeGroupFilter` gains a fourth parameter and the result reports both flags:

```ts
export interface GroupFilterResult {
  active: boolean;                 // query non-empty OR activeOnly — callers use this to gate filtering + auto-expand
  visibleGroupIds: Set<string>;
  visibleSessionIds: Set<string>;
}

export function computeGroupFilter(
  groups: Group[],
  sessions: Session[],
  rawQuery: string,
  activeOnly = false,
): GroupFilterResult;
```

Let `q = rawQuery.trim().toLowerCase()`, `qActive = q !== ''`.

- If `!qActive && !activeOnly` → `active: false`, empty sets (callers render everything, exactly as today).
- `isActive(s) = s.state !== 'stopped'`.
- `nameMatches(name) = name.toLowerCase().includes(q)`.
- `chainMatchesInclusive(g)` = `nameMatches(g.name)` OR any ancestor of `g` name-matches — i.e. `g` lies in the subtree of a name-matched group. This is what the current `revealSubtree` expresses (a name-matched group reveals its whole subtree).

**Session visibility** (`visibleSessionIds`):

```
for each session s (g = its group):
  if activeOnly && !isActive(s): hidden
  else if !qActive:              visible          # active-only mode: every active session shows
  else if nameMatches(s.name) || chainMatchesInclusive(g): visible
  else:                          hidden
```

**Group visibility** (`visibleGroupIds`, both levels):

```
group g is visible if:
  its subtree contains a visible session, OR
  (qActive && !activeOnly && chainMatchesInclusive(g))   # preserves today's "name-matched (or under a name-matched) group shows even when empty"
then: every ancestor of a visible group is also visible (context)
```

The `!activeOnly` guard on the second clause is the AND: with the toggle on, a name-matched group whose subtree has no active session is hidden. With the toggle off, behavior is byte-identical to #141 (verified by keeping every existing `groupFilter` test green).

**Faithfulness check** (worked in tests):
- toggle off → identical to current text filter, including empty name-matched groups and empty sub-groups under a name-matched parent still showing.
- parent name-matches, child has one active + one stopped session, toggle on → parent + child visible, only the active session renders.
- parent name-matches, all descendant sessions stopped, toggle on → hidden.

`buildNavItems` is unchanged: it already derives rows from `visibleGroupIds` / `visibleSessionIds` and treats a collapsed group as expanded while `active`, so it follows the combined result automatically.

## App.tsx integration

1. `const [showActiveOnly, setShowActiveOnly] = useState(false)`; load from `getPreference('sidebar.showActiveOnly')` in a mount effect; on toggle, set state and `setPreference(...)`.
2. `filter = useMemo(() => computeGroupFilter(groups, sessions, filterText, showActiveOnly), [groups, sessions, filterText, showActiveOnly])`.
3. `visibleTopLevelGroups` and the auto-expand (`filter.active || !group.collapsed`) are unchanged — they already key off `filter.active`, which now also reflects the toggle.
4. Render the toggle button in the `.sidebar-filter` row, left of the input.
5. Empty state adapts: when `filter.active` and nothing renders — "No groups have active sessions" if `showActiveOnly && !filterText.trim()`, otherwise the existing "No groups or sessions match".

## Reactivity

Sessions are already reactive; the `filter` memo depends on `sessions`, so the view updates live — a session stopping drops its group out if it was the last active one, and starting one brings the group back. That is the feature's point.

The selected session (`activeSessionId`) can be filtered out of the sidebar while still open in the terminal — same as the text filter today. No special handling.

## Testing

- **`groupFilter.test.ts`** (bun): existing tests stay green (toggle defaults off). New cases: active-only with no query; active-only + text AND; descendant counting across sub-groups; name-matched group intersected with active-only (all-stopped subtree hidden); `error` counts as active; `stopped` excluded; empty query + toggle off returns inactive.
- **DOM test** for the toggle button: renders with correct `aria-pressed`, flips on click, invokes the persist callback. (Persistence itself — the `getPreference`/`setPreference` round trip — is exercised via a mocked `electronAPI` in the button's harness, matching the `SidebarFilter` test style.)

## Rollout

Single PR to `development`, closing #149. No schema change (preferences table already exists), no version/channel implications.
