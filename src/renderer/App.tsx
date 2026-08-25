import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import Terminal from './components/Terminal';
import TerminalHeader from './components/TerminalHeader';
import ContextMenu, { MenuItem } from './components/ContextMenu';
import { NamePromptModal } from './components/NamePromptModal';
import { OwnerConfirmModal, type PendingOwner } from './components/OwnerConfirmModal';
import { ShareSessionModal } from './components/ShareSessionModal';
import { GuestJoinRequestModal } from './components/GuestJoinRequestModal';
import { SettingsModal, SettingsTab } from './components/SettingsModal';
import { NewItemChoice } from './components/NewItemChoice';
import { SidebarFilter } from './components/SidebarFilter';
import { SessionRow } from './components/SessionRow';
import { GroupColorPicker } from './components/GroupColorPicker';
import AnalyticsPanel from './components/panels/AnalyticsPanel';
import { ArenaPanel } from './components/ArenaPanel';
import { ViewSwitcher, type ContentView } from './components/ViewSwitcher';
import { isSwitchPending, type SessionAccountIndicatorProps } from './components/SessionAccountIndicator';
import { ClaudeAccount, Session } from '../shared/types';
import type { LiveAccountBinding, LiveAccountBindings, RelayAttachedGuest, RelayPendingShare, RelayStatus } from '../shared/types';
import { useSessions } from './store/sessions';
import { useGroups } from './store/groups';
import { computeGroupFilter, buildNavItems } from './store/groupFilter';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useActiveOnlyPreference } from './hooks/useActiveOnlyPreference';
import './styles/global.css';
import './styles/context-menu.css';
import ErrorBoundary from './components/ErrorBoundary';

/**
 * Collapse-chevron labels. While a filter is active every row is force-expanded,
 * so the control is disabled and says so rather than lying about state (#141).
 */
function chevronTitle(collapsed: boolean, filtering: boolean): string {
  if (filtering) return 'Expanded while filtering';
  return collapsed ? 'Expand' : 'Collapse';
}

function chevronAriaLabel(collapsed: boolean, filtering: boolean, kind: 'group' | 'sub-group'): string {
  if (filtering) return `${kind} expanded while filtering`;
  return collapsed ? `Expand ${kind}` : `Collapse ${kind}`;
}

/**
 * How an account is named in a context menu (#165).
 *
 * The label alone does not say which login an account is: two accounts both
 * called "Work" are indistinguishable in the menu, and after a login the email
 * is the only thing that tells them apart. Accounts that never wrote an email
 * — the normal case on macOS, where Claude Code keeps its tokens in the
 * Keychain rather than in the config dir — say so, so a blank tail can never be
 * read as "this one has no second account behind it".
 *
 * MenuItem.label is a string, so the swatch that carries colour elsewhere
 * cannot come along; label + email identifies the account without it, which is
 * the accessible baseline the swatch was never allowed to be responsible for.
 */
export function accountMenuLabel(acc: ClaudeAccount, isCurrent: boolean): string {
  return `${isCurrent ? '✓ ' : '   '}Use "${acc.label}"`
    + (acc.email ? ` — ${acc.email}` : ' — not yet logged in')
    + (acc.isDefault ? ' (default)' : '');
}

/**
 * Everything the session header's account indicator needs, resolved (#165).
 *
 * Two questions that look like one and are not: the session → group → default
 * chain answers "what will this session run under", the live binding published
 * by PtyManager answers "what is it running under right now". CLAUDE_CONFIG_DIR
 * is baked into a pty at spawn, so the two diverge the moment an account is
 * switched on a live session and stay diverged until it respawns. Presenting
 * the first as if it were the second is exactly what made #164's first symptom
 * look like nothing had happened — every surface agreed with the user's pick
 * while the old account went on being billed.
 *
 * Returns null when there is nothing to disclose: no accounts registered at
 * all, or a session that is not a Claude session (a plain shell, or codex/grok,
 * which main deliberately never publishes a binding for). The header then keeps
 * its pre-accounts look rather than growing an empty slot.
 *
 * Pure and exported so the resolution can be pinned by tests without standing
 * up the whole App tree.
 */
export function resolveAccountIndicator(args: {
  session: Session;
  accounts: ClaudeAccount[];
  /** The live binding for this session, or undefined when no pty is running. */
  binding: LiveAccountBinding | undefined;
  /** Result of the session → group → default chain. */
  assignedAccount: ClaudeAccount | null;
  onApplySwitch: () => void;
}): SessionAccountIndicatorProps | null {
  const { session, accounts, binding, assignedAccount, onApplySwitch } = args;
  if (session.shellType !== 'claude' || session.provider !== 'claude') return null;
  // No accounts registered is the pre-accounts look, and it stays that way —
  // unless a pty is running under an account id, which by then can only be one
  // the user deleted out from under it. That is precisely when naming the live
  // account matters: the process is alive, still billing a login whose config
  // dir has been removed, and an empty header would say nothing at all.
  if (accounts.length === 0 && !binding?.accountId) return null;

  // Join by id rather than snapshotting the account onto the binding, so a
  // rename or a recolour shows up without waiting for the pty to respawn.
  const live = binding?.accountId
    ? accounts.find(a => a.id === binding.accountId) ?? null
    : null;

  return {
    liveAccount: live,
    assignedAccount,
    // Presence in the map IS the pty: main deletes the entry on exit. Reading
    // session.state instead would call a session "running" through the whole
    // restart window, when there is no pty and no account in use.
    isRunning: !!binding,
    liveAccountUnknown: !!binding?.accountId && !live,
    isOverride: session.claudeAccountId !== null,
    onApplySwitch,
  };
}

const App: React.FC = () => {
  const {
    groups,
    loading: groupsLoading,
    createGroup,
    updateGroup,
    setGroupAccount,
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
  // "Show only active" toggle (#149). Persisted via the preferences table.
  const [showActiveOnly, handleActiveOnlyChange] = useActiveOnlyPreference();
  const [isResizing, setIsResizing] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which Settings tab to land on. Claude accounts left the sidebar and became
  // a Settings tab, so App needs to be able to open Settings straight to it.
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('general');
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeAccount[]>([]);
  // Which account each running pty ACTUALLY spawned under (#165), keyed by
  // session id. Absent id = no pty running for that session.
  const [liveAccounts, setLiveAccounts] = useState<LiveAccountBindings>({});
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

  // Which destination the content area is showing (BDHLNDR-18). Terminal,
  // Analytics and Arena all live in the same content area, so they are one
  // value rather than a boolean each.
  const [contentView, setContentView] = useState<ContentView>('terminal');
  // Group whose working dir the arena panel should scope to ("Ask Arena" menu).
  const [arenaGroupId, setArenaGroupId] = useState<string | null>(null);

  // Code search modal state

  // Destructive action confirmation state
  const [confirmAction, setConfirmAction] = useState<{
    type: 'closeSession' | 'deleteGroup' | 'restartForAccountSwitch';
    id: string;
    message: string;
    /** Sessions to respawn, for 'restartForAccountSwitch'. */
    sessionIds?: string[];
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
    setSessionAccount,
    removeSession,
    getSessionsByGroup,
    getStateCounts,
    reorderSession,
  } = useSessions();

  const homedir = window.electronAPI.homedir;
  const counts = getStateCounts();
  const isLoading = groupsLoading || sessionsLoading;

  // Bare Ctrl belongs to the terminal (SIGINT, readline), so app-level actions
  // bind Cmd on macOS and Ctrl+Shift everywhere else. Every shortcut hint we
  // show the user has to reflect that, or the label lies about the key.
  const isMac = useMemo(() => window.electronAPI.platform === 'darwin', []);
  const appMod = isMac ? '⌘' : 'Ctrl+Shift+';

  // Which sidebar rows survive the text filter (#141).
  const filter = useMemo(
    () => computeGroupFilter(groups, sessions, filterText, showActiveOnly),
    [groups, sessions, filterText, showActiveOnly],
  );

  // "Search mode" is a text query only. It force-expands collapsed groups and
  // suspends collapse/drag while you search — transient, cleared when the box
  // empties. The active-only toggle must NOT do those things: it is persisted,
  // so locking collapse/drag on it would disable them app-wide across launches
  // (#149). It only prunes which rows render, via `filter`.
  const isSearching = filterText.trim().length > 0;

  // The top-level rows actually rendered. Drives both the list and the empty
  // state, so the two can never disagree.
  const visibleTopLevelGroups = useMemo(
    () => getTopLevelGroups().filter(g => !filter.active || filter.visibleGroupIds.has(g.id)),
    [getTopLevelGroups, filter],
  );

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

  // Refresh accounts whenever Settings closes (covers delete/rename). The
  // Settings "Claude accounts" tab is the only place accounts are edited now,
  // so it has to re-pull — otherwise the sidebar's per-session account dots go
  // stale.
  useEffect(() => {
    if (!settingsOpen) {
      window.electronAPI.listAccounts().then(setClaudeAccounts).catch(() => {});
    }
  }, [settingsOpen]);

  /**
   * Track the account every running pty is actually bound to (#165).
   *
   * Both halves are load-bearing. The push event is what keeps this honest
   * through a respawn the renderer never asked for — the BDHLNDR-9
   * resume-failure fallback replaces a pty silently, by design, and would
   * otherwise leave the header naming an account that died with the old
   * process. The one-shot query is what makes a renderer that mounted after
   * the ptys were already running (a reload, a crash recovery) correct
   * immediately rather than only after the next spawn or exit.
   *
   * Last-writer-wins per session id, so the two cannot fight: the query runs
   * once, at mount, and every later write is an event about one session.
   */
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.getLiveAccounts()
      .then(map => { if (!cancelled) setLiveAccounts(map); })
      .catch(err => console.error('Failed to load live account bindings:', err));
    const off = window.electronAPI.onPtyLiveAccount((sessionId, binding) => {
      setLiveAccounts(prev => {
        const next = { ...prev };
        if (binding) next[sessionId] = binding;
        else delete next[sessionId];
        return next;
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

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

  /**
   * A newly created group/session becomes active straight away, so it has to be
   * visible. Clear the filter only when the new name would not match it —
   * an unrelated query is left untouched (#141).
   */
  const revealNewItem = useCallback((name: string) => {
    const query = filterText.trim().toLowerCase();
    if (query && !name.toLowerCase().includes(query)) setFilterText('');
  }, [filterText]);

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
    revealNewItem(name);
  }, [sessionPrompt, revealNewItem, getEffectiveWorkingDir, createSession, homedir]);

  // Show prompt for new group name
  const handleCreateGroup = () => {
    const count = groups.filter(g => !g.parentId).length + 1;
    setGroupPrompt({ defaultName: `Group ${count}` });
  };

  // Actually create the group after name is confirmed
  const handleConfirmGroup = async (name: string, path?: string, claudeAccountId?: string | null) => {
    setGroupPrompt(null);
    revealNewItem(name);

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
    revealNewItem(name);
  };

  const handleStartEditGroup = (groupId: string, currentName: string) => {
    setEditingGroupId(groupId);
    setEditingGroupName(currentName);
  };

  const handleFinishEditGroup = async () => {
    if (editingGroupId && editingGroupName.trim()) {
      await updateGroup(editingGroupId, { name: editingGroupName.trim() });
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

  /**
   * Of the sessions whose account just changed, the ones with a pty to replace.
   * Stopped sessions are skipped — they have nothing running under the old
   * account and pick the new one up whenever the user starts them.
   */
  const liveSessionsAmong = (sessionIds: string[]) =>
    sessionIds.filter(id => sessions.find(s => s.id === id)?.state !== 'stopped');

  /**
   * Respawn the ptys of sessions whose account just changed (BDHLNDR-31).
   * The account only reaches the CLI as CLAUDE_CONFIG_DIR, which is fixed when
   * the pty spawns — without this the picked account applies to nothing until
   * the user restarts by hand. Main has already carried the conversation
   * transcript over, so the relaunch resumes where the old account left off.
   */
  const restartSessions = useCallback((sessionIds: string[]) => {
    if (sessionIds.length === 0) return;
    setRestartKeys(prev => {
      const next = { ...prev };
      for (const id of sessionIds) next[id] = (next[id] ?? 0) + 1;
      return next;
    });
  }, []);

  /**
   * The header account indicator for one session (#165).
   *
   * Sits here rather than beside effectiveAccountForSession because it needs
   * restartSessions, which is declared just above: a `const` referenced from a
   * dependency array is evaluated at render time, so the order is not cosmetic.
   */
  const accountIndicatorFor = useCallback((session: Session): SessionAccountIndicatorProps | null => (
    resolveAccountIndicator({
      session,
      accounts: claudeAccounts,
      binding: liveAccounts[session.id],
      assignedAccount: effectiveAccountForSession(session.id),
      // A switch the user points at directly restarts outright — the same rule
      // handleAssignSessionAccount follows. Only a group-wide sweep, which can
      // take several sessions down at once, asks first.
      onApplySwitch: () => restartSessions([session.id]),
    })
  ), [claudeAccounts, liveAccounts, effectiveAccountForSession, restartSessions]);

  /**
   * What the sidebar row says about a session's account (#165).
   *
   * Derived from the same resolution the header uses, so the two surfaces
   * cannot contradict each other. They used to: decline the "restart 5
   * sessions?" prompt after a group switch and every row recoloured to the new
   * account immediately while all five ptys kept billing the old one — the
   * exact lie this feature exists to stop telling, and on the four sessions the
   * user cannot see (inactive headers are display:none) the sidebar is the only
   * thing saying anything at all.
   */
  const sidebarAccountFor = useCallback((session: Session): {
    account: ClaudeAccount | null;
    pendingSwitch: { target: ClaudeAccount | null } | null;
  } => {
    const indicator = accountIndicatorFor(session);
    // Non-Claude sessions and the pre-accounts look keep the old behaviour:
    // there is no live binding to prefer, so the assignment is all there is.
    if (!indicator) return { account: effectiveAccountForSession(session.id), pendingSwitch: null };
    return {
      account: indicator.isRunning ? indicator.liveAccount : indicator.assignedAccount,
      pendingSwitch: isSwitchPending(indicator) ? { target: indicator.assignedAccount } : null,
    };
  }, [accountIndicatorFor, effectiveAccountForSession]);

  // Switching one session's account restarts it outright: the user pointed at
  // that session and picked an account, so the restart is the thing they asked
  // for.
  const handleAssignSessionAccount = async (sessionId: string, accountId: string | null) => {
    restartSessions(liveSessionsAmong(await setSessionAccount(sessionId, accountId)));
  };

  // A group switch can sweep several running sessions at once, which is a much
  // bigger action than the click implies — so the restart is opt-in. Declining
  // still persists the assignment; those sessions move over on their next
  // restart.
  const handleAssignGroupAccount = async (groupId: string, accountId: string | null) => {
    const live = liveSessionsAmong(await setGroupAccount(groupId, accountId));
    if (live.length === 0) return;
    const count = live.length === 1 ? '1 running session' : `${live.length} running sessions`;
    setConfirmAction({
      type: 'restartForAccountSwitch',
      id: groupId,
      sessionIds: live,
      message: `${count} in this group ${live.length === 1 ? 'is' : 'are'} still on the previous `
        + `account. Restart ${live.length === 1 ? 'it' : 'them'} now to apply the switch? `
        + `Conversations resume where they left off. Skipping applies the switch on their next restart.`,
    });
  };

  const handleSessionContextMenu = (e: React.MouseEvent, sessionId: string, sessionName: string) => {
    e.preventDefault();
    const session = sessions.find(s => s.id === sessionId);
    const currentAccountId = session?.claudeAccountId ?? null;

    const items: MenuItem[] = [
      { label: 'Rename', onClick: () => handleStartEditSession(sessionId, sessionName) },
    ];

    // Sharing is entered PER SESSION, which is the whole shape of the feature —
    // there is no "share my machine" anywhere. Only offered while remote
    // hosting is actually connected: an invite minted against a relay we
    // cannot reach would fail at the point the owner is trying to be helpful.
    if (relayReady) {
      items.push({ label: 'separator', onClick: () => {}, separator: true });
      items.push({
        label: 'Share…',
        onClick: () => setSharingSession({ id: sessionId, name: sessionName }),
      });
    }

    // Account-assignment items (BDHLNDR-31) — only shown when accounts are registered.
    if (claudeAccounts.length > 0) {
      items.push({ label: 'separator', onClick: () => {}, separator: true });
      items.push({
        label: `${currentAccountId === null ? '✓ ' : '   '}Inherit account from group`,
        // Fire-and-forget: the menu closes on click and the store logs its own
        // failures, so there's nothing for the caller to await.
        onClick: () => { void handleAssignSessionAccount(sessionId, null); },
      });
      for (const acc of claudeAccounts) {
        items.push({
          label: accountMenuLabel(acc, currentAccountId === acc.id),
          onClick: () => { void handleAssignSessionAccount(sessionId, acc.id); },
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
          setContentView('arena');
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
        // Fire-and-forget, as above — the restart prompt is raised from inside
        // the handler once main reports which sessions moved.
        onClick: () => { void handleAssignGroupAccount(groupId, null); },
      });
      for (const acc of claudeAccounts) {
        items.push({
          label: accountMenuLabel(acc, currentAccountId === acc.id),
          onClick: () => { void handleAssignGroupAccount(groupId, acc.id); },
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
    () => buildNavItems(groups, sessions, filter, isSearching),
    [groups, sessions, filter, isSearching],
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
    if (!sidebarFocused || !focusedItemId || isSearching) return;
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
  }, [sidebarFocused, focusedItemId, focusedItemType, groups, sessions, toggleCollapse, isSearching]);

  const handleExpand = useCallback(() => {
    if (!sidebarFocused || !focusedItemId) return;
    if (focusedItemType === 'group') {
      const group = groups.find(g => g.id === focusedItemId);
      if (group?.collapsed && !isSearching) {
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
  }, [sidebarFocused, focusedItemId, focusedItemType, groups, toggleCollapse, setActiveSessionId, isSearching]);

  const handleSelect = useCallback(() => {
    if (!sidebarFocused || !focusedItemId) return;
    if (focusedItemType === 'group') {
      if (!isSearching) toggleCollapse(focusedItemId);
    } else if (focusedItemType === 'session') {
      setActiveSessionId(focusedItemId);
      setSidebarFocused(false);
      // Focus the terminal after a short delay to let it become visible
      setTimeout(() => {
        window.dispatchEvent(new Event('focus-terminal'));
      }, 50);
    }
  }, [sidebarFocused, focusedItemId, focusedItemType, toggleCollapse, setActiveSessionId, isSearching]);

  const handleNewGroup = useCallback(async () => {
    const name = `Group ${groups.filter(g => !g.parentId).length + 1}`;
    const newGroup = await createGroup(name);
    revealNewItem(name);

    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      await updateGroup(newGroup.id, { workingDir: dir });
    }
  }, [createGroup, updateGroup, groups, revealNewItem]);

  // Wiring for one session row. Hoisted out of the JSX so the per-row callbacks
  // are not nested five closures deep inside the group/sub-group maps.
  const [pendingOwner, setPendingOwner] = useState<PendingOwner | null>(null);
  /** Guests attached right now — the presence surfaces read this. */
  const [attachedGuests, setAttachedGuests] = useState<RelayAttachedGuest[]>([]);
  /** Share requests waiting on an answer. */
  const [pendingShares, setPendingShares] = useState<RelayPendingShare[]>([]);
  /** The session the share modal is open for, if any. */
  const [sharingSession, setSharingSession] = useState<{ id: string; name: string } | null>(null);
  /** Whether sharing can be offered at all — linked, enabled and connected. */
  const [relayReady, setRelayReady] = useState(false);

  /** Guests watching a given session right now. */
  const guestsBySession = useMemo(() => {
    const map = new Map<string, RelayAttachedGuest[]>();
    for (const guest of attachedGuests) {
      for (const sessionId of guest.sessionIds) {
        const list = map.get(sessionId);
        if (list) list.push(guest);
        else map.set(sessionId, [guest]);
      }
    }
    return map;
  }, [attachedGuests]);

  // A session restored from another machine points at a folder that is not
  // here. Picking the folder is all it takes to make it launchable again.
  const handleRelinkSession = useCallback(async (id: string, currentDir: string) => {
    const chosen = await window.electronAPI.selectDirectory(currentDir || undefined);
    if (chosen) await updateSession(id, { workingDir: chosen, state: 'idle' });
  }, [updateSession]);

  const sessionRowProps = useCallback((session: Session, groupId: string) => ({
    session,
    isActive: session.id === activeSessionId,
    isFocused: focusedItemType === 'session' && focusedItemId === session.id,
    isDragging: draggedItem?.type === 'session' && draggedItem.id === session.id,
    dropPosition: dropTarget?.type === 'session' && dropTarget.id === session.id
      ? dropTarget.position
      : null,
    draggable: !isSearching,
    ...sidebarAccountFor(session),
    watchingCount: guestsBySession.get(session.id)?.length ?? 0,
    watchingNames: guestsBySession.get(session.id)?.map((g) => (g.login ? `@${g.login}` : (g.displayName ?? 'someone'))),
    isEditing: editingSessionId === session.id,
    editingName: editingSessionName,
    onEditingNameChange: setEditingSessionName,
    onStartEdit: () => handleStartEditSession(session.id, session.name),
    onFinishEdit: handleFinishEditSession,
    onCancelEdit: () => { setEditingSessionId(null); setEditingSessionName(''); },
    onSelect: () => handleSessionClick(session.id),
    onContextMenu: (e: React.MouseEvent) => handleSessionContextMenu(e, session.id, session.name),
    onDragStart: (e: React.DragEvent) => handleSessionDragStart(e, session.id, groupId),
    onDragEnd: handleDragEnd,
    onDragOver: (e: React.DragEvent) => handleSessionDragOver(e, session.id, groupId),
    onDrop: (e: React.DragEvent) => handleSessionDrop(e, session.id, groupId),
    onClose: () => handleRemoveSession(session.id),
    onRelink: () => handleRelinkSession(session.id, session.workingDir),
  }), [
    activeSessionId, focusedItemType, focusedItemId, draggedItem, dropTarget,
    isSearching, sidebarAccountFor, editingSessionId, editingSessionName,
    handleStartEditSession, handleFinishEditSession, handleSessionClick, handleSessionContextMenu,
    handleSessionDragStart, handleDragEnd, handleSessionDragOver, handleSessionDrop,
    handleRemoveSession, guestsBySession, handleRelinkSession]);

  const getContextShortcuts = useCallback(() => {
    if (sidebarFocused) {
      return [
        { key: '↑↓', label: 'Navigate' },
        { key: 'Enter', label: 'Select' },
        // Collapse/expand is unavailable while filtering — rows are
        // force-expanded, so advertising it would be a lie (#141).
        ...(isSearching ? [] : [{ key: '←→', label: 'Collapse' }]),
        { key: `${appMod}G`, label: 'New Group' },
      ];
    }
    return [
      { key: `${appMod}B`, label: 'Sidebar' },
      // Ctrl+Tab is the one binding that is identical on every platform — Tab
      // is not a readline key, so the terminal doesn't need it.
      { key: 'Ctrl+Tab', label: 'Next' },
      { key: `${appMod}W`, label: 'Close' },
    ];
  }, [sidebarFocused, appMod, isSearching]);

  const handleNewSubGroup = useCallback(async () => {
    if (focusedItemType === 'group' && focusedItemId) {
      const group = groups.find(g => g.id === focusedItemId);
      if (group && !group.parentId) {
        await handleCreateSubGroup(focusedItemId);
      }
    }
  }, [focusedItemType, focusedItemId, groups, handleCreateSubGroup]);


  // Arrow/Home/End move between view tabs and select as they go (the WAI-ARIA
  // tabs pattern with automatic activation). Combined with the roving
  // tabIndex below, the whole strip is a single Tab stop.
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
    onViewTerminal: () => setContentView('terminal'),
    onViewAnalytics: () => setContentView('analytics'),
    onViewArena: () => setContentView('arena'),
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
      window.electronAPI.onMenuViewTerminal(() => setContentView('terminal')),
      window.electronAPI.onMenuViewAnalytics(() => setContentView('analytics')),
      window.electronAPI.onMenuViewArena(() => setContentView('arena')),
      window.electronAPI.onMenuFocusSidebar(handleFocusSidebar),
      // "Claude Accounts..." is the only discoverable entry point to accounts
      // now that the sidebar key button is gone, so it deep-links Settings
      // straight to the accounts tab rather than dropping the user on General.
      window.electronAPI.onMenuOpenAccounts(() => {
        setSettingsInitialTab('accounts');
        setSettingsOpen(true);
      }),
      window.electronAPI.onSessionSelect(handleSessionSelect),
    ];
    return () => cleanups.forEach(cleanup => cleanup());
  }, [handleKeyboardNewSession, handleCloseSession, handleNextSession, handlePrevSession, handleNextWaiting, handleFocusSidebar, handleSessionSelect]);

  // Listen for settings modal open event (app menu Cmd/Ctrl+, and the tray).
  useEffect(() => {
    const unsubscribe = window.electronAPI.onOpenSettings(() => {
      // A plain "Settings" invocation always lands on General. The modal stays
      // mounted and re-applies initialTab on every open, so without this reset
      // a previous deep-link (e.g. straight to Claude accounts) would stick.
      setSettingsInitialTab('general');
      setSettingsOpen(true);
    });
    return unsubscribe;
  }, []);

  // Sidebar resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  // Owner confirmation (session sharing §3). Lives here rather than in
  // RemoteHostingSettings because it fires when the agent connects, which is
  // usually nowhere near the Settings modal — and it must be answered before
  // the machine can be shared from.

  useEffect(() => {
    let cancelled = false;
    const apply = (s: RelayStatus) => {
      setPendingOwner(s.pendingOwner);
      setAttachedGuests(s.attachedGuests ?? []);
      setPendingShares(s.pendingShares ?? []);
      setRelayReady(s.enabled && s.linked && s.connected);
    };
    window.electronAPI
      .relayGetStatus()
      .then((s) => {
        if (!cancelled) apply(s);
      })
      .catch(() => {
        /* relay off or unavailable — nothing to show */
      });
    const off = window.electronAPI.onRelayStatus(apply);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const handleApproveShare = useCallback(async (grantId: string) => {
    try {
      const status = await window.electronAPI.relayApproveShare(grantId);
      setPendingShares(status.pendingShares ?? []);
    } catch {
      // The request went away underneath us (expired, or revoked elsewhere).
      // Drop it rather than leaving a prompt that can no longer be answered.
      setPendingShares((prev) => prev.filter((p) => p.grantId !== grantId));
    }
  }, []);

  const handleDenyShare = useCallback(async (grantId: string) => {
    try {
      const status = await window.electronAPI.relayDenyShare(grantId);
      setPendingShares(status.pendingShares ?? []);
    } catch {
      setPendingShares((prev) => prev.filter((p) => p.grantId !== grantId));
    }
  }, []);

  const handleConfirmOwner = useCallback(async (userId: string) => {
    try {
      const status = await window.electronAPI.relayConfirmOwner(userId);
      setPendingOwner(status.pendingOwner);
    } catch {
      // The pending owner changed underneath us (a reconnect asserting someone
      // else). Clear it and let the next status push re-raise the question,
      // rather than leaving a stale identity on screen to be confirmed.
      setPendingOwner(null);
    }
  }, []);

  const handleRejectOwner = useCallback(async () => {
    try {
      const status = await window.electronAPI.relayRejectOwner();
      setPendingOwner(status.pendingOwner);
    } catch {
      setPendingOwner(null);
    }
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
          {/* Only "+" survives here: it acts on the list directly beneath it.
              Analytics and Arena moved to the content-area view switcher, and
              Settings (with Claude accounts as a tab) is reachable from the
              app menu and the tray. */}
          <button
            className="icon-button"
            onClick={handleCreateGroup}
            title={`New Group (${appMod}G)`}
            aria-label="New Group"
          >
            +
          </button>
        </div>

        <SidebarFilter
          value={filterText}
          onChange={setFilterText}
          activeOnly={showActiveOnly}
          onActiveOnlyChange={handleActiveOnlyChange}
        />

        {filter.active && visibleTopLevelGroups.length === 0 && (
          <output className="sidebar-filter-empty">
            {showActiveOnly && !filterText.trim()
              ? 'No groups have active sessions'
              : 'No groups or sessions match'}
          </output>
        )}

        {visibleTopLevelGroups
          .map(group => (
          <ul key={group.id} className="group-container">
            {/* Render main group */}
            <li
              className={`group ${draggedItem?.type === 'group' && draggedItem.id === group.id ? 'dragging' : ''} ${dropTarget?.type === 'group' && dropTarget.id === group.id ? `drop-${dropTarget.position}` : ''}`}
              draggable={!isSearching}
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
                  disabled={isSearching}
                  title={chevronTitle(group.collapsed, isSearching)}
                  aria-label={chevronAriaLabel(group.collapsed, isSearching, 'group')}
                >
                  {group.collapsed && !isSearching ? '▶' : '▼'}
                </button>
                <button
                  className="group-color"
                  style={{ background: group.color }}
                  onClick={() => setColorPickerGroupId(colorPickerGroupId === group.id ? null : group.id)}
                  title="Change color"
                  aria-label="Change group color"
                />
                {colorPickerGroupId === group.id && (
                  <GroupColorPicker
                    colors={GROUP_COLORS}
                    selected={group.color}
                    onSelect={(color) => handleColorSelect(group.id, color)}
                  />
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
              {(isSearching || !group.collapsed) && (
                <ul
                  className={`group-sessions ${dropTarget?.id === `group:${group.id}` ? 'drop-target' : ''}`}
                  onDragOver={(e) => handleGroupAreaDragOver(e, group.id)}
                  onDrop={(e) => handleGroupAreaDrop(e, group.id)}
                >
                {getSessionsByGroup(group.id)
                  .filter(session => !filter.active || filter.visibleSessionIds.has(session.id))
                  .sort((a, b) => a.order - b.order).map(session => (
                  <SessionRow key={session.id} {...sessionRowProps(session, group.id)} />
                  ))}
                </ul>
              )}
            </li>

            {/* Render sub-groups when parent not collapsed */}
            {(isSearching || !group.collapsed) && getSubGroups(group.id)
              .filter(subGroup => !filter.active || filter.visibleGroupIds.has(subGroup.id))
              .map(subGroup => (
              <li
                key={subGroup.id}
                className={`group sub-group ${draggedItem?.type === 'group' && draggedItem.id === subGroup.id ? 'dragging' : ''} ${dropTarget?.type === 'group' && dropTarget.id === subGroup.id ? `drop-${dropTarget.position}` : ''}`}
                draggable={!isSearching}
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
                    disabled={isSearching}
                    title={chevronTitle(subGroup.collapsed, isSearching)}
                    aria-label={chevronAriaLabel(subGroup.collapsed, isSearching, 'sub-group')}
                  >
                    {subGroup.collapsed && !isSearching ? '▶' : '▼'}
                  </button>
                  <button
                    className="group-color sub-group-color"
                    style={{ borderColor: subGroup.color }}
                    onClick={() => setColorPickerGroupId(colorPickerGroupId === subGroup.id ? null : subGroup.id)}
                    title="Change color"
                    aria-label="Change sub-group color"
                  />
                  {colorPickerGroupId === subGroup.id && (
                    <GroupColorPicker colors={GROUP_COLORS} selected={subGroup.color} onSelect={(color) => handleColorSelect(subGroup.id, color)} />
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
                {(isSearching || !subGroup.collapsed) && (
                  <ul
                    className={`group-sessions ${dropTarget?.id === `group:${subGroup.id}` ? 'drop-target' : ''}`}
                    onDragOver={(e) => handleGroupAreaDragOver(e, subGroup.id)}
                    onDrop={(e) => handleGroupAreaDrop(e, subGroup.id)}
                  >
                  {getSessionsByGroup(subGroup.id)
                    .filter(session => !filter.active || filter.visibleSessionIds.has(session.id))
                    .sort((a, b) => a.order - b.order).map(session => (
                    <SessionRow key={session.id} {...sessionRowProps(session, subGroup.id)} />
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        ))}

      </aside>

      <main className="main">
        <ViewSwitcher value={contentView} onChange={setContentView} shortcutPrefix={appMod} />
        {contentView === 'analytics' && (
          <AnalyticsPanel
            onClose={() => setContentView('terminal')}
            activeSessionId={activeSessionId}
          />
        )}
        {contentView === 'arena' && (
          <ArenaPanel
            onClose={() => setContentView('terminal')}
            groups={groups}
            initialGroupId={arenaGroupId}
          />
        )}
        {/* The terminal area is HIDDEN, never unmounted, when another view is
            selected. Unmounting would dispose every xterm instance and kill the
            PTYs, so switching tabs would visually reset all live sessions.
            display:none also takes the panel out of the accessibility tree, so
            the inactive tabpanel is not announced — no `hidden` attr needed. */}
        <div
          className="terminal-area"
          id="view-panel-terminal"
          role="tabpanel"
          aria-labelledby="view-tab-terminal"
          style={{ display: contentView === 'terminal' ? undefined : 'none' }}
        >
          {sessions.map(session => (
            <div
              key={session.id}
              className="terminal-wrapper"
              style={{ display: session.id === activeSessionId ? 'flex' : 'none' }}
            >
              <TerminalHeader
                session={session}
                account={accountIndicatorFor(session)}
                onRename={(name) => {
                  updateSession(session.id, { name });
                }}
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


      {/* Binds this machine to a relay account. Rendered last so it sits above
          anything else that happens to be open — it must be answered. */}
      <OwnerConfirmModal
        pending={pendingOwner}
        onConfirm={handleConfirmOwner}
        onReject={handleRejectOwner}
      />

      {/* One at a time: two people asking at once is rare, and stacking
          consent prompts invites answering the wrong one. */}
      <GuestJoinRequestModal
        request={pendingShares[0] ?? null}
        onApprove={handleApproveShare}
        onDeny={handleDenyShare}
      />

      <ShareSessionModal
        sessionId={sharingSession?.id ?? null}
        sessionName={sharingSession?.name ?? ''}
        onClose={() => setSharingSession(null)}
      />

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

      {/* Settings modal — also hosts the Claude accounts tab now that the
          sidebar key button is gone (the "Claude Accounts..." menu item
          deep-links straight to it). */}
      <SettingsModal
        isOpen={settingsOpen}
        initialTab={settingsInitialTab}
        onClose={() => setSettingsOpen(false)}
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
              <button className="btn btn-secondary" onClick={() => setConfirmAction(null)}>
                {confirmAction.type === 'restartForAccountSwitch' ? 'Not now' : 'Cancel'}
              </button>
              {/* Closing a session or deleting a group destroys something; a
                  restart to apply an account switch just re-runs it, so it
                  shouldn't wear the danger styling that says otherwise. */}
              <button className={`btn ${confirmAction.type === 'restartForAccountSwitch' ? 'btn-primary' : 'btn-danger'}`} onClick={() => {
                if (confirmAction.type === 'closeSession') doRemoveSession(confirmAction.id);
                if (confirmAction.type === 'deleteGroup') doDeleteGroup(confirmAction.id);
                if (confirmAction.type === 'restartForAccountSwitch') restartSessions(confirmAction.sessionIds ?? []);
                setConfirmAction(null);
              }}>
                {confirmAction.type === 'restartForAccountSwitch' ? 'Restart' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
