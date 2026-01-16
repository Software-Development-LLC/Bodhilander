# Settings Consolidation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate two separate settings interfaces (cog wheel SettingsModal and Ctrl+Comma settings window) into one unified SettingsModal.

**Architecture:** Extend the existing React SettingsModal component with 4 new tabs (General, Appearance, Terminal, Integrations), consolidate Sound with existing notifications tab, rename Mobile. Wire Ctrl+Comma keyboard shortcut to open the modal via IPC. Delete the standalone settings.html and preload-settings.ts files.

**Tech Stack:** React, TypeScript, Electron IPC

---

## Task 1: Update SettingsTab Type and Default Tab

**Files:**
- Modify: `src/renderer/components/SettingsModal.tsx:10`

**Step 1: Update the tab type and default state**

Change line 10 from:
```typescript
const [activeTab, setActiveTab] = useState<'general' | 'mobile' | 'notifications'>('mobile');
```

To:
```typescript
type SettingsTab = 'general' | 'appearance' | 'terminal' | 'sound' | 'integrations' | 'mobile';
const [activeTab, setActiveTab] = useState<SettingsTab>('general');
```

**Step 2: Build and verify no TypeScript errors**

Run: `npm run build:renderer`
Expected: Build succeeds (tabs will need updating)

**Step 3: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx
git commit -m "refactor: update SettingsTab type with all 6 tabs"
```

---

## Task 2: Add General Tab State and Handlers

**Files:**
- Modify: `src/renderer/components/SettingsModal.tsx`

**Step 1: Add state variables after line 37 (after volumeSaveTimerRef)**

```typescript
  // General settings state
  const [autoLaunchClaude, setAutoLaunchClaude] = useState(true);
  const [customShellPath, setCustomShellPath] = useState('');
  const [closeToTray, setCloseToTray] = useState(true);
```

**Step 2: Load General settings in the loadState function (after line 83, after completePref loading)**

Add these lines to the Promise.all array:
```typescript
          window.electronAPI.getPreference('autoLaunchClaude'),
          window.electronAPI.getPreference('customShellPath'),
          window.electronAPI.getPreference('closeToTray'),
```

Then destructure and set state after the sound settings:
```typescript
        const [
          soundEnabledPref,
          volumePref,
          debouncePref,
          waitingPref,
          errorPref,
          startPref,
          completePref,
          autoLaunchPref,
          shellPathPref,
          closeToTrayPref,
        ] = await Promise.all([
          // ... existing calls ...
          window.electronAPI.getPreference('autoLaunchClaude'),
          window.electronAPI.getPreference('customShellPath'),
          window.electronAPI.getPreference('closeToTray'),
        ]);

        // After existing sound state setters:
        setAutoLaunchClaude(autoLaunchPref === 'true');
        setCustomShellPath(shellPathPref || '');
        setCloseToTray(closeToTrayPref !== 'false');
```

**Step 3: Add handlers after handleTestSound (around line 243)**

```typescript
  // General setting handlers
  const handleAutoLaunchClaudeChange = useCallback(async (enabled: boolean) => {
    setAutoLaunchClaude(enabled);
    await window.electronAPI.setPreference('autoLaunchClaude', enabled.toString());
  }, []);

  const handleCustomShellPathChange = useCallback(async (path: string) => {
    setCustomShellPath(path);
    await window.electronAPI.setPreference('customShellPath', path);
  }, []);

  const handleCloseToTrayChange = useCallback(async (enabled: boolean) => {
    setCloseToTray(enabled);
    await window.electronAPI.setPreference('closeToTray', enabled.toString());
  }, []);
```

**Step 4: Build and verify**

Run: `npm run build:renderer`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx
git commit -m "feat: add General tab state and handlers"
```

---

## Task 3: Add General Tab UI

**Files:**
- Modify: `src/renderer/components/SettingsModal.tsx`

**Step 1: Replace the General tab placeholder content (lines 278-283)**

Replace:
```typescript
            {activeTab === 'general' && (
              <div className="settings-section">
                <h3>General Settings</h3>
                <p className="settings-placeholder">General settings coming soon...</p>
              </div>
            )}
```

With:
```typescript
            {activeTab === 'general' && (
              <div className="settings-section">
                <h3>General Settings</h3>

                <div className="settings-group">
                  <h4>Sessions</h4>
                  <div className="settings-row">
                    <label htmlFor="auto-launch-claude">Auto-launch Claude:</label>
                    <input
                      id="auto-launch-claude"
                      type="checkbox"
                      checked={autoLaunchClaude}
                      onChange={e => handleAutoLaunchClaudeChange(e.target.checked)}
                    />
                    <span className="settings-hint">Automatically start Claude when creating new sessions</span>
                  </div>

                  <div className="settings-row">
                    <label htmlFor="custom-shell-path">Custom Shell Path:</label>
                    <input
                      id="custom-shell-path"
                      type="text"
                      className="settings-text-input"
                      value={customShellPath}
                      onChange={e => handleCustomShellPathChange(e.target.value)}
                      placeholder="Auto-detect"
                    />
                    <span className="settings-hint">
                      {window.electronAPI.platform === 'win32'
                        ? 'e.g., C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
                        : 'e.g., /bin/bash, /bin/zsh'}
                    </span>
                  </div>
                </div>

                <div className="settings-group">
                  <h4>System</h4>
                  <div className="settings-row">
                    <label htmlFor="close-to-tray">Close to Tray:</label>
                    <input
                      id="close-to-tray"
                      type="checkbox"
                      checked={closeToTray}
                      onChange={e => handleCloseToTrayChange(e.target.checked)}
                    />
                    <span className="settings-hint">Minimize to system tray instead of quitting when closing window</span>
                  </div>
                </div>
              </div>
            )}
```

**Step 2: Build and verify**

Run: `npm run build:renderer`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx
git commit -m "feat: add General tab UI"
```

---

## Task 4: Add Appearance Tab

**Files:**
- Modify: `src/renderer/components/SettingsModal.tsx`

**Step 1: Add Appearance state variables (after General state)**

```typescript
  // Appearance settings state
  const [showSplash, setShowSplash] = useState(true);
  const [splashDuration, setSplashDuration] = useState(2.5);
```

**Step 2: Add Appearance settings to loadState Promise.all and state setters**

Add to Promise.all:
```typescript
          window.electronAPI.getPreference('showSplash'),
          window.electronAPI.getPreference('splashDuration'),
```

Add state setters:
```typescript
        setShowSplash(showSplashPref === 'true');
        setSplashDuration(splashDurationPref ? parseFloat(splashDurationPref) : 2.5);
```

**Step 3: Add handlers**

```typescript
  // Appearance setting handlers
  const handleShowSplashChange = useCallback(async (enabled: boolean) => {
    setShowSplash(enabled);
    await window.electronAPI.setPreference('showSplash', enabled.toString());
  }, []);

  const handleSplashDurationChange = useCallback(async (duration: number) => {
    setSplashDuration(duration);
    await window.electronAPI.setPreference('splashDuration', duration.toString());
  }, []);
```

**Step 4: Add nav button in settings-nav (after General button)**

```typescript
            <button
              className={`settings-nav-item ${activeTab === 'appearance' ? 'active' : ''}`}
              onClick={() => setActiveTab('appearance')}
            >
              Appearance
            </button>
```

**Step 5: Add Appearance tab content (after General tab content)**

```typescript
            {activeTab === 'appearance' && (
              <div className="settings-section">
                <h3>Appearance</h3>

                <div className="settings-group">
                  <h4>Splash Screen</h4>
                  <div className="settings-row">
                    <label htmlFor="show-splash">Show Splash Screen:</label>
                    <input
                      id="show-splash"
                      type="checkbox"
                      checked={showSplash}
                      onChange={e => handleShowSplashChange(e.target.checked)}
                    />
                    <span className="settings-hint">Display splash screen on startup</span>
                  </div>

                  <div className="settings-row">
                    <label htmlFor="splash-duration">Splash Duration:</label>
                    <input
                      type="range"
                      id="splash-duration"
                      min="1"
                      max="5"
                      step="0.5"
                      value={splashDuration}
                      onChange={e => handleSplashDurationChange(parseFloat(e.target.value))}
                    />
                    <span className="range-value">{splashDuration}s</span>
                  </div>
                </div>
              </div>
            )}
```

**Step 6: Build and verify**

Run: `npm run build:renderer`
Expected: Build succeeds

**Step 7: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx
git commit -m "feat: add Appearance tab"
```

---

## Task 5: Add Terminal Tab

**Files:**
- Modify: `src/renderer/components/SettingsModal.tsx`

**Step 1: Add Terminal state variables**

```typescript
  // Terminal settings state
  const [fontSize, setFontSize] = useState(14);
  const [webglRenderer, setWebglRenderer] = useState(true);
```

**Step 2: Add Terminal settings to loadState Promise.all and state setters**

Add to Promise.all:
```typescript
          window.electronAPI.getPreference('fontSize'),
          window.electronAPI.getPreference('webglRenderer'),
```

Add state setters:
```typescript
        setFontSize(fontSizePref ? parseInt(fontSizePref, 10) : 14);
        setWebglRenderer(webglRendererPref === 'true');
```

**Step 3: Add handlers**

```typescript
  // Terminal setting handlers
  const handleFontSizeChange = useCallback(async (size: number) => {
    setFontSize(size);
    await window.electronAPI.setPreference('fontSize', size.toString());
  }, []);

  const handleWebglRendererChange = useCallback(async (enabled: boolean) => {
    setWebglRenderer(enabled);
    await window.electronAPI.setPreference('webglRenderer', enabled.toString());
  }, []);
```

**Step 4: Add nav button (after Appearance)**

```typescript
            <button
              className={`settings-nav-item ${activeTab === 'terminal' ? 'active' : ''}`}
              onClick={() => setActiveTab('terminal')}
            >
              Terminal
            </button>
```

**Step 5: Add Terminal tab content (after Appearance)**

```typescript
            {activeTab === 'terminal' && (
              <div className="settings-section">
                <h3>Terminal</h3>

                <div className="settings-group">
                  <h4>Display</h4>
                  <div className="settings-row">
                    <label htmlFor="font-size">Font Size:</label>
                    <input
                      type="range"
                      id="font-size"
                      min="10"
                      max="24"
                      step="1"
                      value={fontSize}
                      onChange={e => handleFontSizeChange(parseInt(e.target.value, 10))}
                    />
                    <span className="range-value">{fontSize}px</span>
                  </div>

                  <div className="settings-row">
                    <label htmlFor="webgl-renderer">Enable WebGL Rendering:</label>
                    <input
                      id="webgl-renderer"
                      type="checkbox"
                      checked={webglRenderer}
                      onChange={e => handleWebglRendererChange(e.target.checked)}
                    />
                    <span className="settings-hint">Use GPU acceleration for terminal (recommended)</span>
                  </div>
                </div>
              </div>
            )}
```

**Step 6: Build and verify**

Run: `npm run build:renderer`
Expected: Build succeeds

**Step 7: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx
git commit -m "feat: add Terminal tab"
```

---

## Task 6: Update Sound Tab with Desktop Notifications Toggle

**Files:**
- Modify: `src/renderer/components/SettingsModal.tsx`

**Step 1: Add desktop notifications state**

```typescript
  // Desktop notifications state
  const [enableNotifications, setEnableNotifications] = useState(true);
```

**Step 2: Load preference in loadState**

Add to Promise.all:
```typescript
          window.electronAPI.getPreference('enableNotifications'),
```

Add state setter:
```typescript
        setEnableNotifications(enableNotificationsPref !== 'false');
```

**Step 3: Add handler**

```typescript
  const handleEnableNotificationsChange = useCallback(async (enabled: boolean) => {
    setEnableNotifications(enabled);
    await window.electronAPI.setPreference('enableNotifications', enabled.toString());
  }, []);
```

**Step 4: Update nav button (change 'notifications' to 'sound')**

```typescript
            <button
              className={`settings-nav-item ${activeTab === 'sound' ? 'active' : ''}`}
              onClick={() => setActiveTab('sound')}
            >
              Sound
            </button>
```

**Step 5: Update the sound tab condition and add Desktop Notifications section**

Change `{activeTab === 'notifications' && (` to `{activeTab === 'sound' && (`

Add Desktop Notifications section at the top of the Sound tab content:
```typescript
                <div className="settings-group">
                  <h4>Desktop Notifications</h4>
                  <div className="settings-row">
                    <label htmlFor="enable-notifications">Enable Notifications:</label>
                    <input
                      id="enable-notifications"
                      type="checkbox"
                      checked={enableNotifications}
                      onChange={e => handleEnableNotificationsChange(e.target.checked)}
                    />
                    <span className="settings-hint">Show system notifications when sessions need attention</span>
                  </div>
                </div>
```

**Step 6: Build and verify**

Run: `npm run build:renderer`
Expected: Build succeeds

**Step 7: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx
git commit -m "feat: update Sound tab with Desktop Notifications toggle"
```

---

## Task 7: Add Integrations Tab

**Files:**
- Modify: `src/renderer/components/SettingsModal.tsx`

**Step 1: Add GitHub auth state**

```typescript
  // Integrations state
  const [githubUser, setGithubUser] = useState<{ username: string } | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
```

**Step 2: Load GitHub user in loadState**

Add after existing state loading:
```typescript
        // Load GitHub user status
        try {
          const user = await window.electronAPI.getUser();
          setGithubUser(user);
        } catch {
          setGithubUser(null);
        }
```

**Step 3: Add handlers**

```typescript
  // Integrations handlers
  const handleGitHubLogin = useCallback(async () => {
    setGithubLoading(true);
    try {
      await window.electronAPI.login();
      const user = await window.electronAPI.getUser();
      setGithubUser(user);
    } catch (err) {
      console.error('GitHub login failed:', err);
    }
    setGithubLoading(false);
  }, []);

  const handleGitHubLogout = useCallback(async () => {
    setGithubLoading(true);
    try {
      await window.electronAPI.logout();
      setGithubUser(null);
    } catch (err) {
      console.error('GitHub logout failed:', err);
    }
    setGithubLoading(false);
  }, []);
```

**Step 4: Add useEffect to listen for auth changes (after loadState useEffect)**

```typescript
  // Listen for GitHub auth changes
  useEffect(() => {
    const unsubscribe = window.electronAPI.onAuthChanged(async () => {
      try {
        const user = await window.electronAPI.getUser();
        setGithubUser(user);
      } catch {
        setGithubUser(null);
      }
    });
    return unsubscribe;
  }, []);
```

**Step 5: Add nav button (after Sound, before Mobile App)**

```typescript
            <button
              className={`settings-nav-item ${activeTab === 'integrations' ? 'active' : ''}`}
              onClick={() => setActiveTab('integrations')}
            >
              Integrations
            </button>
```

**Step 6: Add Integrations tab content**

```typescript
            {activeTab === 'integrations' && (
              <div className="settings-section">
                <h3>Integrations</h3>
                <p className="settings-description">
                  Connect external services to receive notifications and share sessions.
                </p>

                <div className="settings-group integration-card">
                  <div className="integration-header">
                    <span className={`integration-status-dot ${githubUser ? 'connected' : ''}`} />
                    <h4>GitHub</h4>
                  </div>
                  <p className="integration-status">
                    {githubUser ? `Connected as ${githubUser.username}` : 'Not connected'}
                  </p>
                  <p className="settings-hint">Used for: Session sharing</p>
                  <div className="settings-actions">
                    {githubUser ? (
                      <button
                        className="btn btn-danger"
                        onClick={handleGitHubLogout}
                        disabled={githubLoading}
                      >
                        {githubLoading ? 'Signing Out...' : 'Sign Out'}
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary"
                        onClick={handleGitHubLogin}
                        disabled={githubLoading}
                      >
                        {githubLoading ? 'Signing In...' : 'Sign In'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="settings-group integration-card disabled">
                  <div className="integration-header">
                    <span className="integration-status-dot" />
                    <h4>Microsoft Teams</h4>
                  </div>
                  <p className="integration-status">Coming Soon</p>
                  <p className="settings-hint">Used for: Notifications</p>
                  <div className="settings-actions">
                    <button className="btn btn-secondary" disabled>
                      Coming Soon
                    </button>
                  </div>
                </div>
              </div>
            )}
```

**Step 7: Build and verify**

Run: `npm run build:renderer`
Expected: Build succeeds

**Step 8: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx
git commit -m "feat: add Integrations tab with GitHub auth"
```

---

## Task 8: Add CSS for New Tab Elements

**Files:**
- Modify: `src/renderer/styles/global.css`

**Step 1: Add CSS for new elements (at the end of the file, in the settings modal section)**

```css
/* Settings text input */
.settings-text-input {
  background: #2d2d2d;
  border: 1px solid #3c3c3c;
  color: #d4d4d4;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 13px;
  width: 300px;
}

.settings-text-input:focus {
  outline: none;
  border-color: #ff8c00;
}

.settings-text-input::placeholder {
  color: #666;
}

/* Range value display */
.range-value {
  font-size: 13px;
  color: #888;
  min-width: 50px;
  text-align: right;
}

/* Integration cards */
.integration-card {
  background: #2d2d2d;
  border: 1px solid #3c3c3c;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 12px;
}

.integration-card.disabled {
  opacity: 0.5;
}

.integration-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.integration-header h4 {
  margin: 0;
  font-size: 14px;
}

.integration-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #666;
}

.integration-status-dot.connected {
  background: #4ade80;
}

.integration-status {
  font-size: 12px;
  color: #888;
  margin-bottom: 4px;
}
```

**Step 2: Build and verify**

Run: `npm run build:renderer`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/renderer/styles/global.css
git commit -m "feat: add CSS for new settings tab elements"
```

---

## Task 9: Add IPC Channel for Opening Settings

**Files:**
- Modify: `src/main/preload.ts`

**Step 1: Add onOpenSettings listener (after onSessionSelect, around line 71)**

```typescript
  // Settings modal trigger
  onOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('open-settings', listener);
    return () => ipcRenderer.removeListener('open-settings', listener);
  },
```

**Step 2: Build and verify**

Run: `npm run build:main`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/main/preload.ts
git commit -m "feat: add onOpenSettings IPC listener in preload"
```

---

## Task 10: Update App.tsx to Listen for open-settings Event

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: Add useEffect to listen for open-settings event (near other menu listener useEffects)**

Find the section with onMenuNewSession listeners and add:

```typescript
  // Listen for settings modal open event
  useEffect(() => {
    const unsubscribe = window.electronAPI.onOpenSettings(() => {
      setSettingsOpen(true);
    });
    return unsubscribe;
  }, []);
```

**Step 2: Build and verify**

Run: `npm run build:renderer`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: add listener for open-settings IPC event"
```

---

## Task 11: Update Menu to Send IPC Instead of Opening Window

**Files:**
- Modify: `src/main/menu.ts`

**Step 1: Remove showSettingsWindow function (lines 15-40 approximately)**

Delete the entire `export function showSettingsWindow` function.

**Step 2: Update the Settings menu item to send IPC**

Find the Settings menu item (around line 70-75):
```typescript
      {
        label: 'Settings',
        accelerator: 'CmdOrCtrl+,',
        click: () => showSettingsWindow(mainWindow),
      },
```

Change it to:
```typescript
      {
        label: 'Settings',
        accelerator: 'CmdOrCtrl+,',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('open-settings');
          }
        },
      },
```

**Step 3: Remove the import of showSettingsWindow if it was exported elsewhere, and clean up unused imports**

Remove path import if no longer needed:
```typescript
import * as path from 'path';
```

**Step 4: Build and verify**

Run: `npm run build:main`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add src/main/menu.ts
git commit -m "feat: change Ctrl+Comma to open SettingsModal via IPC"
```

---

## Task 12: Delete Old Settings Files

**Files:**
- Delete: `src/renderer/settings.html`
- Delete: `src/main/preload-settings.ts`

**Step 1: Check if preload-settings.ts exists and is referenced**

Run: `grep -r "preload-settings" src/`

If there are references, they need to be removed.

**Step 2: Delete the files**

```bash
rm src/renderer/settings.html
rm src/main/preload-settings.ts
```

**Step 3: Remove preload-settings from webpack config if present**

Check `webpack.config.js` for any references and remove them.

**Step 4: Build and verify**

Run: `npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove old settings window files"
```

---

## Task 13: Update TypeScript Declaration for electronAPI

**Files:**
- Modify: `src/renderer/types/electron.d.ts` (or create if doesn't exist)

**Step 1: Check if declaration file exists**

Run: `ls src/renderer/types/` or check for global.d.ts

**Step 2: Add onOpenSettings to the electronAPI type declaration**

If there's an existing declaration file, add:
```typescript
onOpenSettings: (callback: () => void) => () => void;
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/renderer/types/
git commit -m "chore: add onOpenSettings to electronAPI type declaration"
```

---

## Task 14: Final Integration Test

**Files:**
- None (manual testing)

**Step 1: Start the application**

Run: `npm start`

**Step 2: Test all 6 tabs in the cog wheel SettingsModal**

- Click cog wheel icon
- Verify General tab is default
- Navigate through all tabs: General, Appearance, Terminal, Sound, Integrations, Mobile App
- Verify each tab shows the correct settings

**Step 3: Test Ctrl+Comma shortcut**

- Press Ctrl+Comma (or Cmd+Comma on Mac)
- Verify SettingsModal opens

**Step 4: Test settings persistence**

- Change a setting in each tab
- Close and reopen the modal
- Verify settings are persisted

**Step 5: Test GitHub integration**

- Navigate to Integrations tab
- Test Sign In/Sign Out flow

**Step 6: Commit final verification**

```bash
git add -A
git commit -m "feat: complete settings consolidation"
```
