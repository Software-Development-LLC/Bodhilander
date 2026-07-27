import { Group, Session, SessionEvent, SessionStats, GlobalStats, ClaudeAccount, ProviderStatus, ProviderInstallHint, ArenaRun, ArenaUpdate, KeyVaultStatus, RelayStatus } from '../shared/types';

interface ElectronAPI {
  platform: string;
  homedir: string;

  // PTY operations
  createSession: (id: string, cwd: string, launchClaude?: boolean, providerId?: string) => Promise<void>;
  writeToSession: (id: string, data: string) => void;
  resizeSession: (id: string, cols: number, rows: number) => void;
  killSession: (id: string) => void;
  primePty: (id: string) => void;

  // PTY events
  onPtyData: (callback: (id: string, data: string) => void) => () => void;
  onPtyExit: (callback: (id: string, exitCode: number) => void) => () => void;
  onPtyResize: (callback: (id: string, cols: number, rows: number) => void) => () => void;
  onStateChange: (callback: (event: { sessionId: string; state: string; event: string; timestamp: number }) => void) => () => void;
  onSessionsRefresh: (callback: () => void) => () => void;
  onGroupsRefresh: (callback: () => void) => () => void;

  // Menu events
  onMenuNewSession: (callback: () => void) => () => void;
  onMenuCloseSession: (callback: () => void) => () => void;
  onMenuNextSession: (callback: () => void) => () => void;
  onMenuPrevSession: (callback: () => void) => () => void;
  onMenuNextWaiting: (callback: () => void) => () => void;
  onMenuOpenAccounts: (callback: () => void) => () => void;

  // View menu events — content-area switcher + sidebar focus
  onMenuViewTerminal: (callback: () => void) => () => void;
  onMenuViewAnalytics: (callback: () => void) => () => void;
  onMenuViewArena: (callback: () => void) => () => void;
  onMenuFocusSidebar: (callback: () => void) => () => void;

  // Edit menu events
  onMenuCopy: (callback: () => void) => () => void;
  onMenuPaste: (callback: () => void) => () => void;
  onMenuSelectAll: (callback: () => void) => () => void;
  onMenuClearTerminal: (callback: () => void) => () => void;

  // Session selection
  onSessionSelect: (callback: (sessionId: string) => void) => () => void;
  onOpenSettings: (callback: () => void) => () => void;

  // Dialogs
  selectDirectory: (defaultPath?: string) => Promise<string | null>;

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

  // Shell
  openExternal: (url: string) => Promise<void>;
  detectProviders: () => Promise<ProviderStatus[]>;
  runProviderInstall: (providerId: string) => Promise<{ ptyId: string; command: string }>;
  cancelProviderInstall: (ptyId: string) => Promise<void>;
  onProviderInstallHint: (callback: (hint: ProviderInstallHint) => void) => () => void;
  vaultList: () => Promise<KeyVaultStatus[]>;
  vaultSetKey: (providerId: string, key: string) => Promise<void>;
  vaultDeleteKey: (providerId: string) => Promise<void>;
  vaultSetUseKey: (providerId: string, use: boolean) => Promise<void>;
  vaultTestKey: (providerId: string) => Promise<{ ok: boolean; status: number | null; error: string | null }>;
  arenaStart: (prompt: string, contestants: string[], workingDir?: string | null) => Promise<ArenaRun>;
  arenaLaunch: (runId: string) => Promise<void>;
  arenaFollowUp: (runId: string, prompt: string) => Promise<ArenaRun>;
  arenaCancel: (runId: string) => Promise<void>;
  arenaListRuns: () => Promise<ArenaRun[]>;
  arenaGetRun: (id: string) => Promise<ArenaRun | null>;
  onArenaUpdate: (callback: (update: ArenaUpdate) => void) => () => void;

  // Remote Hosting (Relay)
  relayGetStatus: () => Promise<RelayStatus>;
  relayEnable: () => Promise<RelayStatus>;
  relayDisable: () => Promise<RelayStatus>;
  relaySetUrl: (url: string) => Promise<RelayStatus>;
  relayGenerateLinkCode: (machineName: string) => Promise<{ code: string; expiresAt: number }>;
  relaySetKeepAwake: (on: boolean) => Promise<RelayStatus>;
  onRelayStatus: (callback: (status: RelayStatus) => void) => () => void;

  // Sound notifications
  testSound: (event: 'waiting' | 'error' | 'start' | 'complete') => Promise<void>;
  selectSoundFile: () => Promise<string | null>;
  onSoundPlay: (callback: (data: { path: string; volume: number }) => void) => () => void;

  // Mobile API Server
  apiStart: (config?: { port?: number }) => Promise<any>;
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

  // Vector Search

  // Editor Integration
  openInEditor: (filePath: string, line?: number, column?: number) => Promise<{ success: boolean; error?: string }>;
  detectAvailableEditors: () => Promise<string[]>;
  getEditorOptions: () => Promise<{ value: string; label: string }[]>;

  // Error logging
  logError: (source: string, message: string, stack?: string) => Promise<void>;
  logWarn: (source: string, message: string) => Promise<void>;
  getLogPaths: () => Promise<{ logFile: string | null; crashDumps: string }>;

  // Claude accounts (BDHLNDR-31)
  listAccounts: () => Promise<ClaudeAccount[]>;
  startAccountLogin: (label: string) => Promise<{ account: ClaudeAccount; ptyId: string }>;
  cancelAccountLogin: (ptyId: string, deleteAccount: boolean) => Promise<void>;
  confirmAccountLoginMacOS: (ptyId: string) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  updateAccount: (id: string, updates: { label?: string; color?: string; email?: string | null }) => Promise<void>;
  setDefaultAccount: (id: string) => Promise<void>;
  onAccountLoginCompleted: (callback: (data: { accountId: string; email: string | null }) => void) => () => void;
  onAccountLoginExited: (callback: (data: { accountId: string; exitCode: number }) => void) => () => void;

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
