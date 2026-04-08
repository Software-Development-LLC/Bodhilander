import { contextBridge, ipcRenderer } from 'electron';
import { Group, Session, Memory, MemoryCreateInput, MemoryUpdateInput, CodeIndex, CodeSearchResult, SymbolSearchResult, IndexProgress, SymbolType, SessionEvent, SessionStats, GlobalStats } from '../shared/types';

// Get homedir from environment since os module isn't available in sandbox
const homedir = process.env.HOME || process.env.USERPROFILE || '/';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  homedir,

  // PTY operations
  createSession: (id: string, cwd: string, launchClaude: boolean = false) =>
    ipcRenderer.invoke('pty:create', id, cwd, launchClaude),
  writeToSession: (id: string, data: string) =>
    ipcRenderer.send('pty:write', id, data),
  resizeSession: (id: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', id, cols, rows),
  killSession: (id: string) =>
    ipcRenderer.send('pty:kill', id),

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
  onStateChange: (callback: (event: { sessionId: string; state: string; event: string; timestamp: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: any) => callback(event);
    ipcRenderer.on('state:change', listener);
    return () => {
      ipcRenderer.removeListener('state:change', listener);
    };
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
  onMenuFind: (callback: () => void) => {
    ipcRenderer.on('menu:find', callback);
    return () => ipcRenderer.removeListener('menu:find', callback);
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
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectDirectory'),

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

  // Database - Memories
  getMemoriesBySession: (sessionId: string): Promise<Memory[]> =>
    ipcRenderer.invoke('db:memories:getBySession', sessionId),
  getMemoriesByGroup: (groupId: string): Promise<Memory[]> =>
    ipcRenderer.invoke('db:memories:getByGroup', groupId),
  getPinnedMemories: (groupId?: string): Promise<Memory[]> =>
    ipcRenderer.invoke('db:memories:getPinned', groupId),
  searchMemories: (query: string, groupId?: string): Promise<Memory[]> =>
    ipcRenderer.invoke('db:memories:search', query, groupId),
  createMemory: (input: MemoryCreateInput): Promise<Memory> =>
    ipcRenderer.invoke('db:memories:create', input),
  updateMemory: (id: string, updates: MemoryUpdateInput): Promise<void> =>
    ipcRenderer.invoke('db:memories:update', id, updates),
  deleteMemory: (id: string): Promise<void> =>
    ipcRenderer.invoke('db:memories:delete', id),
  getMemoriesForInjection: (sessionId: string, groupId: string): Promise<Memory[]> =>
    ipcRenderer.invoke('db:memories:getForInjection', sessionId, groupId),
  getMemoryById: (id: string): Promise<Memory | null> =>
    ipcRenderer.invoke('db:memories:getById', id),
  getGlobalContextMemories: (): Promise<Memory[]> =>
    ipcRenderer.invoke('db:memories:getGlobal'),
  onMemoryExtracted: (callback: (memory: Memory) => void) => {
    const listener = (_: Electron.IpcRendererEvent, memory: Memory) => callback(memory);
    ipcRenderer.on('memory:extracted', listener);
    return () => ipcRenderer.removeListener('memory:extracted', listener);
  },

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
  exportGroups: (): Promise<{ success: boolean; filePath?: string; error?: string; groupCount?: number; sessionCount?: number }> =>
    ipcRenderer.invoke('export:groups'),
  importGroups: (): Promise<{ success: boolean; error?: string; groupCount?: number; sessionCount?: number; skippedGroups?: number; skippedSessions?: number }> =>
    ipcRenderer.invoke('import:groups'),
  importFromClaudeLander: (): Promise<{ success: boolean; error?: string; groupCount?: number; sessionCount?: number; skippedGroups?: number; skippedSessions?: number }> =>
    ipcRenderer.invoke('import:fromClaudeLander'),

  // Preferences
  getPreference: (key: string): Promise<string | null> =>
    ipcRenderer.invoke('prefs:get', key),
  setPreference: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('prefs:set', key, value),
  getAllPreferences: (): Promise<Record<string, string>> =>
    ipcRenderer.invoke('prefs:getAll'),

  // Auth
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getUser: () => ipcRenderer.invoke('auth:getUser'),
  setAuthToken: (token: string) => ipcRenderer.invoke('auth:setToken', token),
  onAuthChanged: (callback: (data: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('auth:changed', listener);
    return () => ipcRenderer.removeListener('auth:changed', listener);
  },
  onAuthError: (callback: (data: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('auth:error', listener);
    return () => ipcRenderer.removeListener('auth:error', listener);
  },

  // Sharing (host)
  startSharing: (sessionId: string) => ipcRenderer.invoke('share:start', sessionId),
  stopSharing: (sessionId: string) => ipcRenderer.invoke('share:stop', sessionId),
  createShareCode: (sessionId: string, options: any) =>
    ipcRenderer.invoke('share:createCode', sessionId, options),
  revokeShareCode: (code: string) => ipcRenderer.invoke('share:revokeCode', code),
  getShareCodes: (sessionId: string) => ipcRenderer.invoke('share:getCodes', sessionId),
  isSharing: (sessionId: string) => ipcRenderer.invoke('share:isSharing', sessionId),
  getGuestCount: (sessionId: string) => ipcRenderer.invoke('share:getGuestCount', sessionId),
  onGuestJoined: (callback: (info: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, info: any) => callback(info);
    ipcRenderer.on('share:guestJoined', listener);
    return () => ipcRenderer.removeListener('share:guestJoined', listener);
  },
  onGuestLeft: (callback: (info: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, info: any) => callback(info);
    ipcRenderer.on('share:guestLeft', listener);
    return () => ipcRenderer.removeListener('share:guestLeft', listener);
  },

  // Sharing (guest)
  joinSession: (code: string) => ipcRenderer.invoke('share:join', code),
  leaveSession: (code: string) => ipcRenderer.invoke('share:leave', code),
  writeToRemote: (code: string, data: string) =>
    ipcRenderer.invoke('share:write', code, data),
  onShareData: (callback: (data: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('share:data', listener);
    return () => ipcRenderer.removeListener('share:data', listener);
  },
  onShareEnded: (callback: (data: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on('share:ended', listener);
    return () => ipcRenderer.removeListener('share:ended', listener);
  },

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

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

  // Mobile API Server
  apiStart: (config?: { port?: number; enableMdns?: boolean }) =>
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

  // Remote access
  apiEnableRemoteAccess: (): Promise<{
    success: boolean;
    status?: {
      enabled: boolean;
      connected: boolean;
      desktopId: string | null;
      relayUrl: string;
    };
    error?: string;
  }> => ipcRenderer.invoke('api:enableRemoteAccess'),
  apiDisableRemoteAccess: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('api:disableRemoteAccess'),
  apiGetRemoteAccessStatus: (): Promise<{
    enabled: boolean;
    connected: boolean;
    desktopId: string | null;
    relayUrl: string;
  }> => ipcRenderer.invoke('api:getRemoteAccessStatus'),

  // Vector Search
  getIndexStatus: (directoryPath: string): Promise<CodeIndex | null> =>
    ipcRenderer.invoke('vector-search:get-index-status', directoryPath),

  getAllIndexes: (): Promise<CodeIndex[]> =>
    ipcRenderer.invoke('vector-search:get-all-indexes'),

  startIndexing: (directoryPath: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('vector-search:start-indexing', directoryPath),

  searchCode: (directoryPath: string, query: string, limit?: number): Promise<CodeSearchResult[]> =>
    ipcRenderer.invoke('vector-search:search-code', directoryPath, query, limit),

  searchSymbols: (directoryPath: string, name: string, symbolType?: SymbolType, limit?: number): Promise<SymbolSearchResult[]> =>
    ipcRenderer.invoke('vector-search:search-symbols', directoryPath, name, symbolType, limit),

  cancelIndexing: (indexId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('vector-search:cancel-indexing', indexId),

  deleteCodeIndex: (directoryPath: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('vector-search:delete-index', directoryPath),

  retryIndexing: (directoryPath: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('vector-search:retry-indexing', directoryPath),

  onIndexingProgress: (callback: (progress: IndexProgress) => void) => {
    const listener = (_: Electron.IpcRendererEvent, progress: IndexProgress) => callback(progress);
    ipcRenderer.on('vector-search:progress', listener);
    return () => ipcRenderer.removeListener('vector-search:progress', listener);
  },

  onIndexingComplete: (callback: (data: { indexId: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { indexId: string }) => callback(data);
    ipcRenderer.on('vector-search:complete', listener);
    return () => ipcRenderer.removeListener('vector-search:complete', listener);
  },

  onIndexingError: (callback: (data: { indexId: string; error: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { indexId: string; error: string }) => callback(data);
    ipcRenderer.on('vector-search:error', listener);
    return () => ipcRenderer.removeListener('vector-search:error', listener);
  },

  // Editor Integration
  openInEditor: (filePath: string, line?: number, column?: number): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('editor:open', filePath, line, column),

  detectAvailableEditors: (): Promise<string[]> =>
    ipcRenderer.invoke('editor:detectAvailable'),

  getEditorOptions: (): Promise<{ value: string; label: string }[]> =>
    ipcRenderer.invoke('editor:getOptions'),
});
