import { autoUpdater, UpdateInfo } from 'electron-updater';
import { BrowserWindow, dialog, Notification } from 'electron';
import * as log from 'electron-log';

// Configure logging
autoUpdater.logger = log;
(autoUpdater.logger as typeof log).transports.file.level = 'info';

// Disable auto-download - we'll prompt the user first
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow: BrowserWindow | null = null;
let isDownloading = false;
let isDialogOpen = false;
let isDownloadingFromAbout = false;
let manualCheckResolver: ((result: { updateAvailable: boolean; version?: string; error?: string }) => void) | null = null;

// Broadcast event to all windows (including About dialog)
function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  });
}

export function initAutoUpdater(window: BrowserWindow): void {
  mainWindow = window;

  // Check for updates on startup (with delay to not block app launch)
  setTimeout(() => {
    checkForUpdates();
  }, 10000); // Check 10 seconds after launch

  // Check for updates every 4 hours
  setInterval(() => {
    checkForUpdates();
  }, 4 * 60 * 60 * 1000);
}

export function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch((err) => {
    log.error('Error checking for updates:', err);
  });
}

// Manual check that returns result (for About dialog)
export async function checkForUpdatesManual(): Promise<{ updateAvailable: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    manualCheckResolver = resolve;
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('Error checking for updates:', err);
      manualCheckResolver = null;
      resolve({ updateAvailable: false, error: err.message });
    });
  });
}

// Trigger download (called from About dialog after manual check)
export function downloadUpdate(): void {
  if (isDownloading) {
    log.info('Download already in progress');
    return;
  }

  isDownloading = true;
  isDownloadingFromAbout = true;
  log.info('Starting update download from About dialog...');

  autoUpdater.downloadUpdate().catch((err) => {
    log.error('Download failed:', err);
    isDownloading = false;
    isDownloadingFromAbout = false;
    // Broadcast error to all windows (so About dialog can show it)
    broadcastToAllWindows('update:error', err.message);
  });

  broadcastToAllWindows('update:downloading');
}

// Update available
autoUpdater.on('update-available', (info: UpdateInfo) => {
  log.info('Update available:', info.version);

  // Resolve manual check promise if pending
  if (manualCheckResolver) {
    manualCheckResolver({ updateAvailable: true, version: info.version });
    manualCheckResolver = null;
    return; // Don't show dialog - About window will handle it
  }

  if (!mainWindow) return;

  // Prevent stacking dialogs if one is already open
  if (isDialogOpen) {
    log.info('Update dialog already open, skipping');
    return;
  }

  isDialogOpen = true;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Available',
    message: `A new version of ClaudeLander is available!`,
    detail: `Version ${info.version} is ready to download.\n\nWould you like to download it now?`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
  }).then((result) => {
    isDialogOpen = false;
    if (result.response === 0) {
      // User clicked Download
      isDownloading = true;
      log.info('Starting update download...');

      // Show downloading notification
      if (Notification.isSupported()) {
        new Notification({
          title: 'Downloading Update',
          body: 'ClaudeLander is downloading the update in the background...',
        }).show();
      }

      autoUpdater.downloadUpdate().catch((err) => {
        log.error('Download failed:', err);
        isDownloading = false;
        if (mainWindow) {
          dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Download Failed',
            message: 'Failed to download update',
            detail: `Error: ${err.message}\n\nPlease try again later or download manually from GitHub.`,
            buttons: ['OK'],
          });
        }
      });

      mainWindow?.webContents.send('update:downloading');
    }
  });
});

// No update available
autoUpdater.on('update-not-available', () => {
  log.info('No updates available');

  // Resolve manual check promise if pending
  if (manualCheckResolver) {
    manualCheckResolver({ updateAvailable: false });
    manualCheckResolver = null;
  }
});

// Download progress
autoUpdater.on('download-progress', (progress) => {
  log.info(`Download progress: ${progress.percent.toFixed(1)}%`);
  broadcastToAllWindows('update:progress', progress.percent);
});

// Update downloaded
autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
  log.info('Update downloaded:', info.version);
  isDownloading = false;
  const wasFromAbout = isDownloadingFromAbout;
  isDownloadingFromAbout = false;

  // Broadcast to all windows (so About dialog can show restart button)
  broadcastToAllWindows('update:downloaded', info.version);

  // If download was from About dialog, don't show mainWindow dialog
  // (About dialog will show inline UI for restart)
  if (wasFromAbout || !mainWindow) return;

  isDialogOpen = true;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: 'Update downloaded!',
    detail: `Version ${info.version} has been downloaded and will be installed when you quit the app.\n\nWould you like to restart now?`,
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
  }).then((result) => {
    isDialogOpen = false;
    if (result.response === 0) {
      // User clicked Restart Now
      autoUpdater.quitAndInstall(false, true);
    }
  });
});

// Error handling
autoUpdater.on('error', (err) => {
  log.error('Auto-updater error:', err);
  const wasDownloading = isDownloading;
  const wasFromAbout = isDownloadingFromAbout;
  isDownloading = false;
  isDownloadingFromAbout = false;
  isDialogOpen = false;

  // Resolve manual check promise if pending (network error during check)
  if (manualCheckResolver) {
    manualCheckResolver({ updateAvailable: false, error: err.message });
    manualCheckResolver = null;
    return; // Don't show dialog - About window will handle it
  }

  // If downloading from About dialog, broadcast error to all windows
  if (wasFromAbout) {
    broadcastToAllWindows('update:error', err.message);
    return; // About dialog will show the error inline
  }

  // Only show error dialog if we were actively downloading
  // Silent failure for background update checks (e.g., no internet)
  if (wasDownloading && mainWindow) {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Update Error',
      message: 'Update failed',
      detail: `${err.message}\n\nYou can download updates manually from:\nhttps://github.com/William-Long-II/claudelander/releases`,
      buttons: ['OK'],
    });
  }
});
