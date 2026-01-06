# Teams Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Microsoft Teams Activity Feed notifications and refactor settings UI to sidebar layout.

**Architecture:** Two-phase approach - first refactor settings to sidebar layout with Integrations tab, then add Teams OAuth + Graph API notification dispatch. Reuses existing deep link auth pattern.

**Tech Stack:** Electron IPC, Microsoft Graph API, OAuth 2.0 PKCE flow, HTML/CSS/JS settings UI

---

## Phase 1: Settings UI Refactor

### Task 1: Create Sidebar Layout Structure

**Files:**
- Modify: `src/renderer/settings.html`

**Step 1: Replace body structure with sidebar layout**

Replace the current `<body>` content structure. Keep all existing styles but add new sidebar styles:

```html
<!-- Add to <style> section -->
.settings-layout {
  display: flex;
  height: 100vh;
  margin: -24px -40px; /* Offset body padding */
}

.settings-sidebar {
  width: 180px;
  background: #252526;
  border-right: 1px solid #3c3c3c;
  padding: 16px 0;
  flex-shrink: 0;
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  color: #888;
  cursor: pointer;
  font-size: 13px;
  border-left: 3px solid transparent;
  transition: all 0.15s ease;
}

.sidebar-item:hover {
  color: #d4d4d4;
  background: #2a2a2a;
}

.sidebar-item.active {
  color: #fff;
  background: #2a2a2a;
  border-left-color: #ff8c00;
}

.sidebar-icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
}

.settings-content {
  flex: 1;
  padding: 24px 40px;
  overflow-y: auto;
}

.settings-panel {
  display: none;
}

.settings-panel.active {
  display: block;
}
```

**Step 2: Create sidebar HTML**

Replace body content with:

```html
<body>
  <div class="settings-layout">
    <div class="settings-sidebar">
      <div class="sidebar-item active" data-panel="general">
        <span class="sidebar-icon">⚙️</span>
        <span>General</span>
      </div>
      <div class="sidebar-item" data-panel="appearance">
        <span class="sidebar-icon">🎨</span>
        <span>Appearance</span>
      </div>
      <div class="sidebar-item" data-panel="sounds">
        <span class="sidebar-icon">🔊</span>
        <span>Sounds</span>
      </div>
      <div class="sidebar-item" data-panel="integrations">
        <span class="sidebar-icon">🔗</span>
        <span>Integrations</span>
      </div>
      <div class="sidebar-item" data-panel="terminal">
        <span class="sidebar-icon">💻</span>
        <span>Terminal</span>
      </div>
    </div>

    <div class="settings-content">
      <div class="settings-container">
        <div class="header">
          <h1>Settings <span class="status-indicator" id="saveStatus"></span></h1>
          <button class="close-btn" onclick="window.close()" title="Close">&times;</button>
        </div>

        <!-- Panels go here - Task 2 -->

        <div class="footer">
          <button class="btn btn-secondary" onclick="resetDefaults()">Reset to Defaults</button>
          <button class="btn btn-primary" onclick="saveAndClose()">Save & Close</button>
        </div>
      </div>
    </div>
  </div>
</body>
```

**Step 3: Run app to verify layout renders**

Run: `npm run build:main && npm start`
Expected: Settings window shows sidebar on left, content area on right

**Step 4: Commit**

```bash
git add src/renderer/settings.html
git commit -m "refactor: add sidebar layout structure to settings"
```

---

### Task 2: Move Existing Settings into Panels

**Files:**
- Modify: `src/renderer/settings.html`

**Step 1: Wrap General settings in panel div**

```html
<!-- General Panel -->
<div id="panel-general" class="settings-panel active">
  <div class="section">
    <div class="section-title">Sessions</div>
    <!-- Auto-launch Claude row -->
    <!-- Custom Shell Path row -->
  </div>

  <div class="section">
    <div class="section-title">System</div>
    <!-- Close to Tray row (move from Notifications section) -->
  </div>
</div>
```

**Step 2: Create Appearance panel**

```html
<!-- Appearance Panel -->
<div id="panel-appearance" class="settings-panel">
  <div class="section">
    <div class="section-title">Splash Screen</div>
    <!-- Show Splash Screen row -->
    <!-- Splash Duration row -->
  </div>
</div>
```

**Step 3: Create Sounds panel**

```html
<!-- Sounds Panel -->
<div id="panel-sounds" class="settings-panel">
  <div class="section">
    <div class="section-title">Desktop Notifications</div>
    <!-- Enable Notifications row -->
    <!-- Notification Sound row -->
  </div>

  <div class="section">
    <div class="section-title">Sound Notifications</div>
    <!-- Master Volume row -->
    <!-- All sound event rows (waiting, error, start, complete) -->
  </div>
</div>
```

**Step 4: Create Integrations panel (placeholder)**

```html
<!-- Integrations Panel -->
<div id="panel-integrations" class="settings-panel">
  <div class="section">
    <div class="section-title">Connected Services</div>
    <p style="color: #888; font-size: 13px; padding: 12px 0;">
      Connect external services to receive notifications and share sessions.
    </p>

    <!-- GitHub card - placeholder for now -->
    <div class="integration-card">
      <div class="integration-header">
        <span class="integration-icon">⬛</span>
        <span class="integration-name">GitHub</span>
        <button class="btn-small" id="githubAuthBtn">Sign In</button>
      </div>
      <div class="integration-status">Not connected</div>
      <div class="integration-desc">Used for: Session sharing</div>
    </div>

    <!-- Teams card - placeholder -->
    <div class="integration-card">
      <div class="integration-header">
        <span class="integration-icon">🟦</span>
        <span class="integration-name">Microsoft Teams</span>
        <button class="btn-small" disabled>Coming Soon</button>
      </div>
      <div class="integration-status">Not available yet</div>
      <div class="integration-desc">Used for: Notifications</div>
    </div>
  </div>
</div>
```

**Step 5: Create Terminal panel**

```html
<!-- Terminal Panel -->
<div id="panel-terminal" class="settings-panel">
  <div class="section">
    <div class="section-title">Display</div>
    <!-- Font Size row -->
    <!-- WebGL Renderer row -->
  </div>
</div>
```

**Step 6: Test all panels have correct content**

Run: `npm run build && npm start`
Expected: All existing settings visible in appropriate panels

**Step 7: Commit**

```bash
git add src/renderer/settings.html
git commit -m "refactor: organize settings into tabbed panels"
```

---

### Task 3: Add Panel Switching JavaScript

**Files:**
- Modify: `src/renderer/settings.html`

**Step 1: Add panel switching logic**

Add to `<script>` section:

```javascript
// Panel switching
const sidebarItems = document.querySelectorAll('.sidebar-item');
const panels = document.querySelectorAll('.settings-panel');

sidebarItems.forEach(item => {
  item.addEventListener('click', () => {
    const panelId = item.dataset.panel;

    // Update sidebar active state
    sidebarItems.forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    // Show selected panel
    panels.forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${panelId}`).classList.add('active');

    // Save last selected panel
    if (window.settingsAPI?.setPreference) {
      window.settingsAPI.setPreference('settingsLastPanel', panelId);
    }
  });
});

// Restore last panel on load
async function restoreLastPanel() {
  if (window.settingsAPI?.getPreference) {
    const lastPanel = await window.settingsAPI.getPreference('settingsLastPanel');
    if (lastPanel) {
      const item = document.querySelector(`[data-panel="${lastPanel}"]`);
      if (item) item.click();
    }
  }
}
```

**Step 2: Call restoreLastPanel in loadSettings**

```javascript
async function loadSettings() {
  // ... existing code ...

  // At the end:
  restoreLastPanel();
}
```

**Step 3: Test panel switching**

Run: `npm run build && npm start`
Expected: Clicking sidebar items switches panels, selection persists after restart

**Step 4: Commit**

```bash
git add src/renderer/settings.html
git commit -m "feat: add panel switching with persistence"
```

---

### Task 4: Add Integration Card Styles

**Files:**
- Modify: `src/renderer/settings.html`

**Step 1: Add integration card CSS**

```css
.integration-card {
  background: #2d2d2d;
  border: 1px solid #3c3c3c;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 12px;
}

.integration-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.integration-icon {
  font-size: 24px;
}

.integration-name {
  font-size: 15px;
  font-weight: 600;
  flex: 1;
}

.integration-status {
  font-size: 12px;
  color: #888;
  margin-bottom: 4px;
}

.integration-status.connected {
  color: #4ade80;
}

.integration-desc {
  font-size: 11px;
  color: #666;
}

.integration-options {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #3c3c3c;
}

.integration-options .setting-row {
  padding: 8px 0;
}
```

**Step 2: Test integration cards render correctly**

Run: `npm run build && npm start`
Expected: Integration cards display with proper styling

**Step 3: Commit**

```bash
git add src/renderer/settings.html
git commit -m "style: add integration card components"
```

---

### Task 5: Wire Up GitHub Auth in Settings

**Files:**
- Modify: `src/renderer/settings.html`
- Modify: `src/main/preload-settings.ts`

**Step 1: Add GitHub auth APIs to preload-settings.ts**

```typescript
// Add to contextBridge.exposeInMainWorld('settingsAPI', {
  // GitHub auth
  githubLogin: (): Promise<void> => ipcRenderer.invoke('auth:login'),
  githubLogout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  githubGetUser: (): Promise<{ username: string; avatarUrl: string } | null> =>
    ipcRenderer.invoke('auth:getUser'),
```

**Step 2: Add auth state listener**

```typescript
// After contextBridge, add listener setup
ipcRenderer.on('auth:changed', (_, data) => {
  window.dispatchEvent(new CustomEvent('github-auth-changed', { detail: data }));
});
```

**Step 3: Add GitHub auth UI logic in settings.html**

```javascript
// GitHub auth handling
async function loadGithubStatus() {
  if (!window.settingsAPI?.githubGetUser) return;

  const user = await window.settingsAPI.githubGetUser();
  const btn = document.getElementById('githubAuthBtn');
  const status = document.querySelector('#panel-integrations .integration-card:first-child .integration-status');

  if (user) {
    btn.textContent = 'Sign Out';
    btn.onclick = githubLogout;
    status.textContent = user.username;
    status.classList.add('connected');
  } else {
    btn.textContent = 'Sign In';
    btn.onclick = githubLogin;
    status.textContent = 'Not connected';
    status.classList.remove('connected');
  }
}

async function githubLogin() {
  await window.settingsAPI.githubLogin();
}

async function githubLogout() {
  await window.settingsAPI.githubLogout();
  loadGithubStatus();
}

// Listen for auth changes
window.addEventListener('github-auth-changed', () => {
  loadGithubStatus();
});
```

**Step 4: Call loadGithubStatus in loadSettings**

```javascript
async function loadSettings() {
  // ... existing code ...
  loadGithubStatus();
  restoreLastPanel();
}
```

**Step 5: Test GitHub auth flow**

Run: `npm run build && npm start`
Expected: Can sign in/out of GitHub from Integrations tab

**Step 6: Commit**

```bash
git add src/renderer/settings.html src/main/preload-settings.ts
git commit -m "feat: add GitHub auth to Integrations panel"
```

---

## Phase 2: Microsoft Teams Integration

### Task 6: Create Teams Auth Service

**Files:**
- Create: `src/main/teams/teams-auth.ts`
- Create: `src/shared/teams-constants.ts`

**Step 1: Create constants file**

```typescript
// src/shared/teams-constants.ts
export const TEAMS_CLIENT_ID = 'YOUR_AZURE_APP_CLIENT_ID'; // TODO: Replace after Azure setup
export const TEAMS_REDIRECT_URI = 'https://claudelander.app/auth/teams/callback';
export const TEAMS_SCOPES = ['User.Read', 'TeamsActivity.Send'];
export const TEAMS_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const TEAMS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const GRAPH_API_URL = 'https://graph.microsoft.com/v1.0';
```

**Step 2: Create teams-auth.ts**

```typescript
// src/main/teams/teams-auth.ts
import { shell } from 'electron';
import { getPreference, setPreference } from '../repositories/preferences';
import {
  TEAMS_CLIENT_ID,
  TEAMS_REDIRECT_URI,
  TEAMS_SCOPES,
  TEAMS_AUTH_URL,
  TEAMS_TOKEN_URL,
  GRAPH_API_URL,
} from '../../shared/teams-constants';
import log from 'electron-log';
import crypto from 'crypto';

interface TeamsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TeamsUser {
  email: string;
  displayName: string;
}

class TeamsAuthService {
  private tokens: TeamsTokens | null = null;
  private user: TeamsUser | null = null;
  private codeVerifier: string | null = null;

  get isAuthenticated(): boolean {
    return this.tokens !== null && Date.now() < this.tokens.expiresAt;
  }

  get currentUser(): TeamsUser | null {
    return this.user;
  }

  /**
   * Initialize from stored tokens
   */
  async initialize(): Promise<void> {
    const storedTokens = getPreference('teamsTokens');
    if (storedTokens) {
      try {
        this.tokens = JSON.parse(storedTokens);
        if (this.tokens && Date.now() >= this.tokens.expiresAt) {
          await this.refreshAccessToken();
        }
        if (this.tokens) {
          await this.fetchUserInfo();
        }
      } catch (e) {
        log.error('Failed to restore Teams tokens:', e);
        this.logout();
      }
    }
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  private generatePKCE(): { verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
    return { verifier, challenge };
  }

  /**
   * Start OAuth flow
   */
  startLogin(): void {
    const { verifier, challenge } = this.generatePKCE();
    this.codeVerifier = verifier;

    const params = new URLSearchParams({
      client_id: TEAMS_CLIENT_ID,
      response_type: 'code',
      redirect_uri: TEAMS_REDIRECT_URI,
      scope: TEAMS_SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      response_mode: 'query',
    });

    const authUrl = `${TEAMS_AUTH_URL}?${params.toString()}`;
    shell.openExternal(authUrl);
  }

  /**
   * Handle OAuth callback
   */
  async handleCallback(code: string): Promise<TeamsUser> {
    if (!this.codeVerifier) {
      throw new Error('No code verifier - start login first');
    }

    const response = await fetch(TEAMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TEAMS_CLIENT_ID,
        grant_type: 'authorization_code',
        code,
        redirect_uri: TEAMS_REDIRECT_URI,
        code_verifier: this.codeVerifier,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = await response.json();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.codeVerifier = null;

    this.saveTokens();
    await this.fetchUserInfo();

    return this.user!;
  }

  /**
   * Refresh access token
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refreshToken) {
      throw new Error('No refresh token');
    }

    const response = await fetch(TEAMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TEAMS_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
      }),
    });

    if (!response.ok) {
      this.logout();
      throw new Error('Token refresh failed');
    }

    const data = await response.json();
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.tokens.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    this.saveTokens();
  }

  /**
   * Get valid access token (refresh if needed)
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new Error('Not authenticated');
    }

    if (Date.now() >= this.tokens.expiresAt - 60000) {
      await this.refreshAccessToken();
    }

    return this.tokens.accessToken;
  }

  /**
   * Fetch user info from Graph API
   */
  private async fetchUserInfo(): Promise<void> {
    const token = await this.getAccessToken();
    const response = await fetch(`${GRAPH_API_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch user info');
    }

    const data = await response.json();
    this.user = {
      email: data.mail || data.userPrincipalName,
      displayName: data.displayName,
    };
  }

  /**
   * Save tokens to preferences
   */
  private saveTokens(): void {
    if (this.tokens) {
      setPreference('teamsTokens', JSON.stringify(this.tokens));
    }
  }

  /**
   * Logout
   */
  logout(): void {
    this.tokens = null;
    this.user = null;
    setPreference('teamsTokens', '');
  }
}

export const teamsAuthService = new TeamsAuthService();
```

**Step 3: Commit**

```bash
git add src/main/teams/teams-auth.ts src/shared/teams-constants.ts
git commit -m "feat: add Teams OAuth authentication service"
```

---

### Task 7: Create Teams Notifier Service

**Files:**
- Create: `src/main/teams/teams-notifier.ts`

**Step 1: Create teams-notifier.ts**

```typescript
// src/main/teams/teams-notifier.ts
import { teamsAuthService } from './teams-auth';
import { getPreference } from '../repositories/preferences';
import { GRAPH_API_URL } from '../../shared/teams-constants';
import log from 'electron-log';

export type TeamsNotificationType = 'waiting' | 'error' | 'complete';

interface NotificationPayload {
  sessionId: string;
  sessionName: string;
  projectPath: string;
  type: TeamsNotificationType;
}

const ACTIVITY_TYPES: Record<TeamsNotificationType, string> = {
  waiting: 'sessionWaiting',
  error: 'sessionError',
  complete: 'sessionComplete',
};

const NOTIFICATION_MESSAGES: Record<TeamsNotificationType, string> = {
  waiting: 'needs your input',
  error: 'encountered an error',
  complete: 'finished the task',
};

class TeamsNotifier {
  /**
   * Check if Teams notifications are enabled for a specific type
   */
  isEnabled(type: TeamsNotificationType): boolean {
    if (!teamsAuthService.isAuthenticated) return false;

    const prefKey = `teamsNotify${type.charAt(0).toUpperCase() + type.slice(1)}`;
    const pref = getPreference(prefKey);
    return pref !== 'false'; // Default to true
  }

  /**
   * Send a notification to Teams
   */
  async sendNotification(payload: NotificationPayload): Promise<void> {
    if (!this.isEnabled(payload.type)) {
      return;
    }

    try {
      const token = await teamsAuthService.getAccessToken();
      const deepLink = `claudelander://session/${payload.sessionId}`;

      const response = await fetch(
        `${GRAPH_API_URL}/me/teamwork/sendActivityNotification`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            topic: {
              source: 'text',
              value: 'ClaudeLander',
              webUrl: deepLink,
            },
            activityType: ACTIVITY_TYPES[payload.type],
            previewText: {
              content: `${payload.sessionName} ${NOTIFICATION_MESSAGES[payload.type]}`,
            },
            templateParameters: [
              { name: 'sessionName', value: payload.sessionName },
              { name: 'projectPath', value: payload.projectPath },
            ],
          }),
        }
      );

      if (!response.ok) {
        const error = await response.text();
        log.error('Failed to send Teams notification:', error);
      }
    } catch (e) {
      log.error('Teams notification error:', e);
      // Silent fail - don't block app for notification failures
    }
  }

  /**
   * Send a test notification
   */
  async sendTestNotification(): Promise<boolean> {
    if (!teamsAuthService.isAuthenticated) {
      return false;
    }

    try {
      await this.sendNotification({
        sessionId: 'test',
        sessionName: 'Test Session',
        projectPath: '/test/project',
        type: 'complete',
      });
      return true;
    } catch {
      return false;
    }
  }
}

export const teamsNotifier = new TeamsNotifier();
```

**Step 2: Commit**

```bash
git add src/main/teams/teams-notifier.ts
git commit -m "feat: add Teams notification sender"
```

---

### Task 8: Wire Up Teams IPC Handlers

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/preload-settings.ts`

**Step 1: Add Teams imports and initialization to index.ts**

```typescript
// Add imports
import { teamsAuthService } from './teams/teams-auth';
import { teamsNotifier } from './teams/teams-notifier';

// In createWindow(), after other initializations:
teamsAuthService.initialize();
```

**Step 2: Add Teams IPC handlers to index.ts**

```typescript
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
```

**Step 3: Handle Teams OAuth callback in handleDeepLink**

```typescript
async function handleDeepLink(url: string) {
  log.info('Received deep link:', url);
  const parsed = new URL(url);

  if (parsed.hostname === 'auth' || parsed.pathname === '/auth') {
    const token = parsed.searchParams.get('token');
    if (token) {
      // Existing GitHub auth handling
    }
  }

  // Teams OAuth callback
  if (parsed.pathname === '/auth/teams' || parsed.hostname === 'auth' && parsed.pathname.includes('teams')) {
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
```

**Step 4: Add Teams APIs to preload-settings.ts**

```typescript
// Teams auth
teamsLogin: (): Promise<void> => ipcRenderer.invoke('teams:login'),
teamsLogout: (): Promise<void> => ipcRenderer.invoke('teams:logout'),
teamsGetStatus: (): Promise<{ connected: boolean; user: { email: string; displayName: string } | null }> =>
  ipcRenderer.invoke('teams:getStatus'),
teamsTestNotification: (): Promise<boolean> => ipcRenderer.invoke('teams:testNotification'),
```

**Step 5: Add Teams auth listener**

```typescript
ipcRenderer.on('teams:authChanged', (_, data) => {
  window.dispatchEvent(new CustomEvent('teams-auth-changed', { detail: data }));
});
```

**Step 6: Commit**

```bash
git add src/main/index.ts src/main/preload-settings.ts
git commit -m "feat: add Teams IPC handlers and deep link callback"
```

---

### Task 9: Add Teams UI to Settings

**Files:**
- Modify: `src/renderer/settings.html`

**Step 1: Update Teams integration card**

```html
<!-- Teams card -->
<div class="integration-card" id="teamsCard">
  <div class="integration-header">
    <span class="integration-icon">🟦</span>
    <span class="integration-name">Microsoft Teams</span>
    <button class="btn-small" id="teamsAuthBtn">Sign In</button>
  </div>
  <div class="integration-status" id="teamsStatus">Not connected</div>
  <div class="integration-desc">Used for: Notifications</div>

  <div class="integration-options" id="teamsOptions" style="display: none;">
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-label">Notify on waiting</div>
      </div>
      <div class="setting-control">
        <label class="toggle">
          <input type="checkbox" id="teamsNotifyWaiting" checked>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-label">Notify on errors</div>
      </div>
      <div class="setting-control">
        <label class="toggle">
          <input type="checkbox" id="teamsNotifyError" checked>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-label">Notify on complete</div>
      </div>
      <div class="setting-control">
        <label class="toggle">
          <input type="checkbox" id="teamsNotifyComplete" checked>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-info">
        <div class="setting-label">Test notification</div>
      </div>
      <div class="setting-control">
        <button class="btn-small" onclick="testTeamsNotification()">Send Test</button>
      </div>
    </div>
  </div>
</div>
```

**Step 2: Add Teams JavaScript**

```javascript
// Teams auth handling
async function loadTeamsStatus() {
  if (!window.settingsAPI?.teamsGetStatus) return;

  const status = await window.settingsAPI.teamsGetStatus();
  const btn = document.getElementById('teamsAuthBtn');
  const statusEl = document.getElementById('teamsStatus');
  const options = document.getElementById('teamsOptions');

  if (status.connected && status.user) {
    btn.textContent = 'Sign Out';
    btn.onclick = teamsLogout;
    statusEl.textContent = status.user.email;
    statusEl.classList.add('connected');
    options.style.display = 'block';

    // Load toggle states
    const settings = await window.settingsAPI.getAllSettings();
    document.getElementById('teamsNotifyWaiting').checked = settings.teamsNotifyWaiting !== 'false';
    document.getElementById('teamsNotifyError').checked = settings.teamsNotifyError !== 'false';
    document.getElementById('teamsNotifyComplete').checked = settings.teamsNotifyComplete !== 'false';
  } else {
    btn.textContent = 'Sign In';
    btn.onclick = teamsLogin;
    statusEl.textContent = 'Not connected';
    statusEl.classList.remove('connected');
    options.style.display = 'none';
  }
}

async function teamsLogin() {
  await window.settingsAPI.teamsLogin();
}

async function teamsLogout() {
  await window.settingsAPI.teamsLogout();
  loadTeamsStatus();
}

async function testTeamsNotification() {
  const success = await window.settingsAPI.teamsTestNotification();
  if (success) {
    alert('Test notification sent! Check your Teams activity feed.');
  } else {
    alert('Failed to send test notification.');
  }
}

window.addEventListener('teams-auth-changed', () => {
  loadTeamsStatus();
});
```

**Step 3: Add Teams prefs to saveAndClose**

```javascript
// In saveAndClose(), add:
await window.settingsAPI.setPreference('teamsNotifyWaiting',
  document.getElementById('teamsNotifyWaiting').checked.toString());
await window.settingsAPI.setPreference('teamsNotifyError',
  document.getElementById('teamsNotifyError').checked.toString());
await window.settingsAPI.setPreference('teamsNotifyComplete',
  document.getElementById('teamsNotifyComplete').checked.toString());
```

**Step 4: Call loadTeamsStatus in loadSettings**

```javascript
async function loadSettings() {
  // ... existing code ...
  loadGithubStatus();
  loadTeamsStatus();
  restoreLastPanel();
}
```

**Step 5: Test Teams UI**

Run: `npm run build && npm start`
Expected: Teams card shows sign in button, options appear when connected

**Step 6: Commit**

```bash
git add src/renderer/settings.html
git commit -m "feat: add Teams integration UI to settings"
```

---

### Task 10: Integrate Teams with Notification Manager

**Files:**
- Modify: `src/main/notification-manager.ts`
- Modify: `src/main/index.ts`

**Step 1: Add Teams dispatch to notification-manager.ts**

```typescript
import { teamsNotifier, TeamsNotificationType } from './teams/teams-notifier';

// Add to NotificationManager class:

/**
 * Send Teams notification for session event
 */
sendTeamsNotification(
  sessionId: string,
  sessionName: string,
  projectPath: string,
  type: TeamsNotificationType
): void {
  teamsNotifier.sendNotification({
    sessionId,
    sessionName,
    projectPath,
    type,
  });
}
```

**Step 2: Update handleStateChange in index.ts to send Teams notifications**

```typescript
function handleStateChange(sessionId: string, state: string, sessionName?: string): void {
  // ... existing code to get name and previousState ...

  // Desktop notification (existing)
  if (state === 'waiting') {
    notificationManager.showWaitingNotification({
      sessionId,
      sessionName: name,
      message: 'Waiting for input',
    });
  }

  // Teams notifications
  const session = sessionsRepo.getAllSessions().find(s => s.id === sessionId);
  const projectPath = session?.cwd || '';

  if (state === 'waiting') {
    notificationManager.sendTeamsNotification(sessionId, name, projectPath, 'waiting');
  } else if (state === 'error') {
    notificationManager.sendTeamsNotification(sessionId, name, projectPath, 'error');
  } else if (state === 'idle' && previousState === 'working') {
    notificationManager.sendTeamsNotification(sessionId, name, projectPath, 'complete');
  }

  // ... rest of existing code ...
}
```

**Step 3: Test end-to-end**

Run: `npm run build && npm start`
Expected: When session enters waiting/error/complete state, Teams notification is sent

**Step 4: Commit**

```bash
git add src/main/notification-manager.ts src/main/index.ts
git commit -m "feat: dispatch Teams notifications on session events"
```

---

### Task 11: Azure App Setup Documentation

**Files:**
- Create: `docs/azure-setup.md`

**Step 1: Write Azure setup guide**

```markdown
# Azure App Registration for Teams Notifications

## Prerequisites

- Microsoft 365 account with Teams
- Access to Azure Portal (portal.azure.com)

## Step 1: Register Application

1. Go to Azure Portal → Azure Active Directory → App registrations
2. Click "New registration"
3. Name: "ClaudeLander"
4. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
5. Redirect URI: Select "Public client/native" and enter: `https://claudelander.app/auth/teams/callback`
6. Click "Register"

## Step 2: Configure API Permissions

1. Go to "API permissions"
2. Click "Add a permission"
3. Select "Microsoft Graph" → "Delegated permissions"
4. Add:
   - `User.Read`
   - `TeamsActivity.Send`
5. Click "Grant admin consent" (if you have admin rights, otherwise users consent individually)

## Step 3: Configure Teams Activity Types

1. Go to "Expose an API"
2. Set Application ID URI (e.g., `api://claudelander`)
3. Create manifest file for Teams activity types (see below)

## Step 4: Get Client ID

1. Go to "Overview"
2. Copy "Application (client) ID"
3. Update `src/shared/teams-constants.ts` with this ID

## Teams Activity Types Manifest

Create Teams app manifest with activity types in Azure Portal or Teams Developer Portal.

Activity types needed:
- `sessionWaiting`: "⏳ {sessionName} needs input"
- `sessionError`: "❌ {sessionName} encountered an error"
- `sessionComplete`: "✅ {sessionName} finished"
```

**Step 2: Commit**

```bash
git add docs/azure-setup.md
git commit -m "docs: add Azure app registration guide"
```

---

## Final: Create PR

```bash
git push -u origin feature/6-teams-integration
gh pr create --base develop --title "feat: Teams integration with settings refactor" --body "$(cat <<'EOF'
## Summary

- Refactors settings UI to sidebar navigation layout
- Adds Integrations panel with GitHub and Teams cards
- Implements Microsoft Teams Activity Feed notifications
- Supports waiting, error, and task complete events

## Changes

### Settings UI
- Sidebar navigation with 5 tabs: General, Appearance, Sounds, Integrations, Terminal
- Remembers last selected tab
- Integration cards with sign in/out flow

### Teams Integration
- OAuth 2.0 PKCE authentication flow
- Microsoft Graph API for activity notifications
- Per-event notification toggles
- Test notification button

## Test Plan

- [ ] Settings sidebar navigation works
- [ ] All existing settings accessible in correct tabs
- [ ] GitHub auth works from Integrations tab
- [ ] Teams sign in opens browser OAuth flow
- [ ] Teams sign out clears tokens
- [ ] Notification toggles save correctly
- [ ] Test notification sends to Teams
- [ ] Session events trigger Teams notifications

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
