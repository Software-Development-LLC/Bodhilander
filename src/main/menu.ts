import { Menu, shell, app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import log from 'electron-log';

const aboutPreloadPath = path.join(__dirname, 'preload-about.js');

let aboutWindow: BrowserWindow | null = null;

function showAboutWindow(parentWindow: BrowserWindow): void {
  if (aboutWindow) {
    aboutWindow.focus();
    return;
  }

  aboutWindow = new BrowserWindow({
    width: 520,
    height: 680,
    parent: parentWindow,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: aboutPreloadPath,
    },
  });

  // Hide menu bar for About window
  aboutWindow.setMenuBarVisibility(false);

  const version = app.getVersion();
  aboutWindow.loadFile(path.join(__dirname, '../renderer/about.html'), {
    query: { version },
  });

  // Handle close request from about page
  ipcMain.on('about:close', () => {
    aboutWindow?.close();
  });

  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });

  // Close on Escape key
  aboutWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape') {
      aboutWindow?.close();
    }
  });
}

export function createApplicationMenu(mainWindow: BrowserWindow): void {
  const isMac = process.platform === 'darwin';

  // BARE CTRL ALWAYS BELONGS TO THE TERMINAL.
  //
  // This is a terminal app, so Ctrl+<letter> is not ours to spend - the PTY needs it.
  // 'CmdOrCtrl+X' looks convenient but it aliases Cmd and Ctrl, which on Windows/Linux
  // hands the menu every control code the shell depends on. Concretely, before this
  // change 'CmdOrCtrl+C' meant the menu swallowed Ctrl+C on Windows/Linux and a running
  // process could never be sent SIGINT; 'CmdOrCtrl+A' ate readline beginning-of-line,
  // 'CmdOrCtrl+K' ate kill-to-EOL and 'CmdOrCtrl+F' ate forward-char.
  //
  // So app actions use Cmd on macOS (where Ctrl is free because the terminal keeps it)
  // and Ctrl+Shift on Windows/Linux (where bare Ctrl must pass through). This is the
  // same scheme Windows Terminal, GNOME Terminal and iTerm2 use.
  //
  // Two deliberate exceptions below, each commented where it appears:
  //   - Next/Previous Session are literally Ctrl+Tab / Ctrl+Shift+Tab on both platforms.
  //   - Settings stays CmdOrCtrl+, because ',' is not a terminal key on any platform.
  //
  // AND: an Electron `role` is not accelerator-free. Every role carries a default
  // accelerator, and unless the role sets registerAccelerator:false it is registered in
  // MAIN - so it is consumed before the renderer, and long before the PTY, ever sees the
  // key. cut/copy/paste are the registerAccelerator:false ones (display-only, the key
  // still reaches the page); undo/redo/quit/reload/forceReload/devTools/zoom all really
  // register. Worse, `accelerator: undefined` does NOT clear a role default - MenuItem's
  // overrideProperty only fills in the default when the value is null/undefined - so the
  // only way to take a chord back from a role is to pin an explicit string on it. Every
  // role below that could otherwise land on a bare Ctrl+<letter> is pinned for that reason.
  const mod = isMac ? 'Cmd' : 'Ctrl+Shift';

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        {
          // ',' is not a terminal key, so CmdOrCtrl is safe here and matches the
          // platform convention on both sides (Cmd+, on macOS, Ctrl+, elsewhere).
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('open-settings');
            }
          },
        },
        {
          // The sidebar's key icon button was removed, so the Settings modal's own nav
          // was the only remaining way to reach the Claude accounts list. Deliberately
          // no accelerator: this is a rarely-visited destination and in a terminal app
          // every spare chord is one the shell no longer gets.
          label: 'Claude Accounts...',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('menu:open-accounts');
            }
          },
        },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        // Left untouched on purpose: the role's macOS accelerator is Cmd+Q, which is
        // the app modifier here and what every Mac user expects. Only the non-mac copy
        // of this role (in the Session menu) needs pinning - see the note there.
        { role: 'quit' as const },
      ],
    }] : []),

    // Session menu
    {
      label: 'Session',
      submenu: [
        {
          label: 'New Session',
          accelerator: `${mod}+N`,
          click: () => mainWindow.webContents.send('menu:new-session'),
        },
        {
          label: 'Close Session',
          accelerator: `${mod}+W`,
          click: () => mainWindow.webContents.send('menu:close-session'),
        },
        { type: 'separator' },
        // Tab is not a readline key, so bare Ctrl+Tab is safe to take on every platform -
        // and we MUST take it there, because Cmd+Tab on macOS is the OS app switcher and
        // never reaches the app at all. Hardcoded, not `mod`, on purpose.
        {
          label: 'Next Session',
          accelerator: 'Ctrl+Tab',
          click: () => mainWindow.webContents.send('menu:next-session'),
        },
        {
          label: 'Previous Session',
          accelerator: 'Ctrl+Shift+Tab',
          click: () => mainWindow.webContents.send('menu:prev-session'),
        },
        {
          // Shift is already baked into `mod` on Windows/Linux, so spell this one out
          // rather than producing 'Ctrl+Shift+Shift+J'.
          label: 'Next Waiting',
          accelerator: isMac ? 'Cmd+Shift+J' : 'Ctrl+Shift+J',
          click: () => mainWindow.webContents.send('menu:next-waiting'),
        },
        ...(isMac ? [] : [
          { type: 'separator' as const },
          {
            // Hidden menu item to register Ctrl+, accelerator on Windows/Linux
            label: 'Settings',
            accelerator: 'CmdOrCtrl+,',
            visible: false,
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('open-settings');
              }
            },
          },
          {
            // Mirrors the macOS App menu entry; see the note there for why it has no
            // accelerator.
            label: 'Claude Accounts...',
            click: () => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('menu:open-accounts');
              }
            },
          },
          { type: 'separator' as const },
          {
            // { role: 'quit' } has accelerator `isWin ? undefined : 'CommandOrControl+Q'`,
            // and role accelerators register in main. So on LINUX - not Windows, which is
            // why this hid for so long - the role silently owned bare Ctrl+Q. Ctrl+Q is
            // XON, the flow-control resume every user types by reflex after fat-fingering
            // Ctrl+S, and instead of reaching the PTY it quit the app and took every
            // running session down with it. Pin it to the app modifier on both non-mac
            // platforms (Windows gains a shortcut it never had; that is the point).
            role: 'quit' as const,
            accelerator: `${mod}+Q`,
          },
        ]),
      ],
    },

    // Edit menu - wired to terminal copy/paste when terminal is focused
    {
      label: 'Edit',
      submenu: [
        {
          // Default is 'CommandOrControl+Z' and it registers, so off macOS this role was
          // eating bare Ctrl+Z - SIGTSTP, suspend-the-foreground-job - and spending it on
          // a webContents.undo() that no-ops against xterm's hidden textarea.
          role: 'undo',
          accelerator: `${mod}+Z`,
        },
        {
          // Default is 'Control+Y' on WINDOWS specifically (elsewhere Shift+CmdOrCtrl+Z),
          // and Ctrl+Y is readline yank. Shift is already baked into `mod` off macOS, so
          // spell both sides out rather than emitting 'Ctrl+Shift+Shift+Z'.
          role: 'redo',
          accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Shift+Y',
        },
        { type: 'separator' },
        { role: 'cut' },
        {
          // Ctrl+Shift+C on Windows/Linux, NOT Ctrl+C: bare Ctrl+C has to reach the PTY
          // so a running process can be interrupted with SIGINT.
          label: 'Copy',
          accelerator: `${mod}+C`,
          click: () => {
            // Send to renderer which will check if terminal has selection
            mainWindow.webContents.send('menu:copy');
          },
        },
        {
          label: 'Paste',
          accelerator: `${mod}+V`,
          click: () => {
            mainWindow.webContents.send('menu:paste');
          },
        },
        { type: 'separator' },
        {
          // Bare Ctrl+A is readline beginning-of-line; leave it to the terminal.
          label: 'Select All',
          accelerator: `${mod}+A`,
          click: () => {
            mainWindow.webContents.send('menu:selectAll');
          },
        },
        {
          // Bare Ctrl+K is readline kill-to-end-of-line; leave it to the terminal.
          label: 'Clear Terminal',
          accelerator: `${mod}+K`,
          click: () => {
            mainWindow.webContents.send('menu:clearTerminal');
          },
        },
        // 'Find' (CmdOrCtrl+F -> 'menu:find') was removed: nothing in the renderer ever
        // subscribed to it and no xterm search addon is installed, so the item did
        // nothing except swallow Ctrl+F (readline forward-char) from the terminal.
      ],
    },

    // View menu
    // The content-area destinations go ABOVE the Electron roles, separated from them:
    // these three mirror the in-app tab strip and are what users actually reach for,
    // while reload/devtools/zoom below are developer + window plumbing.
    // Digits (not letters) on purpose - the roles below own the reload, devtools and
    // zoom chords, and digits stay clear of all of them on both platforms.
    {
      label: 'View',
      submenu: [
        {
          label: 'Terminal',
          accelerator: `${mod}+1`,
          click: () => mainWindow.webContents.send('menu:view-terminal'),
        },
        {
          label: 'Analytics',
          accelerator: `${mod}+2`,
          click: () => mainWindow.webContents.send('menu:view-analytics'),
        },
        {
          label: 'Arena',
          accelerator: `${mod}+3`,
          click: () => mainWindow.webContents.send('menu:view-arena'),
        },
        { type: 'separator' },
        {
          // Replaces the old Mod+Q binding, which was unreachable on macOS: the App
          // menu's { role: 'quit' } claims Cmd+Q in main and the renderer never saw it.
          // Ctrl+Shift+B on Windows/Linux also dodges tmux's Ctrl+B prefix key.
          label: 'Focus Sidebar',
          accelerator: `${mod}+B`,
          click: () => mainWindow.webContents.send('menu:focus-sidebar'),
        },
        { type: 'separator' },
        {
          // Default is 'CmdOrCtrl+R' and it registers, so off macOS this role owned bare
          // Ctrl+R - readline reverse-i-search, the chord a shell user reaches for most
          // after Ctrl+C. Pressing it did not search history: it reloaded the renderer,
          // unmounting every Terminal and every session view.
          role: 'reload',
          accelerator: `${mod}+R`,
        },
        {
          // forceReload's default is 'Shift+CmdOrCtrl+R', which off macOS is byte-for-byte
          // the Ctrl+Shift+R that Reload now takes - two items on one chord means only the
          // first one ever fires. macOS keeps the browser-standard Cmd+Shift+R; Windows and
          // Linux take the Alt variant, which no shell or readline binding uses. Neither
          // side is a bare Ctrl chord, which is the only hard requirement here.
          role: 'forceReload',
          accelerator: isMac ? 'Cmd+Shift+R' : 'Ctrl+Shift+Alt+R',
        },
        {
          // Pinned rather than trusted. This role's default already happens to fit the
          // scheme (Alt+Cmd+I on macOS, Ctrl+Shift+I elsewhere - no bare Ctrl either way),
          // but every other role default in this file turned out to be a trap, so the
          // value is stated here instead of inherited from whatever Electron ships next.
          role: 'toggleDevTools',
          accelerator: isMac ? 'Alt+Cmd+I' : `${mod}+I`,
        },
        { type: 'separator' },
        // The zoom roles keep their defaults: bare Ctrl+0 / Ctrl+Plus / Ctrl+- on
        // Windows/Linux. Left alone deliberately - '0', '+' and '-' are not readline or
        // control-code keys (a terminal only sees Ctrl+<letter> as a control character),
        // so nothing in the PTY loses anything by the menu holding them.
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        // F11 off macOS, Ctrl+Cmd+F on macOS. Neither is a bare Ctrl chord; F11 is the
        // universal fullscreen key and is left as-is.
        { role: 'togglefullscreen' },
      ],
    },

    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Bodhilander',
          click: () => showAboutWindow(mainWindow),
        },
        { type: 'separator' },
        {
          label: 'Documentation',
          click: () => {
            void shell.openExternal('https://github.com/Software-Development-LLC/Bodhilander');
          },
        },
        {
          label: 'Report Issue',
          click: () => {
            void shell.openExternal('https://github.com/Software-Development-LLC/Bodhilander/issues');
          },
        },
        {
          label: 'Open Log Folder',
          click: () => {
            const logFile = log.transports.file.getFile()?.path;
            if (logFile) {
              shell.showItemInFolder(logFile);
            }
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
