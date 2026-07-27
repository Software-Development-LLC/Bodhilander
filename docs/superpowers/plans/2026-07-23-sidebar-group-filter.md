# Sidebar Group/Session Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a text filter box at the top of the sidebar that instantly narrows the visible groups, sub-groups, and sessions as the user types.

**Architecture:** All matching logic lives in one pure, unit-tested module (`src/renderer/store/groupFilter.ts`) that takes the flat `groups` and `sessions` arrays plus a query string and returns two id sets — which groups render and which sessions render. `App.tsx` calls it inside a `useMemo` and applies the sets as `.filter(...)` guards on the three existing render lists. No IPC, no DB, no new state beyond one ephemeral `useState` string.

**Tech Stack:** TypeScript, React 18, Electron renderer, `bun:test` for unit tests, plain CSS in `src/renderer/styles/global.css`.

## Global Constraints

- Tests are written with `bun:test` (`import { describe, expect, test } from 'bun:test'`) and run with `bun test <path>`. There is no jest config and no `npm test` script.
- Test files live in a `__tests__/` directory next to the code, named `<module>.test.ts`, and open with a docblock stating the run command (match `src/renderer/components/__tests__/arenaRounds.test.ts`).
- Types come from `src/shared/types.ts`: `Group` has `id`, `name`, `parentId: string \| null`, `collapsed: boolean`; `Session` has `id`, `name`, `groupId: string`.
- The sidebar tree is exactly two levels: top-level group → sub-group. Sessions attach to either via `groupId`.
- Matching is case-insensitive plain substring (`String.includes`). No fuzzy matching, no regex.
- Filtering must never write to the persisted `collapsed` flag — auto-expand is view-only.
- CSS is dark-theme, hand-written, appended to `src/renderer/styles/global.css` near the existing `.sidebar-header` rules (line ~166). Palette in use: background `#252526`, borders `#3c3c3c`/`#555`, muted text `#888`, accent `#5a7aff`.
- Branch: `feature/141-sidebar-group-filter`. Every commit references issue #141.

---

### Task 1: Pure filter module + unit tests

**Files:**
- Create: `src/renderer/store/groupFilter.ts`
- Test: `src/renderer/store/__tests__/groupFilter.test.ts`

**Interfaces:**
- Consumes: `Group` and `Session` from `src/shared/types.ts`.
- Produces:
  ```ts
  export interface GroupFilterResult {
    active: boolean;
    visibleGroupIds: Set<string>;
    visibleSessionIds: Set<string>;
  }
  export function computeGroupFilter(
    groups: Group[],
    sessions: Session[],
    rawQuery: string,
  ): GroupFilterResult;
  ```
  Task 2 consumes exactly these three fields.

**Design note — why only two sets:** the design doc floated a third set, `fullyMatchedGroupIds`. It is unnecessary: when a group matches by name, the module already walks its subtree and puts every descendant session id into `visibleSessionIds`. The renderer therefore only ever asks "is this group id visible?" and "is this session id visible?". Dropping the third set (YAGNI) keeps the API at two questions.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/store/__tests__/groupFilter.test.ts`:

```ts
/**
 * Sidebar group/session filter tests (BDHLNDR #141).
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
//   api        (top)  -> sessions: s-api
//     api-auth (sub)  -> sessions: s-login
//     api-bill (sub)  -> sessions: s-invoice
//   web        (top)  -> sessions: s-home
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/renderer/store/__tests__/groupFilter.test.ts`
Expected: FAIL — module `../groupFilter` cannot be resolved.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/store/groupFilter.ts`:

```ts
import { Group, Session } from '../../shared/types';

/**
 * Result of applying the sidebar filter (BDHLNDR #141).
 *
 * `visibleGroupIds` covers both top-level groups and sub-groups; the renderer
 * asks only "should this row render?", so one set serves both levels.
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

  /** Reveal a group and its ancestors as context (children untouched). */
  const revealAncestry = (groupId: string | null | undefined) => {
    let current = groupId ? byId.get(groupId) : undefined;
    while (current) {
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/renderer/store/__tests__/groupFilter.test.ts`
Expected: PASS — 11 pass, 0 fail.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors introduced by `groupFilter.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/groupFilter.ts src/renderer/store/__tests__/groupFilter.test.ts
git commit -m "feat(sidebar): pure group/session filter module (#141)"
```

---

### Task 2: Wire the filter into the sidebar

**Files:**
- Modify: `src/renderer/App.tsx` (imports; new state + memo; filter input JSX under `.sidebar-header` ~line 946; top-level group map ~line 948; direct-session map ~line 1057; sub-group map ~line 1143; sub-group session map; the two `!group.collapsed` / `!subGroup.collapsed` guards)
- Modify: `src/renderer/styles/global.css` (append filter styles after the `.sidebar-header-actions` block, ~line 176)

**Interfaces:**
- Consumes: `computeGroupFilter` and `GroupFilterResult` from Task 1 — `{ active, visibleGroupIds, visibleSessionIds }`.
- Produces: no exported API; UI only.

- [ ] **Step 1: Import the module**

In `src/renderer/App.tsx`, after `import { useGroups } from './store/groups';`, add:

```ts
import { computeGroupFilter } from './store/groupFilter';
```

- [ ] **Step 2: Add filter state and the memoized result**

Next to the other sidebar state (near `const [sidebarWidth, setSidebarWidth] = useState(260);`), add:

```ts
const [filterText, setFilterText] = useState('');
const filterInputRef = useRef<HTMLInputElement>(null);
const filter = useMemo(
  () => computeGroupFilter(groups, sessions, filterText),
  [groups, sessions, filterText],
);
```

- [ ] **Step 3: Render the filter input**

Immediately after the closing `</div>` of `.sidebar-header` (line ~946, before the `{getTopLevelGroups().map(...)}` block), insert:

```tsx
<div className="sidebar-filter">
  <input
    ref={filterInputRef}
    className="sidebar-filter-input"
    type="text"
    value={filterText}
    placeholder="Filter groups & sessions…"
    aria-label="Filter groups and sessions"
    onChange={(e) => setFilterText(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setFilterText('');
      }
    }}
  />
  {filterText && (
    <button
      className="sidebar-filter-clear"
      onClick={() => {
        setFilterText('');
        filterInputRef.current?.focus();
      }}
      title="Clear filter"
      aria-label="Clear filter"
    >
      ×
    </button>
  )}
</div>
```

- [ ] **Step 4: Filter the top-level group list**

Change the opening of the group map (line ~948) from:

```tsx
{getTopLevelGroups().map(group => (
```

to:

```tsx
{getTopLevelGroups()
  .filter(group => !filter.active || filter.visibleGroupIds.has(group.id))
  .map(group => (
```

Close the extra paren: the map's closing `))}` becomes `))}` on the same expression — verify the JSX still balances after the edit (the block ends with `))}` after the sub-group map).

- [ ] **Step 5: Filter the sub-group list and auto-expand**

Change (line ~1143):

```tsx
{!group.collapsed && getSubGroups(group.id).map(subGroup => (
```

to:

```tsx
{(filter.active || !group.collapsed) && getSubGroups(group.id)
  .filter(subGroup => filter.visibleGroupIds.has(subGroup.id) || !filter.active)
  .map(subGroup => (
```

And change the direct-sessions guard (line ~1051) from:

```tsx
{!group.collapsed && (
```

to:

```tsx
{(filter.active || !group.collapsed) && (
```

Apply the same `(filter.active || !subGroup.collapsed)` change to the sub-group's own sessions guard.

- [ ] **Step 6: Filter the session lists**

For the top-level group's sessions (line ~1057), change:

```tsx
{getSessionsByGroup(group.id).sort((a, b) => a.order - b.order).map(session => (
```

to:

```tsx
{getSessionsByGroup(group.id)
  .filter(session => !filter.active || filter.visibleSessionIds.has(session.id))
  .sort((a, b) => a.order - b.order).map(session => (
```

Apply the identical change to the sub-group's session list (`getSessionsByGroup(subGroup.id)`).

- [ ] **Step 7: Add the empty state**

Directly after the top-level group map block closes, add:

```tsx
{filter.active && filter.visibleGroupIds.size === 0 && (
  <div className="sidebar-filter-empty">No groups or sessions match</div>
)}
```

- [ ] **Step 8: Add the CSS**

Append to `src/renderer/styles/global.css` after the `.sidebar-header-actions` rule:

```css
.sidebar-filter {
  position: relative;
  margin-bottom: 10px;
}

.sidebar-filter-input {
  width: 100%;
  box-sizing: border-box;
  background: #1e1e1e;
  border: 1px solid #3c3c3c;
  border-radius: 3px;
  color: #ddd;
  font-family: inherit;
  font-size: 12px;
  padding: 5px 22px 5px 8px;
}

.sidebar-filter-input::placeholder {
  color: #666;
}

.sidebar-filter-input:focus {
  outline: none;
  border-color: #5a7aff;
}

.sidebar-filter-clear {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: #888;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 3px;
}

.sidebar-filter-clear:hover {
  color: #ddd;
}

.sidebar-filter-empty {
  color: #666;
  font-size: 12px;
  font-style: italic;
  padding: 8px 2px;
}
```

- [ ] **Step 9: Typecheck and run the full test suite**

Run: `bunx tsc --noEmit -p tsconfig.json && bun test src/renderer`
Expected: no type errors; all tests pass.

- [ ] **Step 10: Build the renderer to confirm the JSX compiles**

Run: `bun run build:renderer`
Expected: webpack completes without errors.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/App.tsx src/renderer/styles/global.css
git commit -m "feat(sidebar): filter box for groups, sub-groups and sessions (#141)"
```

---

## Verification

Manual check with `bun run dev`:
1. Sidebar shows the filter box under the "Groups" header; the list is unchanged while it's empty.
2. Typing a top-level group name shows that group with all its sub-groups and sessions.
3. Typing a sub-group name shows the sub-group plus its parent, with sibling sub-groups hidden.
4. Typing a session name shows just that session under its group (and sub-group).
5. A collapsed group auto-expands while filtering; clearing the filter restores it collapsed.
6. Gibberish shows "No groups or sessions match".
7. The × button and Escape both clear the filter.
