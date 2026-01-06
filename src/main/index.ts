import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import { ptyManager } from './pty-manager';
import { getDatabase, closeDatabase } from './database';
import * as groupsRepo from './repositories/groups';
import * as sessionsRepo from './repositories/sessions';
import * as prefsRepo from './repositories/preferences';
import { StateMonitor } from './state-monitor';
import { createApplicationMenu, showSettingsWindow } from './menu';
import { initAutoUpdater, checkForUpdatesManual, downloadUpdate } from './auto-updater';
import { notificationManager } from './notification-manager';
import { trayManager } from './tray-manager';
import { soundManager, SoundEvent } from './sound-manager';
import { Group, Session } from '../shared/types';
import { authService } from './sharing/auth';
import { shareManager } from './sharing/share-manager';
import { teamsAuthService } from './teams/teams-auth';
import { teamsNotifier } from './teams/teams-notifier';
import log from 'electron-log';

// Use separate userData directory for development to avoid cache conflicts
if (!app.isPackaged) {
  const devUserData = path.join(app.getPath('userData'), 'dev');
  app.setPath('userData', devUserData);
}

// Set app name for Windows notifications
if (process.platform === 'win32') {
  app.setAppUserModelId('ClaudeLander');
}

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let stateMonitor: StateMonitor | null = null;
let isQuitting = false;

// Register deep link protocol
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('claudelander', process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient('claudelander');
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
    const url = commandLine.find((arg) => arg.startsWith('claudelander://'));
    if (url) {
      handleDeepLink(url);
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

async function handleDeepLink(url: string) {
  log.info('Received deep link:', url);
  const parsed = new URL(url);

  if (parsed.hostname === 'auth' || parsed.pathname === '/auth') {
    const token = parsed.searchParams.get('token');
    if (token) {
      try {
        const user = await authService.handleCallback(token);
        mainWindow?.webContents.send('auth:changed', { user, token });
      } catch (e) {
        log.error('Auth callback failed:', e);
        mainWindow?.webContents.send('auth:error', { error: (e as Error).message });
      }
    }
  }

  // Teams OAuth callback
  if (parsed.pathname === '/auth/teams' || (parsed.hostname === 'auth' && parsed.pathname.includes('teams'))) {
    const code = parsed.searchParams.get('code');
    if (code) {
      try {
        const user = await teamsAuthService.handleCallback(code);
        mainWindow?.webContents.send('teams:authChanged', { user, connected: true });
      } catch (e) {
        log.error('Teams auth callback failed:', e);
        mainWindow?.webContents.send('teams:authChanged', { error: (e as Error).message, connected: false });
      }
    }
  }
}

// Track sessions by state for tray updates
const sessionStates: Map<string, { name: string; state: string }> = new Map();

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

  // Update tray
  updateTrayWithWaitingSessions();
}

function createSplashWindow(): void {
  splashWindow = new BrowserWindow({
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

function createWindow(): void {
  // Initialize database
  getDatabase();

  // Mark all sessions as stopped on startup (PTY processes don't survive restarts)
  sessionsRepo.markAllSessionsStopped();

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
    // Handle notifications and tray updates
    handleStateChange(event.sessionId, event.state);
  });

  // Restore saved window bounds or use defaults
  const savedBounds = prefsRepo.getWindowBounds();
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
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

  // Initialize auto-updater (only in production)
  if (app.isPackaged) {
    initAutoUpdater(mainWindow);
  }

  // Initialize notification manager
  notificationManager.setMainWindow(mainWindow);

  // Initialize sound manager
  soundManager.setMainWindow(mainWindow);

  // Initialize tray manager
  trayManager.initialize(mainWindow);
  trayManager.setShowSettingsHandler(() => {
    if (mainWindow) {
      showSettingsWindow(mainWindow);
    }
  });

  // Initialize Teams auth service
  teamsAuthService.initialize();

  // PTY data forwarding
  ptyManager.on('data', ({ id, data }) => {
    mainWindow?.webContents.send('pty:data', id, data);
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
    // Handle notifications and tray updates
    handleStateChange(event.sessionId, event.state);
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

// IPC Handlers
ipcMain.handle('pty:create', async (_, id: string, cwd: string, launchClaude: boolean = false) => {
  ptyManager.createSession(id, cwd, launchClaude);
  // Play session start sound
  soundManager.playStartSound();
});

ipcMain.on('pty:write', (_, id: string, data: string) => {
  ptyManager.write(id, data);
});

ipcMain.on('pty:resize', (_, id: string, cols: number, rows: number) => {
  ptyManager.resize(id, cols, rows);
});

ipcMain.on('pty:kill', (_, id: string) => {
  // Stop sharing if this session was being shared
  shareManager.stopSharing(id).catch(() => {
    // Ignore errors - session may not have been shared
  });
  ptyManager.kill(id);
});

// Database IPC Handlers - Groups
ipcMain.handle('db:groups:getAll', async () => {
  return groupsRepo.getAllGroups();
});

ipcMain.handle('db:groups:create', async (_, group: Group) => {
  groupsRepo.createGroup(group);
});

ipcMain.handle('db:groups:update', async (_, id: string, updates: Partial<Group>) => {
  groupsRepo.updateGroup(id, updates);
});

ipcMain.handle('db:groups:delete', async (_, id: string) => {
  groupsRepo.deleteGroup(id);
});

// Dialog IPC Handlers
ipcMain.handle('dialog:selectDirectory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Working Directory',
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// Database IPC Handlers - Sessions
ipcMain.handle('db:sessions:getAll', async () => {
  return sessionsRepo.getAllSessions();
});

ipcMain.handle('db:sessions:create', async (_, session: Session) => {
  sessionsRepo.createSession(session);
});

ipcMain.handle('db:sessions:update', async (_, id: string, updates: Partial<Session>) => {
  sessionsRepo.updateSession(id, updates);
});

ipcMain.handle('db:sessions:delete', async (_, id: string) => {
  // Stop sharing if this session was being shared
  try {
    await shareManager.stopSharing(id);
  } catch {
    // Ignore errors - session may not have been shared
  }
  sessionsRepo.deleteSession(id);
});

// Preferences IPC Handlers
ipcMain.handle('prefs:get', async (_, key: string) => {
  return prefsRepo.getPreference(key);
});

ipcMain.handle('prefs:set', async (_, key: string, value: string) => {
  prefsRepo.setPreference(key, value);
});

ipcMain.handle('prefs:getAll', async () => {
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
ipcMain.handle('sound:test', (_, event: SoundEvent, volume?: number, customPath?: string) => {
  soundManager.testSound(event, volume, customPath);
});

ipcMain.handle('sound:selectFile', async () => {
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
ipcMain.handle('auth:login', () => {
  authService.startLogin();
});

ipcMain.handle('auth:logout', () => {
  authService.logout();
  return { success: true };
});

ipcMain.handle('auth:getUser', () => {
  return authService.currentUser;
});

ipcMain.handle('auth:setToken', async (_, token: string) => {
  return authService.setToken(token);
});

// Teams IPC Handlers
ipcMain.handle('teams:login', () => {
  teamsAuthService.startLogin();
});

ipcMain.handle('teams:logout', () => {
  teamsAuthService.logout();
  return { success: true };
});

ipcMain.handle('teams:getStatus', () => {
  return {
    connected: teamsAuthService.isAuthenticated,
    user: teamsAuthService.currentUser,
  };
});

ipcMain.handle('teams:testNotification', async () => {
  return teamsNotifier.sendTestNotification();
});

// App update check (for About dialog)
ipcMain.handle('app:check-for-update', async () => {
  return checkForUpdatesManual();
});

// App update download (for About dialog)
ipcMain.handle('app:download-update', async () => {
  downloadUpdate();
});

// Sharing IPC handlers (host)
ipcMain.handle('share:start', async (_, localSessionId: string) => {
  return shareManager.startSharing(localSessionId);
});

ipcMain.handle('share:stop', async (_, localSessionId: string) => {
  return shareManager.stopSharing(localSessionId);
});

ipcMain.handle('share:createCode', async (_, localSessionId: string, options: any) => {
  return shareManager.createCode(localSessionId, options);
});

ipcMain.handle('share:revokeCode', async (_, code: string) => {
  return shareManager.revokeCode(code);
});

ipcMain.handle('share:getCodes', async (_, localSessionId: string) => {
  return shareManager.getCodes(localSessionId);
});

ipcMain.handle('share:isSharing', (_, localSessionId: string) => {
  return shareManager.isSharing(localSessionId);
});

ipcMain.handle('share:getGuestCount', (_, localSessionId: string) => {
  return shareManager.getGuestCount(localSessionId);
});

// Sharing IPC handlers (guest)
ipcMain.handle('share:join', async (_, code: string) => {
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

ipcMain.handle('share:leave', (_, code: string) => {
  shareManager.leaveSession(code);
});

ipcMain.handle('share:write', (_, code: string, data: string) => {
  const client = shareManager.getJoinedClient(code);
  if (client && client.canSendInput()) {
    client.send(data);
    return { success: true };
  }
  return { success: false, error: 'Cannot send input' };
});

// Open external URL
ipcMain.handle('shell:openExternal', (_, url: string) => {
  shell.openExternal(url);
});

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

app.on('before-quit', async () => {
  isQuitting = true;

  // Stop all active shares before quitting
  try {
    await shareManager.stopAllSharing();
  } catch (e) {
    log.error('Error stopping shares on quit:', e);
  }

  trayManager.destroy();
  stateMonitor?.stop();
  closeDatabase();
});
