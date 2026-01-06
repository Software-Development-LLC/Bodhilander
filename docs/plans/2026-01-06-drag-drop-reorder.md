# Drag and Drop Reorder Fix - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix broken drag/drop reordering for groups and sessions so users can reorder items by dragging.

**Architecture:** Fix the `reorderGroup` function to only reorder siblings (same `parentId`), fix `handleGroupDrop` to calculate indices within siblings, and fix session drag events by preventing child elements from blocking drag initiation.

**Tech Stack:** React, TypeScript, Electron, HTML5 Drag and Drop API

**Design Document:** `docs/designs/2026-01-06-drag-drop-reorder-design.md`

---

## Task 1: Fix `reorderGroup` in groups.ts

**Files:**
- Modify: `src/renderer/store/groups.ts:79-104`

**Context:** The current `reorderGroup` treats all groups as a flat list and assigns sequential order values to every group, breaking hierarchical ordering. We need to only reorder groups with the same `parentId`.

**Step 1: Read the current implementation**

Verify the current code at `src/renderer/store/groups.ts:79-104`.

**Step 2: Replace `reorderGroup` function**

Replace the entire `reorderGroup` function with:

```typescript
const reorderGroup = useCallback(async (groupId: string, newOrder: number) => {
  setGroups(prev => {
    const group = prev.find(g => g.id === groupId);
    if (!group) return prev;

    // Only get siblings (same parentId) excluding the moved group
    const siblings = prev
      .filter(g => g.parentId === group.parentId && g.id !== groupId)
      .sort((a, b) => a.order - b.order);

    // Insert at new position among siblings only
    siblings.splice(newOrder, 0, group);

    // Update orders for siblings only
    const reorderedSiblings = siblings.map((g, idx) => ({
      ...g,
      order: idx,
    }));

    // Merge: keep non-siblings unchanged, replace siblings with reordered
    const nonSiblings = prev.filter(g => g.parentId !== group.parentId);
    const result = [...nonSiblings, ...reorderedSiblings];

    // Persist only the affected siblings
    reorderedSiblings.forEach(g => {
      window.electronAPI.updateGroup(g.id, { order: g.order })
        .catch(err => console.error('Failed to update group order:', err));
    });

    return result;
  });
}, []);
```

**Step 3: Verify TypeScript compiles**

Run: `npm run build:main`
Expected: No errors

**Step 4: Commit**

```bash
git add src/renderer/store/groups.ts
git commit -m "fix(groups): reorderGroup now respects parentId hierarchy

Only reorders groups with the same parentId instead of treating
all groups as a flat list. Fixes corrupted order values.

Part of #15"
```

---

## Task 2: Fix `handleGroupDrop` in App.tsx

**Files:**
- Modify: `src/renderer/App.tsx:325-338`

**Context:** The current `handleGroupDrop` calculates indices from the full groups array. It needs to filter by `parentId` and prevent cross-hierarchy drops.

**Step 1: Read the current implementation**

Verify the current code at `src/renderer/App.tsx:325-338`.

**Step 2: Replace `handleGroupDrop` function**

Replace the entire `handleGroupDrop` function with:

```typescript
const handleGroupDrop = (e: React.DragEvent, targetGroupId: string) => {
  e.preventDefault();
  if (!draggedItem || draggedItem.type !== 'group' || !dropTarget) return;

  const draggedGroup = groups.find(g => g.id === draggedItem.id);
  const targetGroup = groups.find(g => g.id === targetGroupId);
  if (!draggedGroup || !targetGroup) return;

  // Only allow reorder within same parent (same hierarchy level)
  if (draggedGroup.parentId !== targetGroup.parentId) return;

  // Get siblings sorted by order
  const siblings = groups
    .filter(g => g.parentId === targetGroup.parentId)
    .sort((a, b) => a.order - b.order);

  const targetIndex = siblings.findIndex(g => g.id === targetGroupId);
  let newOrder = dropTarget.position === 'before' ? targetIndex : targetIndex + 1;

  // Adjust if moving down within the list
  const currentIndex = siblings.findIndex(g => g.id === draggedItem.id);
  if (currentIndex < newOrder) newOrder--;

  reorderGroup(draggedItem.id, newOrder);
  handleDragEnd();
};
```

**Step 3: Verify TypeScript compiles**

Run: `npm run build`
Expected: No errors

**Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "fix(dnd): handleGroupDrop calculates index within siblings

Prevents cross-hierarchy drops and calculates position relative
to sibling groups only.

Part of #15"
```

---

## Task 3: Fix session drag start handler

**Files:**
- Modify: `src/renderer/App.tsx:279-283`

**Context:** Session drag events may be blocked by child interactive elements. Add a guard to prevent drag on buttons/inputs.

**Step 1: Read the current implementation**

Verify the current code at `src/renderer/App.tsx:279-283`.

**Step 2: Replace `handleSessionDragStart` function**

Replace the entire `handleSessionDragStart` function with:

```typescript
const handleSessionDragStart = (e: React.DragEvent, sessionId: string, groupId: string) => {
  // Prevent drag initiation from interactive child elements
  const target = e.target as HTMLElement;
  if (target.tagName === 'BUTTON' || target.tagName === 'INPUT' || target.tagName === 'SPAN') {
    e.preventDefault();
    return;
  }

  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', sessionId);
  setDraggedItem({ type: 'session', id: sessionId, groupId });
};
```

**Step 3: Verify TypeScript compiles**

Run: `npm run build`
Expected: No errors

**Step 4: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "fix(dnd): guard session drag start from interactive elements

Prevents buttons and inputs from blocking drag initiation.

Part of #15"
```

---

## Task 4: Add `draggable="false"` to session child elements

**Files:**
- Modify: `src/renderer/App.tsx` (session rendering, approximately lines 778-830)

**Context:** Child elements inside the session div should not be draggable to prevent them from interfering with the parent's drag behavior.

**Step 1: Find session close button**

Locate the session close button (around line 824-829) and add `draggable={false}`:

```typescript
<button
  className="session-close"
  draggable={false}
  onClick={(e) => {
    e.stopPropagation();
    handleRemoveSession(session.id);
  }}
  title="Remove session"
>
  ×
</button>
```

**Step 2: Find status pill span**

Locate the status pill span (around line 823) and add `draggable={false}`:

```typescript
<span
  className={`status-pill ${session.state}`}
  draggable={false}
>
  {session.state}
</span>
```

**Step 3: Find share indicator span (if present)**

Locate the share indicator (around line 820-822) and add `draggable={false}`:

```typescript
{sharingSessions.has(session.id) && (
  <span className="share-indicator" draggable={false} title="Sharing">⇄</span>
)}
```

**Step 4: Verify TypeScript compiles**

Run: `npm run build`
Expected: No errors

**Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "fix(dnd): prevent child elements from capturing session drag

Adds draggable=false to buttons and spans inside session items.

Part of #15"
```

---

## Task 5: Manual testing

**Context:** No automated tests exist for this project. Verify the fixes work correctly.

**Step 1: Start the development server**

Run: `npm run dev`

**Step 2: Test group reordering**

1. Create 3 top-level groups: A, B, C
2. Drag group A after group C
3. Verify order becomes: B, C, A
4. Drag group C before group B
5. Verify order becomes: C, B, A
6. Restart the app and verify order persists

**Step 3: Test subgroup reordering**

1. Create a subgroup under group C: C1
2. Create another subgroup under group C: C2
3. Drag C2 before C1
4. Verify order becomes: C2, C1
5. Restart and verify persistence

**Step 4: Test session reordering within group**

1. Create 3 sessions in group C: S1, S2, S3
2. Drag S1 after S3
3. Verify order becomes: S2, S3, S1
4. Restart and verify persistence

**Step 5: Test session moving between groups**

1. Drag session S2 from group C to group B
2. Verify S2 now appears in group B
3. Restart and verify persistence

**Step 6: Test button clicks still work**

1. Click on a session close button (×)
2. Verify the session is removed (not dragged)
3. Click on a status pill
4. Verify nothing happens (no drag initiated)

**Step 7: Commit test verification**

If all tests pass:
```bash
git commit --allow-empty -m "test: manually verified drag/drop reordering

Verified:
- Top-level group reordering
- Subgroup reordering within parent
- Session reordering within group
- Session moving between groups
- Child button clicks unaffected
- Order persists after restart

Closes #15"
```

---

## Task 6: Final build and PR preparation

**Step 1: Full build**

Run: `npm run build`
Expected: No errors

**Step 2: Push branch**

```bash
git push -u origin feature/issue-15-drag-drop-reorder
```

**Step 3: Create PR**

Use `superpowers:finishing-a-development-branch` skill to create PR and handle cleanup.

---

## Summary

| Task | Description | Estimated Effort |
|------|-------------|------------------|
| 1 | Fix `reorderGroup` hierarchy | Small |
| 2 | Fix `handleGroupDrop` siblings | Small |
| 3 | Guard session drag start | Small |
| 4 | Add `draggable={false}` | Small |
| 5 | Manual testing | Medium |
| 6 | Build and PR | Small |
