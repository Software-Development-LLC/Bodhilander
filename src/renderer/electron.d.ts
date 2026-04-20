import { Group, Session, Memory, MemoryCreateInput, MemoryUpdateInput, CodeIndex, CodeSearchResult, SymbolSearchResult, IndexProgress, SymbolType, SessionEvent, SessionStats, GlobalStats } from '../shared/types';

interface ElectronAPI {
  platform: string;
  homedir: string;

  // PTY operations
  createSession: (id: string, cwd: string, launchClaude?: boolean) => Promise<void>;
  writeToSession: (id: string, data: string) => void;
  resizeSession: (id: string, cols: number, rows: number) => void;
  killSession: (id: string) => void;

  // PTY events
  onPtyData: (callback: (id: string, data: string) => void) => () => void;
  onPtyExit: (callback: (id: string, exitCode: number) => void) => () => void;
  onStateChange: (callback: (event: { sessionId: string; state: string; event: string; timestamp: number }) => void) => () => void;

  // Menu events
  onMenuNewSession: (callback: () => void) => () => void;
  onMenuCloseSession: (callback: () => void) => () => void;
  onMenuNextSession: (callback: () => void) => () => void;
  onMenuPrevSession: (callback: () => void) => () => void;
  onMenuNextWaiting: (callback: () => void) => () => void;

  // Edit menu events
  onMenuCopy: (callback: () => void) => () => void;
  onMenuPaste: (callback: () => void) => () => void;
  onMenuSelectAll: (callback: () => void) => () => void;
  onMenuClearTerminal: (callback: () => void) => () => void;
  onMenuFind: (callback: () => void) => () => void;

  // Session selection
  onSessionSelect: (callback: (sessionId: string) => void) => () => void;
  onOpenSettings: (callback: () => void) => () => void;

  // Dialogs
  selectDirectory: () => Promise<string | null>;

  // Database - Groups
  getAllGroups: () => Promise<Group[]>;
  createGroup: (group: Group) => Promise<void>;
  updateGroup: (id: string, updates: Partial<Group>) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;

  // Database - Sessions
  getAllSessions: () => Promise<Session[]>;
  createDbSession: (session: Session) => Promise<void>;
  updateDbSession: (id: string, updates: Partial<Session>) => Promise<void>;
  deleteDbSession: (id: string) => Promise<void>;

  // Database - Memories
  getMemoriesBySession: (sessionId: string) => Promise<Memory[]>;
  getMemoriesByGroup: (groupId: string) => Promise<Memory[]>;
  getPinnedMemories: (groupId?: string) => Promise<Memory[]>;
  searchMemories: (query: string, groupId?: string) => Promise<Memory[]>;
  createMemory: (input: MemoryCreateInput) => Promise<Memory>;
  updateMemory: (id: string, updates: MemoryUpdateInput) => Promise<void>;
  deleteMemory: (id: string) => Promise<void>;
  getMemoriesForInjection: (sessionId: string, groupId: string) => Promise<Memory[]>;
  getMemoryById: (id: string) => Promise<Memory | null>;
  getGlobalContextMemories: () => Promise<Memory[]>;
  onMemoryExtracted: (callback: (memory: Memory) => void) => () => void;

  // Session Events (BDHLNDR-17)
  getSessionEvents: (sessionId: string, limit?: number) => Promise<SessionEvent[]>;
  getSessionStats: (sessionId: string) => Promise<SessionStats>;
  getGlobalStats: (since?: string) => Promise<GlobalStats>;
  getToolUseCounts: (sessionId?: string) => Promise<Record<string, number>>;

  // Session Export (BDHLNDR-20)
  exportSessions: (format: 'csv' | 'json', since?: string) => Promise<{ success: boolean; filePath?: string; error?: string; sessionCount?: number; eventCount?: number }>;

  // Group & Session Import/Export
  exportGroups: () => Promise<{ success: boolean; filePath?: string; error?: string; groupCount?: number; sessionCount?: number }>;
  importGroups: () => Promise<{ success: boolean; error?: string; groupCount?: number; sessionCount?: number; skippedGroups?: number; skippedSessions?: number }>;
  importFromClaudeLander: () => Promise<{ success: boolean; error?: string; groupCount?: number; sessionCount?: number; skippedGroups?: number; skippedSessions?: number }>;

  // Preferences
  getPreference: (key: string) => Promise<string | null>;
  setPreference: (key: string, value: string) => Promise<void>;
  getAllPreferences: () => Promise<Record<string, string>>;

  // Auth
  login: () => Promise<any>;
  logout: () => Promise<any>;
  getUser: () => Promise<any>;
  setAuthToken: (token: string) => Promise<any>;
  onAuthChanged: (callback: (data: any) => void) => () => void;
  onAuthError: (callback: (data: any) => void) => () => void;

  // Sharing (host)
  startSharing: (sessionId: string) => Promise<any>;
  stopSharing: (sessionId: string) => Promise<any>;
  createShareCode: (sessionId: string, options: any) => Promise<any>;
  revokeShareCode: (code: string) => Promise<any>;
  getShareCodes: (sessionId: string) => Promise<any>;
  isSharing: (sessionId: string) => Promise<any>;
  getGuestCount: (sessionId: string) => Promise<any>;
  onGuestJoined: (callback: (info: any) => void) => () => void;
  onGuestLeft: (callback: (info: any) => void) => () => void;

  // Sharing (guest)
  joinSession: (code: string) => Promise<any>;
  leaveSession: (code: string) => Promise<any>;
  writeToRemote: (code: string, data: string) => Promise<any>;
  onShareData: (callback: (data: any) => void) => () => void;
  onShareEnded: (callback: (data: any) => void) => () => void;

  // Shell
  openExternal: (url: string) => Promise<void>;

  // Sound notifications
  testSound: (event: 'waiting' | 'error' | 'start' | 'complete') => Promise<void>;
  selectSoundFile: () => Promise<string | null>;
  onSoundPlay: (callback: (data: { path: string; volume: number }) => void) => () => void;

  // Mobile API Server
  apiStart: (config?: { port?: number; enableMdns?: boolean }) => Promise<any>;
  apiStop: () => Promise<any>;
  apiGetStatus: () => Promise<{ running: boolean; port?: number; address?: string }>;
  apiGeneratePairingCode: (options?: { canControl?: boolean; canModify?: boolean }) => Promise<{
    success: boolean;
    code?: string;
    qrCode?: string;
    expiresAt?: number;
    addresses?: string[];
    port?: number;
    error?: string;
  }>;
  apiCancelPairing: () => Promise<any>;
  apiGetPairedDevices: () => Promise<Array<{
    id: string;
    name: string;
    platform: string;
    createdAt: string;
    lastUsedAt: string;
    canControl: boolean;
    canModify: boolean;
  }>>;
  apiUnpairDevice: (deviceId: string) => Promise<any>;
  apiUpdateDevicePermissions: (deviceId: string, permissions: { canControl?: boolean; canModify?: boolean }) => Promise<any>;
  apiHasPairingCode: () => Promise<{ active: boolean }>;

  // Remote access
  apiEnableRemoteAccess: () => Promise<{ success: boolean; status?: any; error?: string }>;
  apiDisableRemoteAccess: () => Promise<{ success: boolean; error?: string }>;
  apiGetRemoteAccessStatus: () => Promise<{ enabled: boolean; connected: boolean; desktopId: string | null; relayUrl: string }>;

  // Vector Search
  getIndexStatus: (directoryPath: string) => Promise<CodeIndex | null>;
  getAllIndexes: () => Promise<CodeIndex[]>;
  startIndexing: (directoryPath: string) => Promise<{ success: boolean; error?: string }>;
  searchCode: (directoryPath: string, query: string, limit?: number) => Promise<CodeSearchResult[]>;
  searchSymbols: (directoryPath: string, name: string, symbolType?: SymbolType, limit?: number) => Promise<SymbolSearchResult[]>;
  cancelIndexing: (indexId: string) => Promise<{ success: boolean }>;
  deleteCodeIndex: (directoryPath: string) => Promise<{ success: boolean }>;
  retryIndexing: (directoryPath: string) => Promise<{ success: boolean; error?: string }>;
  onIndexingProgress: (callback: (progress: IndexProgress) => void) => () => void;
  onIndexingComplete: (callback: (data: { indexId: string; directoryPath?: string }) => void) => () => void;
  onIndexingError: (callback: (data: { indexId: string; error: string; directoryPath?: string }) => void) => () => void;

  // Editor Integration
  openInEditor: (filePath: string, line?: number, column?: number) => Promise<{ success: boolean; error?: string }>;
  detectAvailableEditors: () => Promise<string[]>;
  getEditorOptions: () => Promise<{ value: string; label: string }[]>;

  // Error logging
  logError: (source: string, message: string, stack?: string) => Promise<void>;
  logWarn: (source: string, message: string) => Promise<void>;
  getLogPaths: () => Promise<{ logFile: string | null; crashDumps: string }>;

  // Update channel (BDHLNDR-32)
  getUpdateChannel: () => Promise<'stable' | 'beta'>;
  setUpdateChannel: (channel: 'stable' | 'beta') => Promise<'stable' | 'beta'>;
  isPrereleaseBuild: () => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
