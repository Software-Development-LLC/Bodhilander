import { useState, useCallback, useEffect } from 'react';
import { Group, GLOBAL_CONTEXT_GROUP_ID } from '../../shared/types';

const DEFAULT_COLORS = ['#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2'];

/**
 * Filter out system-managed groups that should never appear in the UI
 * (BDHLNDR-35). The `__global__` group is required by the memory system's
 * global-context injection but must stay hidden from the sidebar, pickers,
 * and context menus. MemoryPanel references it directly via the constant,
 * not through this store.
 */
function visibleGroups(all: Group[]): Group[] {
  return all.filter(g => g.id !== GLOBAL_CONTEXT_GROUP_ID);
}

export function useGroups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  // Load groups from database on mount
  useEffect(() => {
    const loadGroups = async () => {
      try {
        const dbGroups = await window.electronAPI.getAllGroups();
        setGroups(visibleGroups(dbGroups));
      } catch (error) {
        console.error('Failed to load groups:', error);
      } finally {
        setLoading(false);
      }
    };
    loadGroups();
  }, []);

  const createGroup = useCallback(async (name: string, parentId?: string): Promise<Group> => {
    return new Promise((resolve, reject) => {
      setGroups(prev => {
        const parentGroup = parentId ? prev.find(g => g.id === parentId) : null;
        const order = parentId
          ? prev.filter(g => g.parentId === parentId).length
          : prev.filter(g => !g.parentId).length;

        const group: Group = {
          id: crypto.randomUUID(),
          name,
          color: parentGroup?.color || DEFAULT_COLORS[prev.filter(g => !g.parentId).length % DEFAULT_COLORS.length],
          workingDir: parentGroup?.workingDir || '',
          order,
          createdAt: new Date(),
          parentId: parentId || null,
          collapsed: false,
          claudeAccountId: parentGroup?.claudeAccountId ?? null,
        };

        window.electronAPI.createGroup(group)
          .then(() => resolve(group))
          .catch((error) => {
            console.error('Failed to create group:', error);
            setGroups(current => current.filter(g => g.id !== group.id));
            reject(error);
          });

        return [...prev, group];
      });
    });
  }, []);

  const updateGroup = useCallback(async (id: string, updates: Partial<Group>) => {
    try {
      await window.electronAPI.updateGroup(id, updates);
      setGroups(prev => prev.map(g =>
        g.id === id ? { ...g, ...updates } : g
      ));
    } catch (error) {
      console.error('Failed to update group:', error);
      // Don't update state - DB failed
    }
  }, []);

  const removeGroup = useCallback(async (id: string) => {
    try {
      await window.electronAPI.deleteGroup(id);
      setGroups(prev => prev.filter(g => g.id !== id));
    } catch (error) {
      console.error('Failed to remove group:', error);
      // Don't update state - DB failed
    }
  }, []);

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

  const toggleCollapse = useCallback(async (groupId: string) => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    const newCollapsed = !group.collapsed;
    setGroups(prev => prev.map(g =>
      g.id === groupId ? { ...g, collapsed: newCollapsed } : g
    ));

    try {
      await window.electronAPI.updateGroup(groupId, { collapsed: newCollapsed });
    } catch (error) {
      console.error('Failed to toggle collapse:', error);
      // Rollback
      setGroups(prev => prev.map(g =>
        g.id === groupId ? { ...g, collapsed: !newCollapsed } : g
      ));
    }
  }, [groups]);

  const getTopLevelGroups = useCallback(() => {
    return groups.filter(g => !g.parentId).sort((a, b) => a.order - b.order);
  }, [groups]);

  const getSubGroups = useCallback((parentId: string) => {
    return groups.filter(g => g.parentId === parentId).sort((a, b) => a.order - b.order);
  }, [groups]);

  const getEffectiveWorkingDir = useCallback((groupId: string): string => {
    const group = groups.find(g => g.id === groupId);
    if (!group) return '';
    if (group.workingDir) return group.workingDir;
    if (group.parentId) {
      const parent = groups.find(g => g.id === group.parentId);
      return parent?.workingDir || '';
    }
    return '';
  }, [groups]);

  return {
    groups,
    loading,
    createGroup,
    updateGroup,
    removeGroup,
    reorderGroup,
    toggleCollapse,
    getTopLevelGroups,
    getSubGroups,
    getEffectiveWorkingDir,
  };
}
