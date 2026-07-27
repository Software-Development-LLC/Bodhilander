import {
  Group,
  Session,
  ApiServerStatus,
  PairingCode,
  PairedDevice,
  ApiServerConfig,
  DevicePermissions,
  SessionEvent,
  SessionStats,
  GlobalStats,
} from '../../shared/types';

interface StateChangeEvent {
  sessionId: string;
  state: string;
  event: string;
  timestamp: number;
}

export interface ElectronAPI {
  platform: string;
  homedir: string;
  createSession: (id: string, cwd: string, launchClaude?: boolean, providerId?: string) => Promise<void>;
  writeToSession: (id: string, data: string) => void;
  resizeSession: (id: string, cols: number, rows: number) => void;
  killSession: (id: string) => void;
  onPtyData: (callback: (id: string, data: string) => void) => () => void;
  onPtyExit: (callback: (id: string, exitCode: number) => void) => () => void;
  onPtyResize: (callback: (id: string, cols: number, rows: number) => void) => () => void;
  onStateChange: (callback: (event: StateChangeEvent) => void) => () => void;

  // Menu events
  onMenuNewSession: (callback: () => void) => () => void;
  onMenuCloseSession: (callback: () => void) => () => void;
  onMenuNextSession: (callback: () => void) => () => void;
  onMenuPrevSession: (callback: () => void) => () => void;
  onMenuNextWaiting: (callback: () => void) => () => void;

  // Session selection from notifications/tray
  onSessionSelect: (callback: (sessionId: string) => void) => () => void;

  // Settings modal
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

  // Sound notifications
  testSound: (event: 'waiting' | 'error' | 'start' | 'complete') => Promise<void>;
  selectSoundFile: () => Promise<string | null>;
  onSoundPlay: (callback: (data: { path: string; volume: number }) => void) => () => void;

  // Mobile API Server
  apiStart: (config?: ApiServerConfig) => Promise<void>;
  apiStop: () => Promise<void>;
  apiGetStatus: () => Promise<ApiServerStatus>;
  apiGeneratePairingCode: (options?: DevicePermissions) => Promise<{
    success: boolean;
    code?: string;
    qrCode?: string;
    expiresAt?: number;
    addresses?: string[];
    port?: number;
    error?: string;
  }>;
  apiCancelPairing: () => Promise<void>;
  apiGetPairedDevices: () => Promise<PairedDevice[]>;
  apiUnpairDevice: (deviceId: string) => Promise<void>;
  apiUpdateDevicePermissions: (deviceId: string, permissions: DevicePermissions) => Promise<void>;
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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
