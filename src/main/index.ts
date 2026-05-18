import { app, BrowserWindow, ipcMain, dialog, shell, crashReporter } from 'electron';
import * as path from 'path';
import { ptyManager } from './pty-manager';
import { getDatabase, closeDatabase } from './database';
import * as groupsRepo from './repositories/groups';
import * as sessionsRepo from './repositories/sessions';
import * as prefsRepo from './repositories/preferences';
import * as memoriesRepo from './repositories/memories';
import * as sessionEventsRepo from './repositories/session-events';
import * as accountsRepo from './repositories/accounts';
import * as accountAuth from './account-auth';
import { exportSessions, ExportFormat } from './session-export';
import { exportGroupsAndSessions, importGroupsAndSessions, importFromClaudeLander } from './group-import-export';
import { StateMonitor } from './state-monitor';
import { createApplicationMenu } from './menu';
import { initAutoUpdater, checkForUpdatesManual, downloadUpdate, getUpdateChannel, setUpdateChannel, UpdateChannel } from './auto-updater';
import { notificationManager } from './notification-manager';
import { trayManager } from './tray-manager';
import { soundManager, SoundEvent } from './sound-manager';
import { Group, Session, SessionState, MemoryCreateInput, MemoryUpdateInput } from '../shared/types';
import { authService } from './sharing/auth';
import { shareManager } from './sharing/share-manager';
import { teamsAuthService } from './teams/teams-auth';
import { teamsNotifier } from './teams/teams-notifier';
import { registerMcpServer, registerHooks } from './mcp-config';
import log from 'electron-log';
import { getApiServer } from './api';
import { getVectorSearchManager, disposeVectorSearchManager } from './vector-search';
import { openInEditor, detectAvailableEditors, getEditorOptions, EditorType } from './editor-launcher';

// ---------------------------------------------------------------------------
// Logging & crash reporting configuration
// ---------------------------------------------------------------------------

// Enable Electron's native crash reporter — writes minidump files locally
// so we can diagnose native-module crashes (e.g. node-pty SIGSEGV).
crashReporter.start({
  submitURL: '',       // No remote server — dumps stay local
  uploadToServer: false,
  compress: false,
});

// Configure electron-log: file rotation to prevent unbounded disk growth
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB per log file
log.transports.file.level = 'info';

// Global error handlers — last-resort logger of genuinely unexpected faults.
// BDHLNDR-41: the recurring mDNS (`send ENETUNREACH 224.0.0.251:5353`) and
// relay (`getaddrinfo ENOTFOUND`) uncaught exceptions are now handled at their
// source (mdns-advertiser socket handler / relay emit guard), so this should
// no longer see those transient network floods. Intentionally non-exiting:
// keep the process alive and logged rather than hard-crash.
process.on('uncaughtException', (error: Error) => {
  log.error('[Main] Uncaught exception:', error);
  log.error('[Main] Stack:', error.stack);
  // Don't exit immediately - let the error be logged
  // The process may still crash, but at least we'll have a log
});

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  const errorMsg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  log.error('[Main] Unhandled rejection:', errorMsg);
  log.error('[Main] Promise:', promise);
});

// Use separate userData directory for development to avoid cache conflicts
if (!app.isPackaged) {
  const devUserData = path.join(app.getPath('userData'), 'dev');
  app.setPath('userData', devUserData);
}

// Set app name for Windows notifications
if (process.platform === 'win32') {
  app.setAppUserModelId('Bodhilander');
}

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let stateMonitor: StateMonitor | null = null;
let isQuitting = false;

// Register deep link protocol
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('bodhilander', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient('bodhilander');
}

// Handle deep link on macOS
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Handle deep link on Windows/Linux (second instance)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    const url = commandLine.find((arg) => arg.startsWith('bodhilander://'));
    if (url) {
      handleDeepLink(url);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Broadcast an event to all open windows
function broadcastToAllWindows(channel: string, ...args: any[]) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(channel, ...args);
  }
}

async function handleDeepLink(url: string) {
  log.info('Received deep link:', url);
  const parsed = new URL(url);

  if (parsed.hostname === 'auth' || parsed.pathname === '/auth') {
    const token = parsed.searchParams.get('token');
    if (token) {
      try {
        const user = await authService.handleCallback(token);
        // Broadcast to all windows (main + settings)
        broadcastToAllWindows('auth:changed', { user, token });
      } catch (e) {
        log.error('Auth callback failed:', e);
        broadcastToAllWindows('auth:error', { error: (e as Error).message });
      }
    }
  }

  // Teams OAuth callback
  if (parsed.pathname === '/auth/teams' || (parsed.hostname === 'auth' && parsed.pathname.includes('teams'))) {
    const code = parsed.searchParams.get('code');
    if (code) {
      try {
        const user = await teamsAuthService.handleCallback(code);
        broadcastToAllWindows('teams:authChanged', { user, connected: true });
      } catch (e) {
        log.error('Teams auth callback failed:', e);
        broadcastToAllWindows('teams:authChanged', { error: (e as Error).message, connected: false });
      }
    }
  }
}

// Track sessions by state for tray updates
const sessionStates: Map<string, { name: string; state: string }> = new Map();

// Provide state lookup to sound manager for debounce validation
soundManager.setSessionStateLookup((sessionId: string) => {
  return sessionStates.get(sessionId)?.state;
});

// Track which sessions have already had their state logged in this tick,
// to deduplicate when both stateMonitor and ptyManager fire for the same transition.
const recentlyLoggedStates: Map<string, { state: string; timestamp: number }> = new Map();

/**
 * Shared handler for session state change event logging (BDHLNDR-17).
 * Called from both stateMonitor and ptyManager handlers.
 * Deduplicates: if the same session+state was logged within the last 2 seconds, skips.
 */
function logSessionStateEvent(sessionId: string, newState: SessionState): void {
  // Dedup guard: skip if same session+state was logged within 2 seconds
  const recent = recentlyLoggedStates.get(sessionId);
  const now = Date.now();
  if (recent && recent.state === newState && (now - recent.timestamp) < 2000) {
    return;
  }
  recentlyLoggedStates.set(sessionId, { state: newState, timestamp: now });

  try {
    const previousState = sessionStates.get(sessionId)?.state ?? 'unknown';
    sessionEventsRepo.createEvent(sessionId, 'state_change', {
      from: previousState,
      to: newState,
    });
    if (newState === 'stopped') {
      sessionEventsRepo.createEvent(sessionId, 'session_stop', null);
      const breakdown = sessionEventsRepo.getStateBreakdown(sessionId);
      const activeSeconds = (breakdown['working'] || 0) + (breakdown['waiting'] || 0);
      sessionsRepo.updateSession(sessionId, {
        endedAt: new Date(),
        durationSeconds: activeSeconds,
      });
    }
  } catch (error) {
    log.error('Failed to log session event:', error);
  }
}

const SPLASH_DURATION = 2500; // 2.5 seconds

function updateTrayWithWaitingSessions(): void {
  const waitingSessions = Array.from(sessionStates.entries())
    .filter(([_, info]) => info.state === 'waiting')
    .map(([id, info]) => ({ id, name: info.name }));

  trayManager.updateWaitingSessions(waitingSessions);
}

function handleStateChange(sessionId: string, state: string, sessionName?: string): void {
  // Look up session name from database if not provided
  let name = sessionName;
  let projectPath = '';
  if (!name) {
    const existing = sessionStates.get(sessionId);
    if (existing?.name && existing.name !== sessionId) {
      name = existing.name;
    } else {
      // Look up from database
      try {
        const sessions = sessionsRepo.getAllSessions();
        const session = sessions.find(s => s.id === sessionId);
        name = session?.name || `Session`;
        projectPath = session?.workingDir || '';
      } catch {
        name = 'Session';
      }
    }
  }

  // Get previous state for sound manager
  const previousState = sessionStates.get(sessionId)?.state;

  if (state === 'waiting') {
    sessionStates.set(sessionId, { name, state });

    // Show notification
    notificationManager.showWaitingNotification({
      sessionId,
      sessionName: name,
      message: 'Waiting for input',
    });
  } else {
    // Update state but keep name
    const existing = sessionStates.get(sessionId);
    if (existing) {
      sessionStates.set(sessionId, { ...existing, state });
    } else {
      sessionStates.set(sessionId, { name, state });
    }
  }

  // Play sound notification
  soundManager.handleStateChange(sessionId, state, previousState);

  // Teams notifications
  if (!projectPath) {
    try {
      const session = sessionsRepo.getAllSessions().find(s => s.id === sessionId);
      projectPath = session?.workingDir || '';
    } catch {
      // Ignore - projectPath remains empty
    }
  }

  if (state === 'waiting') {
    notificationManager.sendTeamsNotification(sessionId, name, projectPath, 'waiting');
  } else if (state === 'error') {
    notificationManager.sendTeamsNotification(sessionId, name, projectPath, 'error');
  } else if (state === 'idle' && previousState === 'working') {
    notificationManager.sendTeamsNotification(sessionId, name, projectPath, 'complete');
  }

  // Update tray
  updateTrayWithWaitingSessions();
}

function createSplashWindow(): void {
  // BDHLNDR-44: a BrowserWindow must never be constructed before app 'ready'
  // (the "Cannot create BrowserWindow before app is ready" uncaught exception
  // seen under rapid relaunch). Defer instead of throwing so the error is
  // impossible regardless of caller/timing.
  if (!app.isReady()) {
    app.whenReady().then(() => createSplashWindow());
    return;
  }
  splashWindow = new BrowserWindow({
    icon: path.join(__dirname, '../../build/icon.png'),
    width: 500,
    height: 450,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    center: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  splashWindow.loadFile(path.join(__dirname, '../renderer/splash.html'));

  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

/**
 * Register the Bodhilander Memory MCP server and hook script into every
 * Claude config dir we know about: the global ~/.claude plus each registered
 * account's isolated .claude (BDHLNDR-31).
 */
function registerMcpAndHooksEverywhere(): void {
  const targets: (string | undefined)[] = [undefined]; // undefined = global ~/.claude
  try {
    for (const acc of accountsRepo.getAllAccounts()) {
      targets.push(acc.configDir);
    }
  } catch (err) {
    log.warn('[MCP Config] Failed to list accounts for MCP registration:', err);
  }

  for (const configDir of targets) {
    const label = configDir ?? '(default)';
    const mcpResult = registerMcpServer(configDir);
    if (mcpResult.success) {
      if (mcpResult.action !== 'unchanged') {
        log.info(`MCP server ${mcpResult.action} for ${label}: ${mcpResult.path}`);
      }
    } else {
      log.warn(`MCP server registration failed for ${label}:`, mcpResult.error);
    }

    const hooksResult = registerHooks(configDir);
    if (hooksResult.success) {
      if (hooksResult.action !== 'unchanged') {
        log.info(`Hooks ${hooksResult.action} for ${label}`);
      }
    } else {
      log.warn(`Hooks registration failed for ${label}:`, hooksResult.error);
    }
  }
}

function createWindow(): void {
  // BDHLNDR-44: never construct a BrowserWindow before app 'ready' — defends
  // the rapid-relaunch race that produced "Cannot create BrowserWindow before
  // app is ready". Defer rather than throw.
  if (!app.isReady()) {
    app.whenReady().then(() => createWindow());
    return;
  }

  // Initialize database
  getDatabase();

  // Register MCP server + hooks with Claude Code (auto-configure on startup).
  // Registers into the user's global ~/.claude plus each registered account's
  // isolated config dir (BDHLNDR-31), so the Bodhilander memory MCP and hook
  // script work regardless of which account the session is running under.
  registerMcpAndHooksEverywhere();

  // Mark all sessions as stopped on startup (PTY processes don't survive restarts)
  sessionsRepo.markAllSessionsStopped();

  // Prune session events older than 90 days (BDHLNDR-17)
  try {
    const pruned = sessionEventsRepo.pruneEvents(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
    if (pruned > 0) {
      log.info(`[SessionEvents] Pruned ${pruned} events older than 90 days`);
    }
  } catch (error) {
    log.error('Failed to prune session events:', error);
  }

  // Start state monitor
  stateMonitor = new StateMonitor(ptyManager.getSocketPath());
  stateMonitor.start();

  stateMonitor.on('stateChange', (event) => {
    mainWindow?.webContents.send('state:change', event);
    // Update database with error handling
    try {
      sessionsRepo.updateSession(event.sessionId, {
        state: event.state,
        lastActivityAt: new Date(),
      });
    } catch (error) {
      console.error('Failed to update session state in database:', error);
    }
    // Log session event with dedup (BDHLNDR-17)
    logSessionStateEvent(event.sessionId, event.state);
    // Handle notifications and tray updates
    handleStateChange(event.sessionId, event.state);
  });

  // Restore saved window bounds or use defaults
  const savedBounds = prefsRepo.getWindowBounds();
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    icon: path.join(__dirname, '../../build/icon.png'),
    width: savedBounds?.width || 1200,
    height: savedBounds?.height || 800,
    show: false, // Don't show until splash is done
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  };

  if (savedBounds?.x !== undefined && savedBounds?.y !== undefined) {
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
  }

  mainWindow = new BrowserWindow(windowOptions);

  // Maximize if it was maximized before
  if (savedBounds?.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Show main window and close splash after duration
  mainWindow.once('ready-to-show', () => {
    setTimeout(() => {
      if (splashWindow) {
        splashWindow.close();
      }
      mainWindow?.show();
    }, SPLASH_DURATION);
  });

  // Create custom application menu
  createApplicationMenu(mainWindow);

  // Initialize notification manager
  notificationManager.setMainWindow(mainWindow);

  // Initialize sound manager
  soundManager.setMainWindow(mainWindow);

  // Initialize tray manager
  trayManager.initialize(mainWindow);
  trayManager.setShowSettingsHandler(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('open-settings');
    }
  });

  // Defer non-critical startup tasks until after first paint
  setTimeout(() => {
    // Initialize auto-updater (only in production)
    if (app.isPackaged) {
      initAutoUpdater(mainWindow!);
    }

    // Initialize Teams auth service
    teamsAuthService.initialize();

    // Auto-start API server for MCP memory access
    getApiServer().start().then(({ port }) => {
      log.info(`[Main] API server auto-started on port ${port}`);
    }).catch((err) => {
      log.error('[Main] Failed to auto-start API server:', err);
    });
  }, 1500); // Defer 1.5s to prioritize UI rendering

  // Vector search event forwarding
  const vsManager = getVectorSearchManager();

  vsManager.on('indexing-progress', (progress) => {
    mainWindow?.webContents.send('vector-search:progress', progress);
  });

  vsManager.on('indexing-complete', (data) => {
    mainWindow?.webContents.send('vector-search:complete', data);
  });

  vsManager.on('indexing-error', (data) => {
    mainWindow?.webContents.send('vector-search:error', data);
  });

  // PTY data forwarding
  ptyManager.on('data', ({ id, data }) => {
    mainWindow?.webContents.send('pty:data', id, data);
    // Broadcast to mobile clients
    getApiServer().broadcastTerminalData(id, data);
  });

  ptyManager.on('exit', ({ id, exitCode }) => {
    mainWindow?.webContents.send('pty:exit', id, exitCode);
  });

  // PTY state detection forwarding
  ptyManager.on('stateChange', (event) => {
    mainWindow?.webContents.send('state:change', event);
    // Update database
    try {
      sessionsRepo.updateSession(event.sessionId, {
        state: event.state,
        lastActivityAt: new Date(),
      });
    } catch (error) {
      console.error('Failed to update session state in database:', error);
    }
    // Log session event with dedup (BDHLNDR-17)
    logSessionStateEvent(event.sessionId, event.state);
    // Handle notifications and tray updates
    handleStateChange(event.sessionId, event.state);
    // Broadcast to mobile clients
    getApiServer().broadcastSessionState(event.sessionId, event.state, event.event);
  });

  // Save window bounds on resize/move
  const saveWindowBounds = () => {
    if (!mainWindow) return;
    const isMaximized = mainWindow.isMaximized();
    if (!isMaximized) {
      const bounds = mainWindow.getBounds();
      prefsRepo.setWindowBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: false,
      });
    } else {
      // Just save the maximized state, keep previous bounds
      const currentBounds = prefsRepo.getWindowBounds();
      if (currentBounds) {
        prefsRepo.setWindowBounds({ ...currentBounds, isMaximized: true });
      }
    }
  };

  mainWindow.on('resize', saveWindowBounds);
  mainWindow.on('move', saveWindowBounds);

  // Handle close-to-tray behavior
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      const closeToTray = prefsRepo.getPreference('closeToTray');
      // Default is true (close to tray)
      if (closeToTray !== 'false') {
        event.preventDefault();
        mainWindow?.hide();
        return;
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Safe IPC wrappers that catch and log errors
function safeHandle(channel: string, handler: (...args: any[]) => any): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      log.error(`[IPC] ${channel} failed:`, err);
      throw err;
    }
  });
}

function safeOn(channel: string, handler: (...args: any[]) => void): void {
  ipcMain.on(channel, (_event, ...args) => {
    try {
      handler(...args);
    } catch (err) {
      log.error(`[IPC] ${channel} failed:`, err);
    }
  });
}

// IPC Handlers
ipcMain.handle('pty:create', async (_, id: string, cwd: string, launchClaude: boolean = false) => {
  try {
    // Look up the session to get its groupId for memory injection
    const sessions = sessionsRepo.getAllSessions();
    const session = sessions.find(s => s.id === id);
    const groupId = session?.groupId || null;

    ptyManager.createSession(id, cwd, launchClaude, groupId);
    // Play session start sound
    soundManager.playStartSound();
  } catch (error) {
    log.error('[Main] Failed to create PTY session:', error);
    throw error; // Re-throw so renderer knows it failed
  }
});

safeOn('pty:write', (id: string, data: string) => {
  ptyManager.write(id, data);
});

safeOn('pty:resize', (id: string, cols: number, rows: number) => {
  ptyManager.resize(id, cols, rows);
});

safeOn('pty:kill', (id: string) => {
  // Stop sharing if this session was being shared
  shareManager.stopSharing(id).catch(() => {
    // Ignore errors - session may not have been shared
  });
  ptyManager.kill(id);
});

// Prime a deferred-emission pty (BDHLNDR-33): flushes any buffered scrollback
// as a single 'data' event then unlocks live emission. Used by the Terminal
// component for the Add Account login flow, which attaches its listener
// after the pty has already started producing output.
safeOn('pty:prime', (id: string) => {
  ptyManager.primePty(id);
});

// Database IPC Handlers - Groups
safeHandle('db:groups:getAll', () => {
  return groupsRepo.getAllGroups();
});

safeHandle('db:groups:create', (group: Group) => {
  groupsRepo.createGroup(group);
  getApiServer().broadcastGroupsUpdated();
});

safeHandle('db:groups:update', (id: string, updates: Partial<Group>) => {
  groupsRepo.updateGroup(id, updates);
  getApiServer().broadcastGroupsUpdated();
});

safeHandle('db:groups:delete', (id: string) => {
  groupsRepo.deleteGroup(id);
  getApiServer().broadcastGroupsUpdated();
});

// Dialog IPC Handlers
safeHandle('dialog:selectDirectory', async (defaultPath?: string) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'showHiddenFiles'],
    title: 'Select Working Directory',
    // BDHLNDR-36: open the picker at the group's current working directory
    // (or the last path the caller passed), not the OS's last-remembered dir.
    ...(defaultPath ? { defaultPath } : {}),
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// Database IPC Handlers - Sessions
safeHandle('db:sessions:getAll', () => {
  return sessionsRepo.getAllSessions();
});

safeHandle('db:sessions:create', (session: Session) => {
  sessionsRepo.createSession(session);
  // Log session start event (BDHLNDR-17)
  try {
    sessionEventsRepo.createEvent(session.id, 'session_start', null);
  } catch (error) {
    log.error('Failed to log session_start event:', error);
  }
  getApiServer().broadcastSessionsUpdated();
});

safeHandle('db:sessions:update', (id: string, updates: Partial<Session>) => {
  sessionsRepo.updateSession(id, updates);
  getApiServer().broadcastSessionsUpdated();
});

ipcMain.handle('db:sessions:delete', async (_, id: string) => {
  // Stop sharing if this session was being shared
  try {
    await shareManager.stopSharing(id);
  } catch {
    // Ignore errors - session may not have been shared
  }
  sessionsRepo.deleteSession(id);
  getApiServer().broadcastSessionsUpdated();
});

// Claude account IPC handlers (BDHLNDR-31)
safeHandle('accounts:list', () => {
  return accountsRepo.getAllAccounts();
});

safeHandle('accounts:startLogin', (label: string) => {
  const trimmed = (label ?? '').toString().trim();
  if (!trimmed) throw new Error('Account label is required');
  return accountAuth.startLoginFlow(ptyManager, mainWindow, trimmed);
});

safeHandle('accounts:cancelLogin', (ptyId: string, deleteAccount: boolean) => {
  accountAuth.cancelLoginFlow(ptyManager, ptyId, deleteAccount);
});

safeHandle('accounts:confirmLoginMacOS', (ptyId: string) => {
  accountAuth.confirmLoginMacOS(mainWindow, ptyId);
});

safeHandle('accounts:delete', (id: string) => {
  accountAuth.deleteAccountAndDir(id);
});

safeHandle('accounts:update', (
  id: string,
  updates: { label?: string; color?: string; email?: string | null },
) => {
  accountsRepo.updateAccount(id, updates);
});

safeHandle('accounts:setDefault', (id: string) => {
  accountsRepo.setDefaultAccount(id);
});

// Database IPC Handlers - Memories
safeHandle('db:memories:getBySession', (sessionId: string) => {
  return memoriesRepo.getMemoriesBySession(sessionId);
});

safeHandle('db:memories:getByGroup', (groupId: string) => {
  return memoriesRepo.getMemoriesByGroup(groupId);
});

safeHandle('db:memories:getPinned', (groupId?: string) => {
  return memoriesRepo.getPinnedMemories(groupId);
});

safeHandle('db:memories:search', (query: string, groupId?: string) => {
  return memoriesRepo.searchMemories(query, groupId);
});

safeHandle('db:memories:create', (input: MemoryCreateInput) => {
  return memoriesRepo.createMemory(input);
});

safeHandle('db:memories:update', (id: string, updates: MemoryUpdateInput) => {
  memoriesRepo.updateMemory(id, updates);
});

safeHandle('db:memories:delete', (id: string) => {
  memoriesRepo.deleteMemory(id);
});

safeHandle('db:memories:getForInjection', (sessionId: string, groupId: string) => {
  return memoriesRepo.getMemoriesForInjection(sessionId, groupId);
});

safeHandle('db:memories:getById', (id: string) => {
  return memoriesRepo.getMemoryById(id);
});

safeHandle('db:memories:getGlobal', () => {
  return memoriesRepo.getGlobalContextMemories();
});

// Database IPC Handlers - Session Events (BDHLNDR-17)
safeHandle('db:sessionEvents:getBySession', (sessionId: string, limit?: number) =>
  sessionEventsRepo.getEventsBySession(sessionId, limit)
);

safeHandle('db:sessionEvents:getSessionStats', (sessionId: string) =>
  sessionEventsRepo.getSessionStats(sessionId)
);

safeHandle('db:sessionEvents:getGlobalStats', (since?: string) =>
  sessionEventsRepo.getGlobalStats(since ? new Date(since) : undefined)
);

safeHandle('db:sessionEvents:getToolUseCounts', (sessionId?: string) =>
  sessionEventsRepo.getToolUseCounts(sessionId)
);

// Session Export IPC Handlers (BDHLNDR-20)
safeHandle('export:sessions', (format: ExportFormat, since?: string) =>
  exportSessions({ format, since })
);

// Group & Session Import/Export
safeHandle('export:groups', () => exportGroupsAndSessions());
safeHandle('import:groups', () => importGroupsAndSessions());
safeHandle('import:fromClaudeLander', () => importFromClaudeLander());

// Preferences IPC Handlers
safeHandle('prefs:get', (key: string) => {
  return prefsRepo.getPreference(key);
});

safeHandle('prefs:set', (key: string, value: string) => {
  prefsRepo.setPreference(key, value);
});

safeHandle('prefs:getAll', () => {
  // Return all app settings as an object
  const settings = {
    autoLaunchClaude: prefsRepo.getPreference('autoLaunchClaude') ?? 'true',
    customShellPath: prefsRepo.getPreference('customShellPath') ?? '',
    showSplash: prefsRepo.getPreference('showSplash') ?? 'true',
    splashDuration: prefsRepo.getPreference('splashDuration') ?? '2.5',
    enableNotifications: prefsRepo.getPreference('enableNotifications') ?? 'true',
    notificationSound: prefsRepo.getPreference('notificationSound') ?? 'true',
    closeToTray: prefsRepo.getPreference('closeToTray') ?? 'true',
    fontSize: prefsRepo.getPreference('fontSize') ?? '14',
    webglRenderer: prefsRepo.getPreference('webglRenderer') ?? 'true',
    // Sound notification settings
    soundVolume: prefsRepo.getPreference('soundVolume') ?? '70',
    soundWaitingEnabled: prefsRepo.getPreference('soundWaitingEnabled') ?? 'true',
    soundWaitingCustomPath: prefsRepo.getPreference('soundWaitingCustomPath') ?? '',
    soundErrorEnabled: prefsRepo.getPreference('soundErrorEnabled') ?? 'true',
    soundErrorCustomPath: prefsRepo.getPreference('soundErrorCustomPath') ?? '',
    soundStartEnabled: prefsRepo.getPreference('soundStartEnabled') ?? 'true',
    soundStartCustomPath: prefsRepo.getPreference('soundStartCustomPath') ?? '',
    soundCompleteEnabled: prefsRepo.getPreference('soundCompleteEnabled') ?? 'true',
    soundCompleteCustomPath: prefsRepo.getPreference('soundCompleteCustomPath') ?? '',
  };
  return settings;
});

// Sound IPC Handlers
safeHandle('sound:test', (event: SoundEvent, volume?: number, customPath?: string) => {
  soundManager.testSound(event, volume, customPath);
});

safeHandle('sound:selectFile', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Select Sound File',
    filters: [
      { name: 'Audio Files', extensions: ['wav', 'mp3', 'ogg', 'm4a'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// Auth IPC handlers
safeHandle('auth:login', () => {
  authService.startLogin();
});

safeHandle('auth:logout', () => {
  authService.logout();
  return { success: true };
});

safeHandle('auth:getUser', () => {
  return authService.currentUser;
});

safeHandle('auth:setToken', async (token: string) => {
  return authService.setToken(token);
});

// Teams IPC Handlers
safeHandle('teams:login', () => {
  teamsAuthService.startLogin();
});

safeHandle('teams:logout', () => {
  teamsAuthService.logout();
  teamsNotifier.clearCache();
  return { success: true };
});

safeHandle('teams:getStatus', () => {
  return {
    connected: teamsAuthService.isAuthenticated,
    user: teamsAuthService.currentUser,
  };
});

safeHandle('teams:testNotification', async () => {
  return teamsNotifier.sendTestNotification();
});

// App update check (for About dialog)
safeHandle('app:check-for-update', async () => {
  return checkForUpdatesManual();
});

// App update download (for About dialog)
safeHandle('app:download-update', () => {
  downloadUpdate();
});

// App restart and update (for About dialog)
safeHandle('app:restart-and-update', async () => {
  const { autoUpdater } = await import('electron-updater');
  autoUpdater.quitAndInstall(false, true);
});

// Update channel (BDHLNDR-32) — opt-in beta builds
safeHandle('app:get-update-channel', () => {
  return getUpdateChannel();
});

safeHandle('app:set-update-channel', (channel: UpdateChannel) => {
  const normalized: UpdateChannel = channel === 'beta' ? 'beta' : 'stable';
  setUpdateChannel(normalized);
  return normalized;
});

// Whether the currently-running build is itself a beta — used by the
// renderer to show a BETA pill in the title bar.
safeHandle('app:is-prerelease-build', () => {
  return app.getVersion().includes('-beta.');
});

// Sharing IPC handlers (host)
safeHandle('share:start', async (localSessionId: string) => {
  return shareManager.startSharing(localSessionId);
});

safeHandle('share:stop', async (localSessionId: string) => {
  return shareManager.stopSharing(localSessionId);
});

safeHandle('share:createCode', async (localSessionId: string, options: any) => {
  return shareManager.createCode(localSessionId, options);
});

safeHandle('share:revokeCode', async (code: string) => {
  return shareManager.revokeCode(code);
});

safeHandle('share:getCodes', async (localSessionId: string) => {
  return shareManager.getCodes(localSessionId);
});

safeHandle('share:isSharing', (localSessionId: string) => {
  return shareManager.isSharing(localSessionId);
});

safeHandle('share:getGuestCount', (localSessionId: string) => {
  return shareManager.getGuestCount(localSessionId);
});

// Sharing IPC handlers (guest)
safeHandle('share:join', async (code: string) => {
  const { permission, hostUsername, sessionName, relayClient } = await shareManager.joinSession(code);

  // Forward relay data to renderer
  relayClient.on('data', (data) => {
    mainWindow?.webContents.send('share:data', { code, data: data.toString() });
  });

  relayClient.on('disconnected', () => {
    mainWindow?.webContents.send('share:ended', { code });
  });

  return { code, permission, hostUsername, sessionName };
});

safeHandle('share:leave', (code: string) => {
  shareManager.leaveSession(code);
});

safeHandle('share:write', (code: string, data: string) => {
  const client = shareManager.getJoinedClient(code);
  if (client && client.canSendInput()) {
    client.send(data);
    return { success: true };
  }
  return { success: false, error: 'Cannot send input' };
});

// Open external URL
ipcMain.handle('shell:openExternal', (_, url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      log.warn('[Main] Blocked shell:openExternal for non-HTTP URL:', url);
      return;
    }
    shell.openExternal(url);
  } catch {
    log.warn('[Main] Invalid URL passed to shell:openExternal:', url);
  }
});

// ============================================================================
// Mobile API Server IPC Handlers
// ============================================================================

ipcMain.handle('api:start', async () => {
  try {
    const apiServer = getApiServer();
    if (apiServer.isRunning) {
      return {
        success: true,
        port: apiServer.port,
        addresses: apiServer.addresses,
        message: 'API server is already running',
      };
    }
    const result = await apiServer.start();
    return { success: true, port: result.port, addresses: result.addresses };
  } catch (error) {
    log.error('[ApiHandlers] Failed to start API server:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('api:stop', async () => {
  try {
    const apiServer = getApiServer();
    await apiServer.stop();
    return { success: true };
  } catch (error) {
    log.error('[ApiHandlers] Failed to stop API server:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

safeHandle('api:getStatus', () => {
  const apiServer = getApiServer();
  return apiServer.getStatus();
});

ipcMain.handle('api:generatePairingCode', async (_, options?: { canControl?: boolean; canModify?: boolean }) => {
  try {
    const apiServer = getApiServer();
    if (!apiServer.isRunning) {
      return { success: false, error: 'API server is not running. Start it first.' };
    }

    const pairingInfo = apiServer.pairingManager.generatePairingCode(options);
    const QRCode = require('qrcode');
    const { hostname, networkInterfaces } = require('os');

    const addresses = getLocalAddresses();
    const primaryAddress = addresses[0] || '127.0.0.1';

    const qrData = {
      type: 'bodhilander-pair',
      host: primaryAddress,
      port: apiServer.port,
      code: pairingInfo.code,
      hostname: hostname(),
      expiresAt: pairingInfo.expiresAt,
    };

    const qrCodeDataUrl = await QRCode.toDataURL(JSON.stringify(qrData), {
      errorCorrectionLevel: 'M',
      width: 256,
      margin: 2,
    });

    return {
      success: true,
      code: pairingInfo.code,
      qrCode: qrCodeDataUrl,
      expiresAt: pairingInfo.expiresAt,
      addresses,
      port: apiServer.port,
    };
  } catch (error) {
    log.error('[ApiHandlers] Failed to generate pairing code:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

safeHandle('api:cancelPairing', () => {
  const apiServer = getApiServer();
  apiServer.pairingManager.cancelPairing();
  return { success: true };
});

safeHandle('api:getPairedDevices', () => {
  const apiServer = getApiServer();
  const devices = apiServer.pairingManager.getAllDevices();
  return devices.map(d => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    canControl: d.canControl,
    canModify: d.canModify,
    createdAt: d.createdAt.toISOString(),
    lastUsedAt: d.lastUsedAt.toISOString(),
  }));
});

ipcMain.handle('api:unpairDevice', (_, deviceId: string) => {
  try {
    const apiServer = getApiServer();
    const success = apiServer.pairingManager.unpairDevice(deviceId);
    return { success };
  } catch (error) {
    log.error('[ApiHandlers] Failed to unpair device:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('api:updateDevicePermissions', (_, deviceId: string, permissions: { canControl?: boolean; canModify?: boolean }) => {
  try {
    const apiServer = getApiServer();
    const success = apiServer.pairingManager.updateDevicePermissions(deviceId, permissions);
    return { success };
  } catch (error) {
    log.error('[ApiHandlers] Failed to update device permissions:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

safeHandle('api:hasPairingCode', () => {
  const apiServer = getApiServer();
  return { active: apiServer.pairingManager.hasActivePairingCode() };
});

// Remote access IPC handlers
ipcMain.handle('api:enableRemoteAccess', async () => {
  try {
    const apiServer = getApiServer();
    await apiServer.enableRemoteAccess();
    return { success: true, status: apiServer.getRemoteAccessStatus() };
  } catch (error) {
    log.error('Failed to enable remote access:', error);
    return { success: false, error: (error as Error).message };
  }
});

ipcMain.handle('api:disableRemoteAccess', () => {
  try {
    const apiServer = getApiServer();
    apiServer.disableRemoteAccess();
    return { success: true };
  } catch (error) {
    log.error('Failed to disable remote access:', error);
    return { success: false, error: (error as Error).message };
  }
});

safeHandle('api:getRemoteAccessStatus', () => {
  const apiServer = getApiServer();
  return apiServer.getRemoteAccessStatus();
});

// ============================================================================
// Vector Search IPC Handlers
// ============================================================================

safeHandle('vector-search:get-index-status', (directoryPath: string) => {
  return getVectorSearchManager().getIndexStatus(directoryPath);
});

safeHandle('vector-search:get-all-indexes', () => {
  return getVectorSearchManager().getAllIndexes();
});

ipcMain.handle('vector-search:start-indexing', async (_, directoryPath: string) => {
  try {
    log.info('[VectorSearch] Starting indexing for:', directoryPath);
    await getVectorSearchManager().startIndexing(directoryPath);
    return { success: true };
  } catch (error) {
    log.error('[VectorSearch] Failed to start indexing:', error);
    return { success: false, error: (error as Error).message };
  }
});

safeHandle('vector-search:search-code', async (directoryPath: string, query: string, limit?: number) => {
  return getVectorSearchManager().searchCode(directoryPath, query, limit);
});

safeHandle('vector-search:search-symbols', (directoryPath: string, name: string, symbolType?: string, limit?: number) => {
  return getVectorSearchManager().searchSymbols(directoryPath, name, symbolType as any, limit);
});

safeHandle('vector-search:cancel-indexing', async (indexId: string) => {
  await getVectorSearchManager().cancelIndexing(indexId);
  return { success: true };
});

safeHandle('vector-search:delete-index', async (directoryPath: string) => {
  await getVectorSearchManager().deleteIndex(directoryPath);
  return { success: true };
});

ipcMain.handle('vector-search:retry-indexing', async (_, directoryPath: string) => {
  try {
    await getVectorSearchManager().retryIndexing(directoryPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
});

// ============================================================================
// Editor Integration IPC Handlers
// ============================================================================

safeHandle('editor:open', async (filePath: string, line?: number, column?: number) => {
  const preferredEditor = prefsRepo.getPreference('preferredEditor') as EditorType | null;
  return openInEditor(filePath, line ?? 1, column ?? 1, preferredEditor ?? undefined);
});

safeHandle('editor:detectAvailable', async () => {
  return detectAvailableEditors();
});

safeHandle('editor:getOptions', () => {
  return getEditorOptions();
});

function getLocalAddresses(): string[] {
  const { networkInterfaces } = require('os');
  const addresses: string[] = [];
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const nets = interfaces[name];
    if (!nets) continue;
    for (const net of nets) {
      if (net.internal) continue;
      if (net.family === 'IPv4') {
        addresses.push(net.address);
      }
    }
  }
  // Prioritize 192.168.x.x (typical LAN) over 172.x.x (often Docker/WSL/Hyper-V) and 10.x.x
  return addresses.sort((a, b) => {
    const score = (ip: string) => {
      if (ip.startsWith('192.168.')) return 0;
      if (ip.startsWith('10.')) return 1;
      if (ip.startsWith('172.')) return 2;
      return 3;
    };
    return score(a) - score(b);
  });
}

// Forward share manager events to renderer
shareManager.on('guestJoined', (info) => {
  mainWindow?.webContents.send('share:guestJoined', info);
});

shareManager.on('guestLeft', (info) => {
  mainWindow?.webContents.send('share:guestLeft', info);
});

app.whenReady().then(() => {
  createSplashWindow();
  createWindow();
}).catch((error) => {
  log.error('[Main] Failed to initialize app:', error);
});

// BDHLNDR-44: recover from renderer/GPU process crashes instead of leaving
// the window blank. Bounded against a crash→reload storm: at most
// MAX_PROCESS_RELOADS within RELOAD_WINDOW_MS, then stop and just log.
const MAX_PROCESS_RELOADS = 3;
const RELOAD_WINDOW_MS = 60_000;
let processReloadTimes: number[] = [];

function recoverWindowAfterCrash(reason: string): void {
  const now = Date.now();
  processReloadTimes = processReloadTimes.filter((t) => now - t < RELOAD_WINDOW_MS);
  if (processReloadTimes.length >= MAX_PROCESS_RELOADS) {
    log.error(
      `[Main] Skipping recovery after ${reason} — ${processReloadTimes.length} ` +
        `reloads within ${RELOAD_WINDOW_MS}ms (reload-storm guard)`
    );
    return;
  }
  processReloadTimes.push(now);

  if (mainWindow && !mainWindow.isDestroyed()) {
    log.warn(`[Main] Recovering UI after ${reason} — reloading main window`);
    try {
      mainWindow.webContents.reload();
    } catch (e) {
      log.error('[Main] Reload after crash failed:', e);
    }
  } else if (app.isReady()) {
    log.warn(`[Main] Recovering after ${reason} — recreating main window`);
    createWindow();
  }
}

// Handle render process crashes (if any child window crashes)
app.on('render-process-gone', (event, webContents, details) => {
  log.error('[Main] Render process gone:', details.reason, details.exitCode);
  // 'clean-exit'/'killed' are intentional teardown (quit, manual kill) — don't
  // fight those. Anything else (crashed/oom/abnormal-exit/launch-failed) left
  // the renderer dead → reload so the user isn't staring at a blank window.
  if (details.reason === 'clean-exit' || details.reason === 'killed') return;
  recoverWindowAfterCrash(`render-process-gone (${details.reason})`);
});

// Handle child process crashes
app.on('child-process-gone', (event, details) => {
  log.error('[Main] Child process gone:', details.type, details.reason, details.exitCode);
  // Electron auto-relaunches the GPU process, but on macOS the renderer is
  // often left blank/unresponsive afterwards — reload so it re-establishes
  // its GPU channel and re-paints. (Bounded by the reload-storm guard.)
  if (details.type === 'GPU' && details.reason !== 'clean-exit') {
    recoverWindowAfterCrash('GPU process crash');
  }
});

// Renderer error forwarding — renderer calls this via IPC so errors land in the log file
safeHandle('log:error', (source: string, message: string, stack?: string) => {
  log.error(`[Renderer:${source}]`, message);
  if (stack) log.error(`[Renderer:${source}] Stack:`, stack);
});

safeHandle('log:warn', (source: string, message: string) => {
  log.warn(`[Renderer:${source}]`, message);
});

// Expose log file path and crash dump directory so user can find them
safeHandle('log:getPaths', () => {
  return {
    logFile: log.transports.file.getFile()?.path || null,
    crashDumps: app.getPath('crashDumps'),
  };
});

app.on('window-all-closed', () => {
  // On macOS, apps typically stay open until explicitly quit
  // For other platforms, only quit if not using close-to-tray
  if (process.platform !== 'darwin') {
    const closeToTray = prefsRepo.getPreference('closeToTray');
    if (closeToTray === 'false') {
      app.quit();
    }
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

let cleanupComplete = false;

app.on('before-quit', (event) => {
  if (cleanupComplete) return;

  event.preventDefault();
  isQuitting = true;

  (async () => {
    try {
      await shareManager.stopAllSharing();
    } catch (e) {
      log.error('Error stopping shares on quit:', e);
    }

    try {
      await ptyManager.killAll();
    } catch (e) {
      log.error('Error killing PTYs on quit:', e);
    }

    disposeVectorSearchManager();
    trayManager.destroy();
    stateMonitor?.stop();
    closeDatabase();

    cleanupComplete = true;
    app.quit();
  })();
});
