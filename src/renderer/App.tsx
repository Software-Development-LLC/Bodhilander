import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import Terminal from './components/Terminal';
import TerminalHeader from './components/TerminalHeader';
import ContextMenu, { MenuItem } from './components/ContextMenu';
import { NamePromptModal } from './components/NamePromptModal';
import { SettingsModal } from './components/SettingsModal';
import { NewItemChoice } from './components/NewItemChoice';
import { MemoryPanel } from './components/panels/MemoryPanel';
import AnalyticsPanel from './components/panels/AnalyticsPanel';
import { ArenaPanel } from './components/ArenaPanel';
import { SessionStatsBadge } from './components/SessionStatsBadge';
import { ClaudeAccountsModal } from './components/ClaudeAccountsModal';
import { ClaudeAccount, PROVIDER_LABELS } from '../shared/types';
import { useSessions } from './store/sessions';
import { useGroups } from './store/groups';
import { computeGroupFilter, buildNavItems } from './store/groupFilter';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import './styles/global.css';
import './styles/context-menu.css';
import ErrorBoundary from './components/ErrorBoundary';

const App: React.FC = () => {
  const {
    groups,
    loading: groupsLoading,
    createGroup,
    updateGroup,
    removeGroup,
    reorderGroup,
    toggleCollapse,
    getTopLevelGroups,
    getSubGroups,
    getEffectiveWorkingDir,
  } = useGroups();
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState('');
  const [colorPickerGroupId, setColorPickerGroupId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const [draggedItem, setDraggedItem] = useState<{
    type: 'group' | 'session';
    id: string;
    groupId?: string;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    type: 'group' | 'session';
    id: string;
    position: 'before' | 'after';
  } | null>(null);

  // Focus tracking state for keyboard navigation
  const [sidebarFocused, setSidebarFocused] = useState(false);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [focusedItemType, setFocusedItemType] = useState<'group' | 'session' | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(260);

  // Sidebar text filter (#141). Ephemeral — never persisted.
  const [filterText, setFilterText] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [claudeAccountsOpen, setClaudeAccountsOpen] = useState(false);
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeAccount[]>([]);
  // True when the running build is itself a beta (version contains -beta.).
  // Shows a BETA pill in the sidebar so opt-in testers know what they're on
  // (BDHLNDR-32).
  const [isBetaBuild, setIsBetaBuild] = useState(false);

  // Restart keys for each session (increment to trigger restart)
  const [restartKeys, setRestartKeys] = useState<Record<string, number>>({});

  // Name prompt state
  const [sessionPrompt, setSessionPrompt] = useState<{ groupId: string; defaultName: string } | null>(null);
  const [groupPrompt, setGroupPrompt] = useState<{ defaultName: string } | null>(null);
  const [subGroupPrompt, setSubGroupPrompt] = useState<{ parentId: string; defaultName: string } | null>(null);

  // New item choice menu state (for + button on groups)
  const [newItemChoice, setNewItemChoice] = useState<{ x: number; y: number; groupId: string } | null>(null);

  // Memory panel state
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);

  // Analytics view state (BDHLNDR-18)
  const [analyticsViewOpen, setAnalyticsViewOpen] = useState(false);
  const [arenaViewOpen, setArenaViewOpen] = useState(false);
  // Group whose working dir the arena panel should scope to ("Ask Arena" menu).
  const [arenaGroupId, setArenaGroupId] = useState<string | null>(null);

  // Code search modal state

  // Destructive action confirmation state
  const [confirmAction, setConfirmAction] = useState<{
    type: 'closeSession' | 'deleteGroup';
    id: string;
    message: string;
  } | null>(null);

  const GROUP_COLORS = [
    '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2',
    '#ff6b6b', '#4ecdc4', '#ffe66d', '#95e1d3', '#f38181', '#aa96da',
  ];
  const {
    sessions,
    loading: sessionsLoading,
    activeSessionId,
    setActiveSessionId,
    createSession,
    updateSession,
    removeSession,
    getSessionsByGroup,
    getStateCounts,
    reorderSession,
  } = useSessions();

  const homedir = window.electronAPI.homedir;
  const counts = getStateCounts();
  const isLoading = groupsLoading || sessionsLoading;

  // Which sidebar rows survive the text filter (#141).
  const filter = useMemo(
    () => computeGroupFilter(groups, sessions, filterText),
    [groups, sessions, filterText],
  );

  // The top-level rows actually rendered. Drives both the list and the empty
  // state, so the two can never disagree.
  const visibleTopLevelGroups = useMemo(
    () => getTopLevelGroups().filter(g => !filter.active || filter.visibleGroupIds.has(g.id)),
    [getTopLevelGroups, filter],
  );

  // Get the active session's group ID for memory panel
  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeGroupId = activeSession?.groupId || null;

  // Resolve the effective Claude account for a session, applying the same
  // fallback chain the main process uses (session → group → default). Used by
  // the sidebar badge so the user can see which account a session will run
  // under at a glance (BDHLNDR-31).
  const effectiveAccountForSession = useCallback((sessionId: string): ClaudeAccount | null => {
    if (claudeAccounts.length === 0) return null;
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return null;
    const direct = session.claudeAccountId
      ? claudeAccounts.find(a => a.id === session.claudeAccountId)
      : null;
    if (direct) return direct;
    const group = groups.find(g => g.id === session.groupId);
    const inherited = group?.claudeAccountId
      ? claudeAccounts.find(a => a.id === group.claudeAccountId)
      : null;
    if (inherited) return inherited;
    return claudeAccounts.find(a => a.isDefault) ?? null;
  }, [sessions, groups, claudeAccounts]);

  // Dismiss color picker on Escape or click-outside
  useEffect(() => {
    if (!colorPickerGroupId) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setColorPickerGroupId(null);
    };

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.color-picker') && !target.closest('.group-color')) {
        setColorPickerGroupId(null);
      }
    };

    document.addEventListener('keydown', handleEscape);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [colorPickerGroupId]);

  // Claude accounts cache — kept in sync with main process so context menus
  // and creation dialogs can offer account pickers without refetching each time.
  useEffect(() => {
    let cancelled = false;
    const reload = async () => {
      try {
        const list = await window.electronAPI.listAccounts();
        if (!cancelled) setClaudeAccounts(list);
      } catch (err) {
        console.error('Failed to load Claude accounts:', err);
      }
    };
    reload();
    const offCompleted = window.electronAPI.onAccountLoginCompleted(() => reload());
    return () => {
      cancelled = true;
      offCompleted();
    };
  }, []);

  // Refresh accounts whenever the accounts modal closes (covers delete/rename).
  useEffect(() => {
    if (!claudeAccountsOpen) {
      window.electronAPI.listAccounts().then(setClaudeAccounts).catch(() => {});
    }
  }, [claudeAccountsOpen]);

  // Determine once at mount whether the running app build is a beta —
  // controls the BETA pill shown in the sidebar header (BDHLNDR-32).
  useEffect(() => {
    window.electronAPI
      .isPrereleaseBuild()
      .then(setIsBetaBuild)
      .catch(() => { /* leave default (false) on failure */ });
  }, []);


  // Show prompt for new session name
  const handleNewSession = useCallback((groupId: string) => {
    if (!groupId) {
      console.error('Cannot create session: no group available');
      return;
    }
    const count = getSessionsByGroup(groupId).length + 1;
    setSessionPrompt({ groupId, defaultName: `Session ${count}` });
  }, [getSessionsByGroup]);

  // Actually create the session after name is confirmed
  const handleConfirmSession = useCallback(async (
    name: string,
    _path?: string,
    _claudeAccountId?: string | null,
    provider?: string,
  ) => {
    if (!sessionPrompt) return;
    const cwd = getEffectiveWorkingDir(sessionPrompt.groupId) || homedir;
    await createSession(sessionPrompt.groupId, name, cwd, true, provider); // launchClaude = true
    setSessionPrompt(null);
    // A new/renamed row may not match the active filter; clearing it keeps the
    // result visible instead of silently vanishing (#141).
    setFilterText('');

  }, [sessionPrompt, getEffectiveWorkingDir, createSession, homedir]);

  // Show prompt for new group name
  const handleCreateGroup = () => {
    const count = groups.filter(g => !g.parentId).length + 1;
    setGroupPrompt({ defaultName: `Group ${count}` });
  };

  // Actually create the group after name is confirmed
  const handleConfirmGroup = async (name: string, path?: string, claudeAccountId?: string | null) => {
    setGroupPrompt(null);
    // A new/renamed row may not match the active filter; clearing it keeps the
    // result visible instead of silently vanishing (#141).
    setFilterText('');

    // Create the group first
    const newGroup = await createGroup(name);

    const updates: Partial<typeof newGroup> = {};
    if (path) updates.workingDir = path;
    if (claudeAccountId !== undefined) updates.claudeAccountId = claudeAccountId;
    if (Object.keys(updates).length > 0) {
      await updateGroup(newGroup.id, updates);
    }
  };

  // Show prompt for new sub-group name
  const handleCreateSubGroup = (parentId: string) => {
    const parent = groups.find(g => g.id === parentId);
    if (!parent || parent.parentId) return; // Can't create sub-group of sub-group

    const subGroups = getSubGroups(parentId);
    setSubGroupPrompt({ parentId, defaultName: `Sub-Group ${subGroups.length + 1}` });
  };

  // Actually create the sub-group after name is confirmed
  const handleConfirmSubGroup = async (name: string, path?: string, claudeAccountId?: string | null) => {
    if (!subGroupPrompt) return;
    const newGroup = await createGroup(name, subGroupPrompt.parentId);
    if (newGroup) {
      const updates: Partial<typeof newGroup> = {};
      if (path) updates.workingDir = path;
      if (claudeAccountId !== undefined) updates.claudeAccountId = claudeAccountId;
      if (Object.keys(updates).length > 0) {
        await updateGroup(newGroup.id, updates);
      }
    }
    setSubGroupPrompt(null);
    setFilterText('');
  };

  const handleStartEditGroup = (groupId: string, currentName: string) => {
    setEditingGroupId(groupId);
    setEditingGroupName(currentName);
  };

  const handleFinishEditGroup = async () => {
    if (editingGroupId && editingGroupName.trim()) {
      await updateGroup(editingGroupId, { name: editingGroupName.trim() });
      // The new name may not match the active filter (#141).
      setFilterText('');
    }
    setEditingGroupId(null);
    setEditingGroupName('');
  };

  const doDeleteGroup = useCallback(async (groupId: string) => {
    await removeGroup(groupId);
  }, [removeGroup]);

  const handleDeleteGroup = useCallback((groupId: string) => {
    const sessionsInGroup = getSessionsByGroup(groupId);
    if (sessionsInGroup.length > 0) {
      // Don't delete groups with active sessions
      return;
    }
    setConfirmAction({
      type: 'deleteGroup',
      id: groupId,
      message: 'Delete this group? This cannot be undone.',
    });
  }, [getSessionsByGroup]);

  const handleSetGroupDirectory = async (groupId: string) => {
    // Open the picker at the group's current working directory so it's
    // obvious which group we're editing (BDHLNDR-36). Falls through to the
    // OS default when the group has no wd set yet.
    const group = groups.find(g => g.id === groupId);
    const dir = await window.electronAPI.selectDirectory(group?.workingDir || undefined);
    if (dir) {
      await updateGroup(groupId, { workingDir: dir });
    }
  };

  const handleColorSelect = async (groupId: string, color: string) => {
    await updateGroup(groupId, { color });
    setColorPickerGroupId(null);
  };

  const handleSessionContextMenu = (e: React.MouseEvent, sessionId: string, sessionName: string) => {
    e.preventDefault();
    const session = sessions.find(s => s.id === sessionId);
    const currentAccountId = session?.claudeAccountId ?? null;

    const items: MenuItem[] = [
      { label: 'Rename', onClick: () => handleStartEditSession(sessionId, sessionName) },
    ];

    // Account-assignment items (BDHLNDR-31) — only shown when accounts are registered.
    if (claudeAccounts.length > 0) {
      items.push({ label: 'separator', onClick: () => {}, separator: true });
      items.push({
        label: `${currentAccountId === null ? '✓ ' : '   '}Inherit account from group`,
        onClick: () => updateSession(sessionId, { claudeAccountId: null }),
      });
      for (const acc of claudeAccounts) {
        const isCurrent = currentAccountId === acc.id;
        items.push({
          label: `${isCurrent ? '✓ ' : '   '}Use "${acc.label}"${acc.isDefault ? ' (default)' : ''}`,
          onClick: () => updateSession(sessionId, { claudeAccountId: acc.id }),
        });
      }
    }

    items.push({ label: 'separator', onClick: () => {}, separator: true });
    items.push({ label: 'Close Session', onClick: () => handleRemoveSession(sessionId), danger: true });

    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleGroupContextMenu = (e: React.MouseEvent, groupId: string, groupName: string) => {
    e.preventDefault();
    const sessionsInGroup = getSessionsByGroup(groupId);
    const group = groups.find(g => g.id === groupId);
    const currentAccountId = group?.claudeAccountId ?? null;

    const items: MenuItem[] = [
      { label: 'New Session', onClick: () => handleNewSession(groupId) },
      { label: 'Rename', onClick: () => handleStartEditGroup(groupId, groupName) },
      { label: 'Set Working Directory', onClick: () => handleSetGroupDirectory(groupId) },
      { label: 'New Sub-Group', onClick: () => handleCreateSubGroup(groupId), disabled: !!groups.find(g => g.id === groupId)?.parentId },
      {
        label: 'Ask Arena About This Folder',
        onClick: () => {
          setArenaGroupId(groupId);
          setArenaViewOpen(true);
        },
        // Arena scoping runs the CLIs inside the group's working dir.
        disabled: !group?.workingDir,
      },
    ];

    // Account-assignment items (BDHLNDR-31) — only shown when accounts are registered.
    if (claudeAccounts.length > 0) {
      items.push({ label: 'separator', onClick: () => {}, separator: true });
      items.push({
        label: `${currentAccountId === null ? '✓ ' : '   '}Use default account`,
        onClick: () => updateGroup(groupId, { claudeAccountId: null }),
      });
      for (const acc of claudeAccounts) {
        const isCurrent = currentAccountId === acc.id;
        items.push({
          label: `${isCurrent ? '✓ ' : '   '}Use "${acc.label}"${acc.isDefault ? ' (default)' : ''}`,
          onClick: () => updateGroup(groupId, { claudeAccountId: acc.id }),
        });
      }
    }

    items.push({ label: 'separator', onClick: () => {}, separator: true });
    items.push({
      label: 'Delete Group',
      onClick: () => handleDeleteGroup(groupId),
      danger: true,
      disabled: sessionsInGroup.length > 0,
    });

    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleStartEditSession = (sessionId: string, currentName: string) => {
    setEditingSessionId(sessionId);
    setEditingSessionName(currentName);
  };

  const handleFinishEditSession = async () => {
    if (editingSessionId && editingSessionName.trim()) {
      await updateSession(editingSessionId, { name: editingSessionName.trim() });
      // The new name may not match the active filter (#141).
      setFilterText('');
    }
    setEditingSessionId(null);
    setEditingSessionName('');
  };

  const doRemoveSession = useCallback(async (id: string) => {
    await removeSession(id);
  }, [removeSession]);

  const handleRemoveSession = useCallback((id: string) => {
    const session = sessions.find(s => s.id === id);
    if (session && (session.state === 'working' || session.state === 'waiting')) {
      setConfirmAction({
        type: 'closeSession',
        id,
        message: `This session is currently ${session.state}. Close it anyway?`,
      });
      return;
    }
    doRemoveSession(id);
  }, [sessions, doRemoveSession]);

  // Drag and drop handlers
  const handleGroupDragStart = (e: React.DragEvent, groupId: string) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `group:${groupId}`);
    setDraggedItem({ type: 'group', id: groupId });
  };

  const handleSessionDragStart = (e: React.DragEvent, sessionId: string, groupId: string) => {
    e.stopPropagation(); // Prevent group from capturing this drag

    // Only block drag from buttons and inputs (not spans - session name needs to be draggable)
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON' || target.tagName === 'INPUT') {
      e.preventDefault();
      return;
    }

    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `session:${sessionId}:${groupId}`);
    setDraggedItem({ type: 'session', id: sessionId, groupId });
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDropTarget(null);
  };

  const handleGroupDragOver = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent parent group from also handling this
    if (!draggedItem || draggedItem.type !== 'group') return;
    if (draggedItem.id === groupId) {
      setDropTarget(null); // Clear when hovering over self
      return;
    }

    // Only allow drop indicator for same hierarchy level (same parentId)
    const draggedGroup = groups.find(g => g.id === draggedItem.id);
    const targetGroup = groups.find(g => g.id === groupId);
    if (!draggedGroup || !targetGroup) {
      setDropTarget(null);
      return;
    }
    if (draggedGroup.parentId !== targetGroup.parentId) {
      setDropTarget(null); // Clear when hovering over different hierarchy level
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? 'before' : 'after';

    setDropTarget({ type: 'group', id: groupId, position });
  };

  const handleSessionDragOver = (e: React.DragEvent, sessionId: string, groupId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedItem || draggedItem.type !== 'session') return;
    if (draggedItem.id === sessionId) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? 'before' : 'after';

    setDropTarget({ type: 'session', id: sessionId, position });
  };

  const handleGroupAreaDragOver = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    if (!draggedItem || draggedItem.type !== 'session') return;

    // Allow dropping session into empty group or at end of group
    const sessionsInGroup = getSessionsByGroup(groupId);
    if (sessionsInGroup.length === 0 || draggedItem.groupId !== groupId) {
      setDropTarget({ type: 'session', id: `group:${groupId}`, position: 'after' });
    }
  };

  const handleGroupDrop = (e: React.DragEvent, targetGroupId: string) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent parent group from also handling this

    // Read from dataTransfer (race-condition safe on macOS)
    const data = e.dataTransfer.getData('text/plain');
    if (!data.startsWith('group:')) return;
    const draggedGroupId = data.replace('group:', '');

    // Still need dropTarget for position - fallback to 'after' if not set
    const position = dropTarget?.position || 'after';

    const draggedGroup = groups.find(g => g.id === draggedGroupId);
    const targetGroup = groups.find(g => g.id === targetGroupId);

    if (!draggedGroup || !targetGroup) return;

    // Only allow reorder within same parent (same hierarchy level)
    if (draggedGroup.parentId !== targetGroup.parentId) return;

    // Get siblings sorted by order
    const siblings = groups
      .filter(g => g.parentId === targetGroup.parentId)
      .sort((a, b) => a.order - b.order);

    const targetIndex = siblings.findIndex(g => g.id === targetGroupId);
    let newOrder = position === 'before' ? targetIndex : targetIndex + 1;

    // Adjust if moving down within the list
    const currentIndex = siblings.findIndex(g => g.id === draggedGroupId);
    if (currentIndex < newOrder) newOrder--;

    reorderGroup(draggedGroupId, newOrder);
    handleDragEnd();
  };

  const handleSessionDrop = (e: React.DragEvent, targetSessionId: string, targetGroupId: string) => {
    e.preventDefault();
    e.stopPropagation(); // BDHLNDR-48 (GH #42): without this the drop bubbles to
    // the parent .group-sessions handleGroupAreaDrop, which re-reorders the
    // session to the end of the list, overwriting the correct dropped position.

    // Read from dataTransfer (race-condition safe on macOS)
    const data = e.dataTransfer.getData('text/plain');
    if (!data.startsWith('session:')) return;
    const parts = data.split(':');
    const draggedSessionId = parts[1];
    const sourceGroupId = parts[2];

    // Still need dropTarget for position - fallback to 'after' if not set
    const position = dropTarget?.position || 'after';

    const targetGroupSessions = getSessionsByGroup(targetGroupId).sort((a, b) => a.order - b.order);
    const targetIndex = targetGroupSessions.findIndex(s => s.id === targetSessionId);
    let newOrder = position === 'before' ? targetIndex : targetIndex + 1;

    // Adjust if moving within same group and moving down
    if (sourceGroupId === targetGroupId) {
      const currentIndex = targetGroupSessions.findIndex(s => s.id === draggedSessionId);
      if (currentIndex < newOrder) newOrder--;
    }

    reorderSession(draggedSessionId, targetGroupId, newOrder);
    handleDragEnd();
  };

  const handleGroupAreaDrop = (e: React.DragEvent, targetGroupId: string) => {
    e.preventDefault();

    // Read from dataTransfer (race-condition safe on macOS)
    const data = e.dataTransfer.getData('text/plain');
    if (!data.startsWith('session:')) return;
    const parts = data.split(':');
    const draggedSessionId = parts[1];

    const targetGroupSessions = getSessionsByGroup(targetGroupId);
    reorderSession(draggedSessionId, targetGroupId, targetGroupSessions.length);
    handleDragEnd();
  };

  const handleNextSession = useCallback(() => {
    const currentIndex = sessions.findIndex(s => s.id === activeSessionId);
    const nextIndex = (currentIndex + 1) % sessions.length;
    if (sessions[nextIndex]) {
      const nextId = sessions[nextIndex].id;
      setActiveSessionId(nextId);
      setFocusedItemId(nextId);
      setFocusedItemType('session');
    }
  }, [sessions, activeSessionId, setActiveSessionId]);

  const handlePrevSession = useCallback(() => {
    const currentIndex = sessions.findIndex(s => s.id === activeSessionId);
    const prevIndex = currentIndex <= 0 ? sessions.length - 1 : currentIndex - 1;
    if (sessions[prevIndex]) {
      const prevId = sessions[prevIndex].id;
      setActiveSessionId(prevId);
      setFocusedItemId(prevId);
      setFocusedItemType('session');
    }
  }, [sessions, activeSessionId, setActiveSessionId]);

  const handleNextWaiting = useCallback(() => {
    const waitingSessions = sessions.filter(s => s.state === 'waiting');
    if (waitingSessions.length > 0) {
      const currentIndex = waitingSessions.findIndex(s => s.id === activeSessionId);
      const nextIndex = (currentIndex + 1) % waitingSessions.length;
      const nextId = waitingSessions[nextIndex].id;
      setActiveSessionId(nextId);
      setFocusedItemId(nextId);
      setFocusedItemType('session');
    }
  }, [sessions, activeSessionId, setActiveSessionId]);

  const handleCloseSession = useCallback(async () => {
    if (activeSessionId) {
      await handleRemoveSession(activeSessionId);
    }
  }, [activeSessionId, handleRemoveSession]);

  const handleKeyboardNewSession = useCallback(() => {
    if (groups[0]) {
      handleNewSession(groups[0].id);
    }
  }, [groups, handleNewSession]);

  // Flat navigation list for keyboard navigation. Mirrors the rendered rows,
  // so it must stay filter-aware (#141).
  const navItems = useMemo(
    () => buildNavItems(groups, sessions, filter),
    [groups, sessions, filter],
  );

  const handleFocusSidebar = useCallback(() => {
    sidebarRef.current?.focus();
    if (!focusedItemId && navItems.length > 0) {
      setFocusedItemId(navItems[0].id);
      setFocusedItemType(navItems[0].type);
    }
  }, [focusedItemId, navItems]);

  // Click handlers that also update focus state
  const handleSessionClick = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setFocusedItemId(sessionId);
    setFocusedItemType('session');
  }, [setActiveSessionId]);

  const handleGroupHeaderClick = useCallback((groupId: string) => {
    setFocusedItemId(groupId);
    setFocusedItemType('group');
  }, []);

  const handleNavigateUp = useCallback(() => {
    if (!sidebarFocused || navItems.length === 0) return;
    const currentIndex = navItems.findIndex(item => item.id === focusedItemId);
    const prevIndex = currentIndex > 0 ? currentIndex - 1 : navItems.length - 1;
    setFocusedItemId(navItems[prevIndex].id);
    setFocusedItemType(navItems[prevIndex].type);
  }, [sidebarFocused, focusedItemId, navItems]);

  const handleNavigateDown = useCallback(() => {
    if (!sidebarFocused || navItems.length === 0) return;
    const currentIndex = navItems.findIndex(item => item.id === focusedItemId);
    const nextIndex = currentIndex < navItems.length - 1 ? currentIndex + 1 : 0;
    setFocusedItemId(navItems[nextIndex].id);
    setFocusedItemType(navItems[nextIndex].type);
  }, [sidebarFocused, focusedItemId, navItems]);

  const handleCollapse = useCallback(() => {
    // Rows are force-expanded while filtering, so a collapse write would be an
    // invisible, persisted change (#141).
    if (!sidebarFocused || !focusedItemId || filter.active) return;
    if (focusedItemType === 'group') {
      const group = groups.find(g => g.id === focusedItemId);
      if (group && !group.collapsed) {
        toggleCollapse(focusedItemId);
      }
    } else if (focusedItemType === 'session') {
      const session = sessions.find(s => s.id === focusedItemId);
      if (session) {
        toggleCollapse(session.groupId);
      }
    }
  }, [sidebarFocused, focusedItemId, focusedItemType, groups, sessions, toggleCollapse, filter.active]);

  const handleExpand = useCallback(() => {
    if (!sidebarFocused || !focusedItemId) return;
    if (focusedItemType === 'group') {
      const group = groups.find(g => g.id === focusedItemId);
      if (group && group.collapsed && !filter.active) {
        toggleCollapse(focusedItemId);
      }
    } else if (focusedItemType === 'session') {
      // Right arrow on session = select it (same as Enter)
      setActiveSessionId(focusedItemId);
      setSidebarFocused(false);
      setTimeout(() => {
        window.dispatchEvent(new Event('focus-terminal'));
      }, 50);
    }
  }, [sidebarFocused, focusedItemId, focusedItemType, groups, toggleCollapse, setActiveSessionId, filter.active]);

  const handleSelect = useCallback(() => {
    if (!sidebarFocused || !focusedItemId) return;
    if (focusedItemType === 'group') {
      if (!filter.active) toggleCollapse(focusedItemId);
    } else if (focusedItemType === 'session') {
      setActiveSessionId(focusedItemId);
      setSidebarFocused(false);
      // Focus the terminal after a short delay to let it become visible
      setTimeout(() => {
        window.dispatchEvent(new Event('focus-terminal'));
      }, 50);
    }
  }, [sidebarFocused, focusedItemId, focusedItemType, toggleCollapse, setActiveSessionId, filter.active]);

  const handleNewGroup = useCallback(async () => {
    const name = `Group ${groups.filter(g => !g.parentId).length + 1}`;
    const newGroup = await createGroup(name);
    setFilterText('');

    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      await updateGroup(newGroup.id, { workingDir: dir });
    }
  }, [createGroup, updateGroup, groups]);

  const getContextShortcuts = useCallback(() => {
    if (sidebarFocused) {
      return [
        { key: '↑↓', label: 'Navigate' },
        { key: 'Enter', label: 'Select' },
        { key: '←→', label: 'Collapse' },
        { key: 'Ctrl+G', label: 'New Group' },
      ];
    }
    return [
      { key: 'Ctrl+Q', label: 'Sidebar' },
      { key: 'Ctrl+Tab', label: 'Next' },
      { key: 'Ctrl+W', label: 'Close' },
    ];
  }, [sidebarFocused]);

  const handleNewSubGroup = useCallback(async () => {
    if (focusedItemType === 'group' && focusedItemId) {
      const group = groups.find(g => g.id === focusedItemId);
      if (group && !group.parentId) {
        await handleCreateSubGroup(focusedItemId);
      }
    }
  }, [focusedItemType, focusedItemId, groups, handleCreateSubGroup]);


  const shortcutHandlers = useMemo(() => ({
    onNewSession: handleKeyboardNewSession,
    onNextSession: handleNextSession,
    onPrevSession: handlePrevSession,
    onNextWaiting: handleNextWaiting,
    onCloseSession: handleCloseSession,
    onFocusSidebar: handleFocusSidebar,
    onNewGroup: handleNewGroup,
    onNewSubGroup: handleNewSubGroup,
    onNavigateUp: handleNavigateUp,
    onNavigateDown: handleNavigateDown,
    onCollapse: handleCollapse,
    onExpand: handleExpand,
    onSelect: handleSelect,
    onToggleAnalytics: () => setAnalyticsViewOpen(prev => !prev),
  }), [handleKeyboardNewSession, handleNextSession, handlePrevSession, handleNextWaiting, handleCloseSession, handleFocusSidebar, handleNewGroup, handleNewSubGroup, handleNavigateUp, handleNavigateDown, handleCollapse, handleExpand, handleSelect]);

  useKeyboardShortcuts(shortcutHandlers);

  // Handle session selection from notifications/tray
  const handleSessionSelect = useCallback((sessionId: string) => {
    // Verify the session exists before selecting
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      setActiveSessionId(sessionId);
    }
  }, [sessions, setActiveSessionId]);

  // Listen for menu events and notification/tray selections
  useEffect(() => {
    const cleanups = [
      window.electronAPI.onMenuNewSession(handleKeyboardNewSession),
      window.electronAPI.onMenuCloseSession(handleCloseSession),
      window.electronAPI.onMenuNextSession(handleNextSession),
      window.electronAPI.onMenuPrevSession(handlePrevSession),
      window.electronAPI.onMenuNextWaiting(handleNextWaiting),
      window.electronAPI.onSessionSelect(handleSessionSelect),
    ];
    return () => cleanups.forEach(cleanup => cleanup());
  }, [handleKeyboardNewSession, handleCloseSession, handleNextSession, handlePrevSession, handleNextWaiting, handleSessionSelect]);

  // Listen for settings modal open event
  useEffect(() => {
    const unsubscribe = window.electronAPI.onOpenSettings(() => {
      setSettingsOpen(true);
    });
    return unsubscribe;
  }, []);

  // Sidebar resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.min(Math.max(180, e.clientX), 500);
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  if (isLoading) {
    return (
      <div className="app loading">
        <div className="loading-content">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app" style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
      <aside
        className={`sidebar ${sidebarFocused ? 'focused' : ''}`}
        ref={sidebarRef}
        tabIndex={0}
        aria-label="Session navigation"
        onFocus={() => setSidebarFocused(true)}
        onBlur={(e) => {
          // Only blur if focus moved outside sidebar
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setSidebarFocused(false);
          }
        }}
      >
        <div
          className={`sidebar-resize-handle ${isResizing ? 'resizing' : ''}`}
          onMouseDown={handleResizeStart}
        />
        <div className="sidebar-header">
          <h2>
            Groups
            {isBetaBuild && (
              <span
                className="beta-pill"
                title="You're running a beta build. Report issues on GitHub."
              >
                BETA
              </span>
            )}
          </h2>
          <div className="sidebar-header-actions">
            <button
              className={`icon-button ${memoryPanelOpen ? 'active' : ''}`}
              onClick={() => setMemoryPanelOpen(prev => !prev)}
              title="Toggle Memory Panel"
              aria-label="Toggle Memory Panel"
            >
              *
            </button>
            <button
              className={`icon-button ${analyticsViewOpen ? 'active' : ''}`}
              onClick={() => setAnalyticsViewOpen(prev => !prev)}
              title="Analytics Dashboard (Ctrl+Shift+A)"
              aria-label="Analytics Dashboard"
            >
              📊
            </button>
            <button
              className={`icon-button ${arenaViewOpen ? 'active' : ''}`}
              onClick={() => setArenaViewOpen(prev => !prev)}
              title="Arena — compare agents"
              aria-label="Arena"
            >
              ⚔️
            </button>
            <button
              className="icon-button"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              aria-label="Settings"
            >
              ⚙
            </button>
            <button
              className="icon-button"
              onClick={() => setClaudeAccountsOpen(true)}
              title="Claude accounts"
              aria-label="Claude accounts"
            >
              🔑
            </button>
            <button
              className="icon-button"
              onClick={handleCreateGroup}
              title="New Group"
              aria-label="New Group"
            >
              +
            </button>
          </div>
        </div>

        <div className="sidebar-filter">
          <div className="sidebar-filter-field">
          <input
            ref={filterInputRef}
            className="sidebar-filter-input"
            type="text"
            value={filterText}
            placeholder="Filter groups & sessions…"
            aria-label="Filter groups and sessions"
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              if (filterText) {
                // Consume the first Escape to clear the query.
                e.stopPropagation();
                setFilterText('');
              } else {
                // Already empty: step out of the box so keyboard users have a
                // route back, and let app-level dismiss handlers see the key.
                filterInputRef.current?.blur();
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
        </div>

        {filter.active && visibleTopLevelGroups.length === 0 && (
          <div className="sidebar-filter-empty" role="status">No groups or sessions match</div>
        )}

        {visibleTopLevelGroups
          .map(group => (
          <div key={group.id} className="group-container">
            {/* Render main group */}
            <div
              className={`group ${draggedItem?.type === 'group' && draggedItem.id === group.id ? 'dragging' : ''} ${dropTarget?.type === 'group' && dropTarget.id === group.id ? `drop-${dropTarget.position}` : ''}`}
              draggable={!filter.active}
              onDragStart={(e) => handleGroupDragStart(e, group.id)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleGroupDragOver(e, group.id)}
              onDrop={(e) => handleGroupDrop(e, group.id)}
            >
              <div
                className={`group-header ${focusedItemType === 'group' && focusedItemId === group.id ? 'item-focused' : ''}`}
                onClick={() => handleGroupHeaderClick(group.id)}
                onContextMenu={(e) => handleGroupContextMenu(e, group.id, group.name)}
              >
                <button
                  className="group-chevron"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCollapse(group.id);
                  }}
                  disabled={filter.active}
                  title={filter.active
                    ? 'Expanded while filtering'
                    : (group.collapsed ? 'Expand' : 'Collapse')}
                  aria-label={filter.active
                    ? 'Group expanded while filtering'
                    : (group.collapsed ? 'Expand group' : 'Collapse group')}
                >
                  {group.collapsed && !filter.active ? '▶' : '▼'}
                </button>
                <button
                  className="group-color"
                  style={{ background: group.color }}
                  onClick={() => setColorPickerGroupId(colorPickerGroupId === group.id ? null : group.id)}
                  title="Change color"
                  aria-label="Change group color"
                />
                {colorPickerGroupId === group.id && (
                  <div className="color-picker">
                    {GROUP_COLORS.map(color => (
                      <button
                        key={color}
                        className={`color-option ${color === group.color ? 'selected' : ''}`}
                        style={{ background: color }}
                        onClick={() => handleColorSelect(group.id, color)}
                        aria-label={`Set color to ${color}`}
                      />
                    ))}
                  </div>
                )}
                {editingGroupId === group.id ? (
                  <input
                    className="group-name-input"
                    value={editingGroupName}
                    onChange={(e) => setEditingGroupName(e.target.value)}
                    onBlur={handleFinishEditGroup}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleFinishEditGroup();
                      if (e.key === 'Escape') {
                        setEditingGroupId(null);
                        setEditingGroupName('');
                      }
                    }}
                    autoFocus
                  />
                ) : (
                  <span
                    className="group-name"
                    onClick={() => handleStartEditGroup(group.id, group.name)}
                    title={group.workingDir ? `Click to rename\nDir: ${group.workingDir}` : 'Click to rename'}
                  >
                    {group.name}
                    {group.workingDir && <span className="group-dir-indicator" title={group.workingDir}>[dir]</span>}
                  </span>
                )}
                <div className="group-actions">
                  <button
                    className="group-folder"
                    onClick={() => handleSetGroupDirectory(group.id)}
                    title={group.workingDir || 'Set working directory'}
                    aria-label="Set working directory"
                  >
                    ⌂
                  </button>
                  <button
                    className="group-delete"
                    onClick={() => handleDeleteGroup(group.id)}
                    title={getSessionsByGroup(group.id).length > 0 ? "Close all sessions first" : "Delete group"}
                    aria-label="Delete group"
                    disabled={getSessionsByGroup(group.id).length > 0}
                  >
                    ×
                  </button>
                </div>
                <button
                  className="icon-button small"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setNewItemChoice({ x: rect.left, y: rect.bottom + 4, groupId: group.id });
                  }}
                  title="Add to group"
                  aria-label="Add to group"
                >
                  +
                </button>
              </div>
              {(filter.active || !group.collapsed) && (
                <div
                  className={`group-sessions ${dropTarget?.id === `group:${group.id}` ? 'drop-target' : ''}`}
                  onDragOver={(e) => handleGroupAreaDragOver(e, group.id)}
                  onDrop={(e) => handleGroupAreaDrop(e, group.id)}
                >
                {getSessionsByGroup(group.id)
                  .filter(session => !filter.active || filter.visibleSessionIds.has(session.id))
                  .sort((a, b) => a.order - b.order).map(session => (
                  <div
                    key={session.id}
                    className={`session ${session.id === activeSessionId ? 'active' : ''} ${focusedItemType === 'session' && focusedItemId === session.id ? 'item-focused' : ''} ${draggedItem?.type === 'session' && draggedItem.id === session.id ? 'dragging' : ''} ${dropTarget?.type === 'session' && dropTarget.id === session.id ? `drop-${dropTarget.position}` : ''}`}
                    onClick={() => handleSessionClick(session.id)}
                    onContextMenu={(e) => handleSessionContextMenu(e, session.id, session.name)}
                    draggable={!filter.active}
                    onDragStart={(e) => handleSessionDragStart(e, session.id, group.id)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleSessionDragOver(e, session.id, group.id)}
                    onDrop={(e) => handleSessionDrop(e, session.id, group.id)}
                  >
                    {(() => {
                      const acc = effectiveAccountForSession(session.id);
                      if (!acc) return null;
                      return (
                        <span
                          className="session-account-dot"
                          style={{ background: acc.color || '#888888' }}
                          title={`Claude account: ${acc.label}${acc.email ? ` (${acc.email})` : ''}${session.claudeAccountId ? ' — session override' : ' — inherited'}`}
                          aria-label={`Account: ${acc.label}`}
                          draggable={false}
                        />
                      );
                    })()}
                    <div className="session-info">
                      {editingSessionId === session.id ? (
                        <input
                          className="session-name-input"
                          value={editingSessionName}
                          onChange={(e) => setEditingSessionName(e.target.value)}
                          onBlur={handleFinishEditSession}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') handleFinishEditSession();
                            if (e.key === 'Escape') {
                              setEditingSessionId(null);
                              setEditingSessionName('');
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="session-name"
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            handleStartEditSession(session.id, session.name);
                          }}
                          title="Double-click to rename"
                        >
                          {session.name}
                        </span>
                      )}
                      <SessionStatsBadge sessionId={session.id} />
                    </div>
                    {session.shellType === 'claude' && session.provider !== 'claude' && (
                      <span
                        className="session-provider-badge"
                        title={`Provider: ${PROVIDER_LABELS[session.provider] ?? session.provider}`}
                        draggable={false}
                      >
                        {PROVIDER_LABELS[session.provider] ?? session.provider}
                      </span>
                    )}
                    <span className={`status-pill ${session.state}`} draggable={false}>{session.state}</span>
                    <button
                      className="session-close"
                      draggable={false}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveSession(session.id);
                      }}
                      title="Close session"
                      aria-label="Close session"
                    >
                      ×
                    </button>
                  </div>
                  ))}
                </div>
              )}
            </div>

            {/* Render sub-groups when parent not collapsed */}
            {(filter.active || !group.collapsed) && getSubGroups(group.id)
              .filter(subGroup => !filter.active || filter.visibleGroupIds.has(subGroup.id))
              .map(subGroup => (
              <div
                key={subGroup.id}
                className={`group sub-group ${draggedItem?.type === 'group' && draggedItem.id === subGroup.id ? 'dragging' : ''} ${dropTarget?.type === 'group' && dropTarget.id === subGroup.id ? `drop-${dropTarget.position}` : ''}`}
                draggable={!filter.active}
                onDragStart={(e) => handleGroupDragStart(e, subGroup.id)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleGroupDragOver(e, subGroup.id)}
                onDrop={(e) => handleGroupDrop(e, subGroup.id)}
              >
                <div
                  className={`group-header ${focusedItemType === 'group' && focusedItemId === subGroup.id ? 'item-focused' : ''}`}
                  onClick={() => handleGroupHeaderClick(subGroup.id)}
                  onContextMenu={(e) => handleGroupContextMenu(e, subGroup.id, subGroup.name)}
                >
                  <button
                    className="group-chevron"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(subGroup.id);
                    }}
                    disabled={filter.active}
                    title={filter.active
                      ? 'Expanded while filtering'
                      : (subGroup.collapsed ? 'Expand' : 'Collapse')}
                    aria-label={filter.active
                      ? 'Sub-group expanded while filtering'
                      : (subGroup.collapsed ? 'Expand sub-group' : 'Collapse sub-group')}
                  >
                    {subGroup.collapsed && !filter.active ? '▶' : '▼'}
                  </button>
                  <button
                    className="group-color sub-group-color"
                    style={{ borderColor: subGroup.color }}
                    onClick={() => setColorPickerGroupId(colorPickerGroupId === subGroup.id ? null : subGroup.id)}
                    title="Change color"
                    aria-label="Change sub-group color"
                  />
                  {colorPickerGroupId === subGroup.id && (
                    <div className="color-picker">
                      {GROUP_COLORS.map(color => (
                        <button
                          key={color}
                          className={`color-option ${color === subGroup.color ? 'selected' : ''}`}
                          style={{ background: color }}
                          onClick={() => handleColorSelect(subGroup.id, color)}
                          aria-label={`Set color to ${color}`}
                        />
                      ))}
                    </div>
                  )}
                  {editingGroupId === subGroup.id ? (
                    <input
                      className="group-name-input"
                      value={editingGroupName}
                      onChange={(e) => setEditingGroupName(e.target.value)}
                      onBlur={handleFinishEditGroup}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleFinishEditGroup();
                        if (e.key === 'Escape') {
                          setEditingGroupId(null);
                          setEditingGroupName('');
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <span
                      className="group-name"
                      onClick={() => handleStartEditGroup(subGroup.id, subGroup.name)}
                      title={subGroup.workingDir ? `Click to rename\nDir: ${subGroup.workingDir}` : 'Click to rename'}
                    >
                      {subGroup.name}
                      <span className="group-type-indicator">[sub]</span>
                    </span>
                  )}
                  <div className="group-actions">
                    <button
                      className="group-folder"
                      onClick={() => handleSetGroupDirectory(subGroup.id)}
                      title={subGroup.workingDir || 'Set working directory'}
                      aria-label="Set working directory"
                    >
                      ⌂
                    </button>
                    <button
                      className="group-delete"
                      onClick={() => handleDeleteGroup(subGroup.id)}
                      title={getSessionsByGroup(subGroup.id).length > 0 ? "Close all sessions first" : "Delete group"}
                      aria-label="Delete sub-group"
                      disabled={getSessionsByGroup(subGroup.id).length > 0}
                    >
                      ×
                    </button>
                  </div>
                  <button
                    className="icon-button small"
                    onClick={() => handleNewSession(subGroup.id)}
                    title="New Session"
                    aria-label="New Session"
                  >
                    +
                  </button>
                </div>
                {(filter.active || !subGroup.collapsed) && (
                  <div
                    className={`group-sessions ${dropTarget?.id === `group:${subGroup.id}` ? 'drop-target' : ''}`}
                    onDragOver={(e) => handleGroupAreaDragOver(e, subGroup.id)}
                    onDrop={(e) => handleGroupAreaDrop(e, subGroup.id)}
                  >
                  {getSessionsByGroup(subGroup.id)
                    .filter(session => !filter.active || filter.visibleSessionIds.has(session.id))
                    .sort((a, b) => a.order - b.order).map(session => (
                    <div
                      key={session.id}
                      className={`session ${session.id === activeSessionId ? 'active' : ''} ${focusedItemType === 'session' && focusedItemId === session.id ? 'item-focused' : ''} ${draggedItem?.type === 'session' && draggedItem.id === session.id ? 'dragging' : ''} ${dropTarget?.type === 'session' && dropTarget.id === session.id ? `drop-${dropTarget.position}` : ''}`}
                      onClick={() => handleSessionClick(session.id)}
                      onContextMenu={(e) => handleSessionContextMenu(e, session.id, session.name)}
                      draggable={!filter.active}
                      onDragStart={(e) => handleSessionDragStart(e, session.id, subGroup.id)}
                      onDragEnd={handleDragEnd}
                      onDragOver={(e) => handleSessionDragOver(e, session.id, subGroup.id)}
                      onDrop={(e) => handleSessionDrop(e, session.id, subGroup.id)}
                    >
                      {(() => {
                        const acc = effectiveAccountForSession(session.id);
                        if (!acc) return null;
                        return (
                          <span
                            className="session-account-dot"
                            style={{ background: acc.color || '#888888' }}
                            title={`Claude account: ${acc.label}${acc.email ? ` (${acc.email})` : ''}${session.claudeAccountId ? ' — session override' : ' — inherited'}`}
                            aria-label={`Account: ${acc.label}`}
                          />
                        );
                      })()}
                      <div className="session-info">
                        {editingSessionId === session.id ? (
                          <input
                            className="session-name-input"
                            value={editingSessionName}
                            onChange={(e) => setEditingSessionName(e.target.value)}
                            onBlur={handleFinishEditSession}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Enter') handleFinishEditSession();
                              if (e.key === 'Escape') {
                                setEditingSessionId(null);
                                setEditingSessionName('');
                              }
                            }}
                            onClick={(e) => e.stopPropagation()}
                            autoFocus
                          />
                        ) : (
                          <span
                            className="session-name"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              handleStartEditSession(session.id, session.name);
                            }}
                            title="Double-click to rename"
                          >
                            {session.name}
                          </span>
                        )}
                        <SessionStatsBadge sessionId={session.id} />
                      </div>
                      <span className={`status-pill ${session.state}`}>{session.state}</span>
                      <button
                        className="session-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveSession(session.id);
                        }}
                        title="Close session"
                        aria-label="Close session"
                      >
                        ×
                      </button>
                    </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}

      </aside>

      <main className="main">
        {analyticsViewOpen && (
          <AnalyticsPanel
            onClose={() => setAnalyticsViewOpen(false)}
            activeSessionId={activeSessionId}
          />
        )}
        {arenaViewOpen && (
          <ArenaPanel
            onClose={() => setArenaViewOpen(false)}
            groups={groups}
            initialGroupId={arenaGroupId}
          />
        )}
        <div className="terminal-area" style={{ display: analyticsViewOpen || arenaViewOpen ? 'none' : undefined }}>
          {sessions.map(session => (
            <div
              key={session.id}
              className="terminal-wrapper"
              style={{ display: session.id === activeSessionId ? 'flex' : 'none' }}
            >
              <TerminalHeader
                session={session}
                onRename={(name) => updateSession(session.id, { name })}
                onRestart={() => setRestartKeys(prev => ({ ...prev, [session.id]: (prev[session.id] || 0) + 1 }))}
                onStop={() => updateSession(session.id, { state: 'stopped' })}
                onClose={() => handleRemoveSession(session.id)}
              />
              <ErrorBoundary>
                <Terminal
                  sessionId={session.id}
                  cwd={session.workingDir}
                  launchClaude={session.shellType === 'claude'}
                  provider={session.provider}
                  isStopped={session.state === 'stopped'}
                  restartKey={restartKeys[session.id] || 0}
                  isActive={session.id === activeSessionId}
                  sessionState={session.state}
                  onStart={() => updateSession(session.id, { state: 'idle' })}
                  onError={() => updateSession(session.id, { state: 'error' })}
                />
              </ErrorBoundary>
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="no-session">
              {!groups.length ? (
                <>
                  <h2>Welcome to Bodhilander</h2>
                  <p>Create a group to organize your Claude Code sessions.</p>
                  <button onClick={handleCreateGroup}>
                    Create Your First Group
                  </button>
                </>
              ) : (
                <>
                  <p>Select a session or create a new one</p>
                  <button onClick={() => handleNewSession(groups[0].id)}>
                    Create Session
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Memory Panel */}
      <MemoryPanel
        isOpen={memoryPanelOpen}
        onToggle={() => setMemoryPanelOpen(prev => !prev)}
        sessionId={activeSessionId}
        groupId={activeGroupId}
      />

      <footer className="status-bar">
        <div className="status-left">
          <span className="status-item waiting">* {counts.waiting} waiting</span>
          <span className="status-item working">o {counts.working} working</span>
          <span className="status-item idle">o {counts.idle} idle</span>
          <span className="status-item stopped">- {counts.stopped} stopped</span>
          <span className="status-item error">! {counts.error} errors</span>
        </div>
        <div className="status-right">
          {getContextShortcuts().map((shortcut, i) => (
            <span key={i} className="status-shortcut">
              <kbd>{shortcut.key}</kbd> {shortcut.label}
            </span>
          ))}
        </div>
      </footer>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}


      {/* Name prompt modals */}
      <NamePromptModal
        isOpen={sessionPrompt !== null}
        title="New Session"
        placeholder="Enter session name"
        defaultValue={sessionPrompt?.defaultName || ''}
        onConfirm={handleConfirmSession}
        onCancel={() => setSessionPrompt(null)}
        providerPicker
      />

      <NamePromptModal
        isOpen={groupPrompt !== null}
        title="New Group"
        placeholder="Enter group name"
        defaultValue={groupPrompt?.defaultName || ''}
        onConfirm={handleConfirmGroup}
        onCancel={() => setGroupPrompt(null)}
        showPathSelector={true}
        accountPicker={{ accounts: claudeAccounts, initialAccountId: null }}
      />

      <NamePromptModal
        isOpen={subGroupPrompt !== null}
        title="New Sub-Group"
        placeholder="Enter sub-group name"
        defaultValue={subGroupPrompt?.defaultName || ''}
        onConfirm={handleConfirmSubGroup}
        onCancel={() => setSubGroupPrompt(null)}
        showPathSelector={true}
        pathLabel="Working Directory (optional, inherits from parent)"
        accountPicker={{
          accounts: claudeAccounts,
          initialAccountId: null,
          label: 'Claude account (optional, inherits from parent)',
        }}
      />

      {/* Choice menu for + button on groups */}
      <NewItemChoice
        isOpen={newItemChoice !== null}
        x={newItemChoice?.x || 0}
        y={newItemChoice?.y || 0}
        onNewSession={() => {
          if (newItemChoice) {
            handleNewSession(newItemChoice.groupId);
          }
          setNewItemChoice(null);
        }}
        onNewSubGroup={() => {
          if (newItemChoice) {
            handleCreateSubGroup(newItemChoice.groupId);
          }
          setNewItemChoice(null);
        }}
        onClose={() => setNewItemChoice(null)}
      />

      {/* Settings modal */}
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

      {/* Claude accounts modal (BDHLNDR-31) */}
      <ClaudeAccountsModal
        isOpen={claudeAccountsOpen}
        onClose={() => setClaudeAccountsOpen(false)}
      />

      {/* Destructive action confirmation dialog */}
      {confirmAction && (
        <div className="modal-overlay" onClick={() => setConfirmAction(null)}>
          <div
            className="modal-content confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-describedby="confirm-message"
            onClick={e => e.stopPropagation()}
          >
            <p id="confirm-message">{confirmAction.message}</p>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmAction(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => {
                if (confirmAction.type === 'closeSession') doRemoveSession(confirmAction.id);
                if (confirmAction.type === 'deleteGroup') doDeleteGroup(confirmAction.id);
                setConfirmAction(null);
              }}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
