import { contextBridge, ipcRenderer } from 'electron';
import { Group, Session, SessionEvent, SessionStats, GlobalStats, ClaudeAccount, AccountSwitchResult, AccountFailoverEvent, LiveAccountBinding, LiveAccountBindings, ProviderStatus, ProviderInstallHint, ArenaRun, ArenaUpdate, KeyVaultStatus, RelayStatus, RelayShare, RelayResizeRequest, PortableExportResult, PortableImportResult } from '../shared/types';

// Get homedir from environment since os module isn't available in sandbox
const homedir = process.env.HOME || process.env.USERPROFILE || '/';

/** `verified` is false when only the user's button says the login happened. */
interface LoginCompleted {
  accountId: string;
  email: string | null;
  verified: boolean;
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  homedir,

  // PTY operations
  createSession: (id: string, cwd: string, launchClaude: boolean = false, providerId?: string) =>
    ipcRenderer.invoke('pty:create', id, cwd, launchClaude, providerId),
  writeToSession: (id: string, data: string) =>
    ipcRenderer.send('pty:write', id, data),
  resizeSession: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', id, cols, rows),
  killSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('pty:kill', id),
  primePty: (id: string) =>
    ipcRenderer.send('pty:prime', id),
  getLiveAccounts: (): Promise<LiveAccountBindings> =>
    ipcRenderer.invoke('pty:get-live-accounts'),
  onPtyLiveAccount: (callback: (sessionId: string, binding: LiveAccountBinding | null) => void) => {
    const listener = (_: Electron.IpcRendererEvent, sessionId: string, binding: LiveAccountBinding | null) =>
      callback(sessionId, binding);
    ipcRenderer.on('pty:live-account', listener);
    return () => ipcRenderer.removeListener('pty:live-account', listener);
  },

  // PTY events
  onPtyData: (callback: (id: string, data: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, data: string) => callback(id, data);
    ipcRenderer.on('pty:data', listener);
    return () => {
      ipcRenderer.removeListener('pty:data', listener);
    };
  },
  onPtyExit: (callback: (id: string, exitCode: number) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, exitCode: number) => callback(id, exitCode);
    ipcRenderer.on('pty:exit', listener);
    return () => {
      ipcRenderer.removeListener('pty:exit', listener);
    };
  },
  // A guest asked for a session to be resized to fit their screen. A request,
  // not a resize: the prompt it raises is what decides, and declining changes
  // nothing on either end.
  onRelayResizeRequest: (callback: (request: RelayResizeRequest) => void) => {
    const listener = (_: Electron.IpcRendererEvent, request: RelayResizeRequest) => callback(request);
    ipcRenderer.on('relay:resize-request', listener);
    return () => {
      ipcRenderer.removeListener('relay:resize-request', listener);
    };
  },
  // Dynamic sizing: the PTY was resized (possibly by a remote/mobile viewer).
  onPtyResize: (callback: (id: string, cols: number, rows: number) => void) => {
    const listener = (_: Electron.IpcRendererEvent, id: string, cols: number, rows: number) => callback(id, cols, rows);
    ipcRenderer.on('pty:resized', listener);
    return () => {
      ipcRenderer.removeListener('pty:resized', listener);
    };
  },
  onStateChange: (callback: (event: { sessionId: string; state: string; event: string; timestamp: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: any) => callback(event);
    ipcRenderer.on('state:change', listener);
    return () => {
      ipcRenderer.removeListener('state:change', listener);
    };
  },
  onSessionsRefresh: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('sessions:refresh', listener);
    return () => ipcRenderer.removeListener('sessions:refresh', listener);
  },
  onGroupsRefresh: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('groups:refresh', listener);
    return () => ipcRenderer.removeListener('groups:refresh', listener);
  },

  // Menu events
  onMenuNewSession: (callback: () => void) => {
    ipcRenderer.on('menu:new-session', callback);
    return () => ipcRenderer.removeListener('menu:new-session', callback);
  },
  onMenuCloseSession: (callback: () => void) => {
    ipcRenderer.on('menu:close-session', callback);
    return () => ipcRenderer.removeListener('menu:close-session', callback);
  },
  onMenuNextSession: (callback: () => void) => {
    ipcRenderer.on('menu:next-session', callback);
    return () => ipcRenderer.removeListener('menu:next-session', callback);
  },
  onMenuPrevSession: (callback: () => void) => {
    ipcRenderer.on('menu:prev-session', callback);
    return () => ipcRenderer.removeListener('menu:prev-session', callback);
  },
  onMenuNextWaiting: (callback: () => void) => {
    ipcRenderer.on('menu:next-waiting', callback);
    return () => ipcRenderer.removeListener('menu:next-waiting', callback);
  },
  onMenuOpenAccounts: (callback: () => void) => {
    ipcRenderer.on('menu:open-accounts', callback);
    return () => ipcRenderer.removeListener('menu:open-accounts', callback);
  },

  // View switcher — the content area is one of terminal/analytics/arena, driven
  // from the View menu so the accelerators live with the OS instead of being
  // swallowed by the renderer's keydown handler.
  onMenuViewTerminal: (callback: () => void) => {
    ipcRenderer.on('menu:view-terminal', callback);
    return () => ipcRenderer.removeListener('menu:view-terminal', callback);
  },
  onMenuViewAnalytics: (callback: () => void) => {
    ipcRenderer.on('menu:view-analytics', callback);
    return () => ipcRenderer.removeListener('menu:view-analytics', callback);
  },
  onMenuViewArena: (callback: () => void) => {
    ipcRenderer.on('menu:view-arena', callback);
    return () => ipcRenderer.removeListener('menu:view-arena', callback);
  },
  onMenuFocusSidebar: (callback: () => void) => {
    ipcRenderer.on('menu:focus-sidebar', callback);
    return () => ipcRenderer.removeListener('menu:focus-sidebar', callback);
  },

  // Edit menu events
  onMenuCopy: (callback: () => void) => {
    ipcRenderer.on('menu:copy', callback);
    return () => ipcRenderer.removeListener('menu:copy', callback);
  },
  onMenuPaste: (callback: () => void) => {
    ipcRenderer.on('menu:paste', callback);
    return () => ipcRenderer.removeListener('menu:paste', callback);
  },
  onMenuSelectAll: (callback: () => void) => {
    ipcRenderer.on('menu:selectAll', callback);
    return () => ipcRenderer.removeListener('menu:selectAll', callback);
  },
  onMenuClearTerminal: (callback: () => void) => {
    ipcRenderer.on('menu:clearTerminal', callback);
    return () => ipcRenderer.removeListener('menu:clearTerminal', callback);
  },

  // Session selection from notifications/tray
  onSessionSelect: (callback: (sessionId: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId);
    ipcRenderer.on('session:select', listener);
    return () => ipcRenderer.removeListener('session:select', listener);
  },

  // Settings modal trigger
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('open-settings', listener);
    return () => ipcRenderer.removeListener('open-settings', listener);
  },

  // Dialogs
  selectDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectDirectory', defaultPath),

  // Database - Groups
  getAllGroups: (): Promise<Group[]> =>
    ipcRenderer.invoke('db:groups:getAll'),
  createGroup: (group: Group): Promise<void> =>
    ipcRenderer.invoke('db:groups:create', group),
  updateGroup: (id: string, updates: Partial<Group>): Promise<void> =>
    ipcRenderer.invoke('db:groups:update', id, updates),
  deleteGroup: (id: string): Promise<void> =>
    ipcRenderer.invoke('db:groups:delete', id),

  // Database - Sessions
  getAllSessions: (): Promise<Session[]> =>
    ipcRenderer.invoke('db:sessions:getAll'),
  createDbSession: (session: Session): Promise<void> =>
    ipcRenderer.invoke('db:sessions:create', session),
  updateDbSession: (id: string, updates: Partial<Session>): Promise<void> =>
    ipcRenderer.invoke('db:sessions:update', id, updates),
  deleteDbSession: (id: string): Promise<void> =>
    ipcRenderer.invoke('db:sessions:delete', id),

  // Database - Session Events (BDHLNDR-17)
  getSessionEvents: (sessionId: string, limit?: number): Promise<SessionEvent[]> =>
    ipcRenderer.invoke('db:sessionEvents:getBySession', sessionId, limit),
  getSessionStats: (sessionId: string): Promise<SessionStats> =>
    ipcRenderer.invoke('db:sessionEvents:getSessionStats', sessionId),
  getGlobalStats: (since?: string): Promise<GlobalStats> =>
    ipcRenderer.invoke('db:sessionEvents:getGlobalStats', since),
  getToolUseCounts: (sessionId?: string): Promise<Record<string, number>> =>
    ipcRenderer.invoke('db:sessionEvents:getToolUseCounts', sessionId),

  // Session Export (BDHLNDR-20)
  exportSessions: (format: 'csv' | 'json', since?: string): Promise<{ success: boolean; filePath?: string; error?: string; sessionCount?: number; eventCount?: number }> =>
    ipcRenderer.invoke('export:sessions', format, since),

  // Group & Session Import/Export
  exportGroups: (): Promise<PortableExportResult> =>
    ipcRenderer.invoke('export:groups'),
  importGroups: (): Promise<PortableImportResult> =>
    ipcRenderer.invoke('import:groups'),
  importFromClaudeLander: (): Promise<PortableImportResult> =>
    ipcRenderer.invoke('import:fromClaudeLander'),

  // Preferences
  getPreference: (key: string): Promise<string | null> =>
    ipcRenderer.invoke('prefs:get', key),
  setPreference: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('prefs:set', key, value),
  getAllPreferences: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke('prefs:getAll'),

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  detectProviders: (): Promise<ProviderStatus[]> => ipcRenderer.invoke('providers:detect'),
  runProviderInstall: (providerId: string): Promise<{ ptyId: string; command: string }> =>
    ipcRenderer.invoke('providers:run-install', providerId),
  cancelProviderInstall: (ptyId: string): Promise<void> =>
    ipcRenderer.invoke('providers:cancel-install', ptyId),
  onProviderInstallHint: (callback: (hint: ProviderInstallHint) => void) => {
    const listener = (_: Electron.IpcRendererEvent, hint: ProviderInstallHint) => callback(hint);
    ipcRenderer.on('provider:install-hint', listener);
    return () => {
      ipcRenderer.removeListener('provider:install-hint', listener);
    };
  },

  // Provider API-key vault (#99) — keys go in, never come back out.
  vaultList: (): Promise<KeyVaultStatus[]> => ipcRenderer.invoke('vault:list'),
  vaultSetKey: (providerId: string, key: string): Promise<void> =>
    ipcRenderer.invoke('vault:setKey', providerId, key),
  vaultDeleteKey: (providerId: string): Promise<void> =>
    ipcRenderer.invoke('vault:deleteKey', providerId),
  vaultSetUseKey: (providerId: string, use: boolean): Promise<void> =>
    ipcRenderer.invoke('vault:setUseKey', providerId, use),
  vaultTestKey: (providerId: string): Promise<{ ok: boolean; status: number | null; error: string | null }> =>
    ipcRenderer.invoke('vault:testKey', providerId),

  // Arena mode (#100)
  arenaStart: (prompt: string, contestants: string[], workingDir?: string | null): Promise<ArenaRun> =>
    ipcRenderer.invoke('arena:start', prompt, contestants, workingDir ?? null),
  arenaLaunch: (runId: string): Promise<void> =>
    ipcRenderer.invoke('arena:launch', runId),
  arenaFollowUp: (runId: string, prompt: string): Promise<ArenaRun> =>
    ipcRenderer.invoke('arena:followUp', runId, prompt),
  arenaCancel: (runId: string): Promise<void> =>
    ipcRenderer.invoke('arena:cancel', runId),
  arenaListRuns: (): Promise<ArenaRun[]> =>
    ipcRenderer.invoke('arena:listRuns'),
  arenaGetRun: (id: string): Promise<ArenaRun | null> =>
    ipcRenderer.invoke('arena:getRun', id),
  onArenaUpdate: (callback: (update: ArenaUpdate) => void) => {
    const listener = (_: Electron.IpcRendererEvent, update: ArenaUpdate) => callback(update);
    ipcRenderer.on('arena:update', listener);
    return () => {
      ipcRenderer.removeListener('arena:update', listener);
    };
  },

  // Sound notifications
  testSound: (event: 'waiting' | 'error' | 'start' | 'complete') =>
    ipcRenderer.invoke('sound:test', event),
  selectSoundFile: (): Promise<string | null> =>
    ipcRenderer.invoke('sound:selectFile'),
  onSoundPlay: (callback: (data: { path: string; volume: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { path: string; volume: number }) => callback(data);
    ipcRenderer.on('sound:play', listener);
    return () => ipcRenderer.removeListener('sound:play', listener);
  },

  // Remote Hosting (Relay)
  relayGetStatus: (): Promise<RelayStatus> => ipcRenderer.invoke('relay:getStatus'),
  relayEnable: (): Promise<RelayStatus> => ipcRenderer.invoke('relay:enable'),
  relayDisable: (): Promise<RelayStatus> => ipcRenderer.invoke('relay:disable'),
  relaySetUrl: (url: string): Promise<RelayStatus> => ipcRenderer.invoke('relay:setUrl', url),
  relayGenerateLinkCode: (machineName: string): Promise<{ code: string; expiresAt: number }> =>
    ipcRenderer.invoke('relay:generateLinkCode', machineName),
  relaySetKeepAwake: (on: boolean): Promise<RelayStatus> => ipcRenderer.invoke('relay:setKeepAwake', on),
  relayGetPendingOwner: (): Promise<RelayStatus['pendingOwner']> => ipcRenderer.invoke('relay:getPendingOwner'),
  relayConfirmOwner: (userId: string): Promise<RelayStatus> => ipcRenderer.invoke('relay:confirmOwner', userId),
  relayRejectOwner: (): Promise<RelayStatus> => ipcRenderer.invoke('relay:rejectOwner'),
  relayCreateShare: (input: {
    sessionId: string;
    expectedGithubLogin: string | null;
    role: 'viewer' | 'operator';
    grantTtlSeconds: number;
    inviteTtlSeconds: number;
  }): Promise<{ code: string; url: string; expiresAt: number }> => ipcRenderer.invoke('relay:createShare', input),
  relayApproveShare: (grantId: string, sessionIds?: string[]): Promise<RelayStatus> =>
    ipcRenderer.invoke('relay:approveShare', grantId, sessionIds),
  relayDenyShare: (grantId: string): Promise<RelayStatus> => ipcRenderer.invoke('relay:denyShare', grantId),
  relayRevokeShare: (grantId: string): Promise<RelayStatus> => ipcRenderer.invoke('relay:revokeShare', grantId),
  relayListShares: (): Promise<RelayShare[]> => ipcRenderer.invoke('relay:listShares'),
  onRelayStatus: (callback: (status: RelayStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: RelayStatus) => callback(status);
    ipcRenderer.on('relay:status', listener);
    return () => ipcRenderer.removeListener('relay:status', listener);
  },

  // Mobile API Server
  apiStart: (config?: { port?: number }) =>
    ipcRenderer.invoke('api:start', config),
  apiStop: () => ipcRenderer.invoke('api:stop'),
  apiGetStatus: (): Promise<{ running: boolean; port?: number; address?: string }> =>
    ipcRenderer.invoke('api:getStatus'),
  apiGeneratePairingCode: (options?: { canControl?: boolean; canModify?: boolean }): Promise<{
    success: boolean;
    code?: string;
    qrCode?: string;
    expiresAt?: number;
    addresses?: string[];
    port?: number;
    error?: string;
  }> => ipcRenderer.invoke('api:generatePairingCode', options),
  apiCancelPairing: () => ipcRenderer.invoke('api:cancelPairing'),
  apiGetPairedDevices: (): Promise<Array<{
    id: string;
    name: string;
    platform: string;
    createdAt: string;
    lastUsedAt: string;
    canControl: boolean;
    canModify: boolean;
  }>> => ipcRenderer.invoke('api:getPairedDevices'),
  apiUnpairDevice: (deviceId: string) => ipcRenderer.invoke('api:unpairDevice', deviceId),
  apiUpdateDevicePermissions: (deviceId: string, permissions: { canControl?: boolean; canModify?: boolean }) =>
    ipcRenderer.invoke('api:updateDevicePermissions', deviceId, permissions),
  apiHasPairingCode: (): Promise<{ active: boolean }> => ipcRenderer.invoke('api:hasPairingCode'),


  // Editor Integration
  openInEditor: (filePath: string, line?: number, column?: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('editor:open', filePath, line, column),

  detectAvailableEditors: (): Promise<string[]> =>
    ipcRenderer.invoke('editor:detectAvailable'),

  getEditorOptions: (): Promise<{ value: string; label: string }[]> =>
    ipcRenderer.invoke('editor:getOptions'),

  // Claude accounts (BDHLNDR-31)
  listAccounts: (): Promise<ClaudeAccount[]> =>
    ipcRenderer.invoke('accounts:list'),
  startAccountLogin: (label: string): Promise<{ account: ClaudeAccount; ptyId: string }> =>
    ipcRenderer.invoke('accounts:startLogin', label),
  cancelAccountLogin: (ptyId: string, deleteAccount: boolean): Promise<void> =>
    ipcRenderer.invoke('accounts:cancelLogin', ptyId, deleteAccount),
  confirmAccountLoginMacOS: (ptyId: string): Promise<void> =>
    ipcRenderer.invoke('accounts:confirmLoginMacOS', ptyId),
  deleteAccount: (id: string): Promise<void> =>
    ipcRenderer.invoke('accounts:delete', id),
  updateAccount: (id: string, updates: { label?: string; color?: string; email?: string | null }): Promise<void> =>
    ipcRenderer.invoke('accounts:update', id, updates),
  setDefaultAccount: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('accounts:setDefault', id),
  setAccountFallbackOrder: (orderedIds: string[]): Promise<void> =>
    ipcRenderer.invoke('accounts:setFallbackOrder', orderedIds),
  clearAccountLimit: (id: string): Promise<void> =>
    ipcRenderer.invoke('accounts:clearLimit', id),
  nextAccountInLine: (excludeId: string | null): Promise<ClaudeAccount | null> =>
    ipcRenderer.invoke('accounts:nextInLine', excludeId),
  assignAccountToSession: (sessionId: string, accountId: string | null): Promise<AccountSwitchResult> =>
    ipcRenderer.invoke('accounts:assignToSession', sessionId, accountId),
  assignAccountToGroup: (groupId: string, accountId: string | null): Promise<AccountSwitchResult> =>
    ipcRenderer.invoke('accounts:assignToGroup', groupId, accountId),
  onAccountLoginCompleted: (callback: (data: LoginCompleted) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: LoginCompleted) => callback(data);
    ipcRenderer.on('accounts:login-completed', listener);
    return () => ipcRenderer.removeListener('accounts:login-completed', listener);
  },
  onAccountLoginExited: (callback: (data: { accountId: string; exitCode: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { accountId: string; exitCode: number }) => callback(data);
    ipcRenderer.on('accounts:login-exited', listener);
    return () => ipcRenderer.removeListener('accounts:login-exited', listener);
  },
  // An account hit its usage limit and its sessions were moved (or couldn't be).
  onAccountFailover: (callback: (event: AccountFailoverEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: AccountFailoverEvent) => callback(event);
    ipcRenderer.on('accounts:failover', listener);
    return () => ipcRenderer.removeListener('accounts:failover', listener);
  },

  // Update channel (BDHLNDR-32) — opt-in beta builds
  getUpdateChannel: (): Promise<'stable' | 'beta'> =>
    ipcRenderer.invoke('app:get-update-channel'),
  setUpdateChannel: (channel: 'stable' | 'beta'): Promise<'stable' | 'beta'> =>
    ipcRenderer.invoke('app:set-update-channel', channel),
  isPrereleaseBuild: (): Promise<boolean> =>
    ipcRenderer.invoke('app:is-prerelease-build'),

  // Error logging — forward renderer errors to main process log file
  logError: (source: string, message: string, stack?: string): Promise<void> =>
    ipcRenderer.invoke('log:error', source, message, stack),
  logWarn: (source: string, message: string): Promise<void> =>
    ipcRenderer.invoke('log:warn', source, message),
  getLogPaths: (): Promise<{ logFile: string | null; crashDumps: string }> =>
    ipcRenderer.invoke('log:getPaths'),
});
