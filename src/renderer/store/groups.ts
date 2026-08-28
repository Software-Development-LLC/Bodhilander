import { useState, useCallback, useEffect } from 'react';
import { AccountSwitchResult, Group } from '../../shared/types';

const DEFAULT_COLORS = ['#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2'];

/*
 * There is deliberately no "hide system groups" filter here any more.
 *
 * The removed memory system seeded a '__global__' group for global-context
 * injection, and this store used to filter it out of the sidebar. But that row
 * was an ordinary, visible drop target from v2.2.2 until the filter landed in
 * v3.2.9, so upgrading installs can have real sessions parked in it — and a
 * filter here would hide those sessions from their owner.
 *
 * dropLegacyMemoryTables() in src/main/database.ts now settles it at the source
 * before the renderer ever asks for groups: the row is deleted when empty, and
 * kept and renamed to "Recovered Sessions" when it still holds sessions. Either
 * way, whatever comes back from the database is meant to be shown.
 */

export function useGroups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  // Load groups from database on mount
  useEffect(() => {
    const loadGroups = async () => {
      try {
        const dbGroups = await window.electronAPI.getAllGroups();
        setGroups(dbGroups);
      } catch (error) {
        console.error('Failed to load groups:', error);
      } finally {
        setLoading(false);
      }
    };
    loadGroups();
    // Reload when a group is created remotely (relay / mobile).
    const cleanupRefresh = window.electronAPI.onGroupsRefresh(() => { loadGroups(); });
    return () => cleanupRefresh();
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

  /**
   * Reassign a group's Claude account (BDHLNDR-31). Returns the sessions that
   * inherited the change and therefore need a pty restart — see
   * useSessions().setSessionAccount for why the plain updateGroup path isn't
   * enough.
   */
  const setGroupAccount = useCallback(async (
    id: string,
    accountId: string | null,
  ): Promise<AccountSwitchResult | null> => {
    try {
      const result = await window.electronAPI.assignAccountToGroup(id, accountId);
      setGroups(prev => prev.map(g =>
        g.id === id ? { ...g, claudeAccountId: accountId } : g
      ));
      return result;
    } catch (error) {
      console.error('Failed to assign account to group:', error);
      return null; // See useSessions().setSessionAccount for why not an empty result.
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
    setGroupAccount,
    removeGroup,
    reorderGroup,
    toggleCollapse,
    getTopLevelGroups,
    getSubGroups,
    getEffectiveWorkingDir,
  };
}
