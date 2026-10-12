# Active-Sessions Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** A persisted sidebar toggle that hides every group without an active session, combining with the text filter as AND.

**Architecture:** Extend the pure `computeGroupFilter` with a fourth `activeOnly` param; `App.tsx` holds a persisted `showActiveOnly` state and passes it through. The toggle button lives inside `SidebarFilter`.

## Global Constraints

- `bun:test`; test files in `__tests__/` next to code; run `bun test <path>`.
- `Session.state: 'idle' | 'working' | 'waiting' | 'error' | 'stopped'`. Active = `!== 'stopped'`.
- Preferences: `window.electronAPI.getPreference(key): Promise<string|null>` / `setPreference(key, value): Promise<void>`. Key `sidebar.showActiveOnly`, `'true'`/`'false'`.
- Toggle off ⇒ `computeGroupFilter` output identical to today (all existing tests stay green).
- Branch `feature/149-active-sessions-toggle`; every commit references #149.

---

### Task 1: Extend `computeGroupFilter` with `activeOnly`

**Files:**
- Modify: `src/renderer/store/groupFilter.ts`
- Test: `src/renderer/store/__tests__/groupFilter.test.ts`

**Interfaces:**
- Produces: `computeGroupFilter(groups, sessions, rawQuery, activeOnly = false)`; `GroupFilterResult.active` becomes `qActive || activeOnly`.

- [ ] **Step 1: Add failing tests** — append an `describe('computeGroupFilter — activeOnly', ...)` block:

```ts
// helper `session(id, name, groupId, state = 'idle')` — extend the existing factory
// with a state arg defaulting to 'idle'.
test('activeOnly with no query hides groups whose sessions are all stopped', () => {
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
  const groups = [group('a', 'Alpha')];
  const sessions = [session('s1', 'x', 'a', 'error')];
  const r = computeGroupFilter(groups, sessions, '', true);
  expect(r.visibleSessionIds.has('s1')).toBe(true);
});

test('an active sub-group keeps its parent visible', () => {
  const groups = [group('a', 'Alpha'), group('a1', 'Child', 'a')];
  const sessions = [session('s1', 'x', 'a1', 'waiting')];
  const r = computeGroupFilter(groups, sessions, '', true);
  expect([...r.visibleGroupIds].sort()).toEqual(['a', 'a1']);
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
});

test('name-matched group with only stopped sessions is hidden when activeOnly', () => {
  const groups = [group('a', 'Alpha')];
  const sessions = [session('s1', 'x', 'a', 'stopped')];
  const r = computeGroupFilter(groups, sessions, 'alpha', true);
  expect(r.visibleGroupIds.size).toBe(0);
  expect(r.visibleSessionIds.size).toBe(0);
});

test('name-matched group reveals its active sessions when activeOnly', () => {
  const groups = [group('a', 'Alpha')];
  const sessions = [
    session('s1', 'x', 'a', 'idle'),
    session('s2', 'y', 'a', 'stopped'),
  ];
  const r = computeGroupFilter(groups, sessions, 'alpha', true);
  expect([...r.visibleGroupIds]).toEqual(['a']);
  expect([...r.visibleSessionIds]).toEqual(['s1']);
});

test('activeOnly off leaves the result identical to a plain text filter', () => {
  const groups = [group('a', 'Alpha')];
  const sessions = [session('s1', 'x', 'a', 'stopped')];
  const withFlag = computeGroupFilter(groups, sessions, 'alpha', false);
  const plain = computeGroupFilter(groups, sessions, 'alpha');
  expect([...withFlag.visibleGroupIds]).toEqual([...plain.visibleGroupIds]);
  expect([...withFlag.visibleSessionIds]).toEqual([...plain.visibleSessionIds]);
});

test('empty query and activeOnly off is inactive', () => {
  const r = computeGroupFilter([group('a', 'Alpha')], [], '', false);
  expect(r.active).toBe(false);
});
```

Also update the existing `session()` factory to accept an optional `state` arg (default `'idle'`), leaving all current call sites unchanged.

- [ ] **Step 2: Run — expect FAIL** (`activeOnly` param not yet honored).

Run: `bun test src/renderer/store/__tests__/groupFilter.test.ts`

- [ ] **Step 3: Implement.** Replace the body of `computeGroupFilter`:

```ts
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

  const childrenOf = new Map<string, Group[]>();
  for (const g of groups) {
    if (!g.parentId) continue;
    (childrenOf.get(g.parentId) ?? childrenOf.set(g.parentId, []).get(g.parentId)!).push(g);
  }

  const sessionsOf = new Map<string, Session[]>();
  for (const s of sessions) {
    (sessionsOf.get(s.groupId) ?? sessionsOf.set(s.groupId, []).get(s.groupId)!).push(s);
  }

  const nameMatches = (name: string) => name.toLowerCase().includes(query);
  const isActive = (s: Session) => s.state !== 'stopped';

  // True when g lies in the subtree of a name-matched group (g itself or any
  // ancestor name-matches) — the "a name match reveals its whole subtree" rule.
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

  const revealAncestry = (groupId: string | null | undefined) => {
    const seen = new Set<string>();
    let cur = groupId ? byId.get(groupId) : undefined;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      visibleGroupIds.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  };

  // Pass 1: session visibility.
  for (const s of sessions) {
    if (activeOnly && !isActive(s)) continue;
    const g = byId.get(s.groupId);
    const textOK = !qActive || nameMatches(s.name) || chainMatchesInclusive(g);
    if (!textOK) continue;
    visibleSessionIds.add(s.id);
    revealAncestry(s.groupId);
  }

  // Pass 2: groups revealed by a name match even when they have no visible
  // session — preserved only when NOT requiring active sessions.
  if (qActive && !activeOnly) {
    for (const g of groups) {
      if (chainMatchesInclusive(g)) {
        visibleGroupIds.add(g.id);
        revealAncestry(g.parentId);
      }
    }
  }

  return { active: true, visibleGroupIds, visibleSessionIds };
}
```

Note: the `childrenOf` map is retained only if used elsewhere; if `buildNavItems` is the sole consumer of subtree structure, the local `childrenOf` here can be dropped. Keep the implementation minimal — remove any binding this function no longer reads (the two-pass form above does not need `childrenOf`; delete it to avoid an unused-var lint).

- [ ] **Step 4: Run — expect PASS** (new + all existing `groupFilter` tests).

Run: `bun test src/renderer/store/__tests__/groupFilter.test.ts`

- [ ] **Step 5: Typecheck.** `bunx tsc --noEmit -p tsconfig.json` (ignore pre-existing errors, if any).

- [ ] **Step 6: Commit.**

```bash
git add src/renderer/store/groupFilter.ts src/renderer/store/__tests__/groupFilter.test.ts
git commit -m "feat(sidebar): activeOnly narrowing in the pure filter module (#149)"
```

---

### Task 2: Toggle button in `SidebarFilter`

**Files:**
- Modify: `src/renderer/components/SidebarFilter.tsx`
- Modify: `src/renderer/styles/global.css`
- Test: `src/renderer/components/__tests__/SidebarFilter.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SidebarFilter` gains `activeOnly: boolean` and `onActiveOnlyChange: (v: boolean) => void` props.

- [ ] **Step 1: Add failing tests** to `SidebarFilter.test.tsx` (the `Harness` must thread the new props; default them in the harness):

```ts
test('the active-only toggle reflects its state via aria-pressed', () => {
  render(<Harness activeOnly={false} />);
  expect(screen.getByLabelText('Show only groups with active sessions').getAttribute('aria-pressed')).toBe('false');
});

test('clicking the toggle flips it', () => {
  const seen: boolean[] = [];
  render(<Harness activeOnly={false} onActiveOnlyChange={(v) => seen.push(v)} />);
  fireEvent.click(screen.getByLabelText('Show only groups with active sessions'));
  expect(seen).toEqual([true]);
});
```

Update `Harness` to own `activeOnly` state (like it owns `value`) and pass `activeOnly` / `onActiveOnlyChange` to `SidebarFilter`, defaulting `activeOnly` to the prop and `onActiveOnlyChange` to a state setter so the aria-pressed test can also assert the flipped DOM if desired.

- [ ] **Step 2: Run — expect FAIL.**

Run: `bun test src/renderer/components/__tests__/SidebarFilter.test.tsx`

- [ ] **Step 3: Implement.** Add the props and render the button as the first child of `.sidebar-filter`, before `.sidebar-filter-field`:

```tsx
interface SidebarFilterProps {
  value: string;
  onChange: (value: string) => void;
  activeOnly: boolean;
  onActiveOnlyChange: (value: boolean) => void;
}

export const SidebarFilter: React.FC<SidebarFilterProps> = ({
  value, onChange, activeOnly, onActiveOnlyChange,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="sidebar-filter">
      <button
        type="button"
        className={`sidebar-filter-toggle ${activeOnly ? 'active' : ''}`}
        aria-pressed={activeOnly}
        title="Show only groups with active sessions"
        aria-label="Show only groups with active sessions"
        onClick={() => onActiveOnlyChange(!activeOnly)}
      >
        ⚡
      </button>
      <div className="sidebar-filter-field">
        {/* …existing input + clear button unchanged… */}
      </div>
    </div>
  );
};
```

- [ ] **Step 4: CSS.** In `global.css`, make `.sidebar-filter` a flex row and style the toggle:

```css
.sidebar-filter {
  /* existing sticky rules stay; add: */
  display: flex;
  align-items: stretch;
  gap: 6px;
}
.sidebar-filter-field { flex: 1; }

.sidebar-filter-toggle {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  background: #1e1e1e;
  border: 1px solid #3c3c3c;
  border-radius: 3px;
  color: #888;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}
.sidebar-filter-toggle:hover { color: #ddd; }
.sidebar-filter-toggle.active {
  color: #e5c07b;
  border-color: #5a7aff;
  background: #2a2d3a;
}
.sidebar-filter-toggle:focus-visible {
  outline: 1px solid #5a7aff;
  outline-offset: -1px;
}
```

Confirm `.sidebar-filter-field` still has `position: relative` (the clear button anchors to it) — it does; keep it.

- [ ] **Step 5: Run — expect PASS.**

Run: `bun test src/renderer/components/__tests__/SidebarFilter.test.tsx`

- [ ] **Step 6: Commit.**

```bash
git add src/renderer/components/SidebarFilter.tsx src/renderer/styles/global.css src/renderer/components/__tests__/SidebarFilter.test.tsx
git commit -m "feat(sidebar): active-only toggle button in the filter row (#149)"
```

---

### Task 3: Wire persistence and filtering into `App.tsx`

**Files:**
- Modify: `src/renderer/App.tsx`

**Interfaces:**
- Consumes: Task 1's 4-arg `computeGroupFilter`; Task 2's `SidebarFilter` props.

- [ ] **Step 1: State + load.** Near `const [filterText, setFilterText] = useState('')`:

```tsx
const [showActiveOnly, setShowActiveOnly] = useState(false);

useEffect(() => {
  window.electronAPI.getPreference('sidebar.showActiveOnly')
    .then(v => { if (v === 'true') setShowActiveOnly(true); })
    .catch(() => { /* preference unavailable — stay off */ });
}, []);

const handleActiveOnlyChange = useCallback((next: boolean) => {
  setShowActiveOnly(next);
  window.electronAPI.setPreference('sidebar.showActiveOnly', String(next))
    .catch(err => console.error('Failed to persist showActiveOnly:', err));
}, []);
```

- [ ] **Step 2: Thread into the filter memo.**

```tsx
const filter = useMemo(
  () => computeGroupFilter(groups, sessions, filterText, showActiveOnly),
  [groups, sessions, filterText, showActiveOnly],
);
```

- [ ] **Step 3: Pass props to the component.**

```tsx
<SidebarFilter
  value={filterText}
  onChange={setFilterText}
  activeOnly={showActiveOnly}
  onActiveOnlyChange={handleActiveOnlyChange}
/>
```

- [ ] **Step 4: Adapt the empty state.**

```tsx
{filter.active && visibleTopLevelGroups.length === 0 && (
  <output className="sidebar-filter-empty">
    {showActiveOnly && !filterText.trim()
      ? 'No groups have active sessions'
      : 'No groups or sessions match'}
  </output>
)}
```

- [ ] **Step 5: Typecheck + full renderer suite + build.**

```bash
bunx tsc --noEmit -p tsconfig.json
bun test src/renderer
bun run build:renderer
```

Expected: no new type errors; all tests pass; webpack compiles.

- [ ] **Step 6: Commit.**

```bash
git add src/renderer/App.tsx
git commit -m "feat(sidebar): persist and apply the active-only toggle (#149)"
```

---

## Verification

Manual (`bun run dev`): toggle hides groups with no non-stopped session; stopping the last active session in a group drops it live; toggle + text narrows to active AND matching; state survives a restart; clearing shows the adaptive empty message; keyboard nav walks only visible rows.
