# Client-Side Session Sharing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add session sharing capabilities to the ClaudeLander Electron app, enabling users to share live sessions with configurable permissions via SYCLX-XXXXXX codes.

**Architecture:** New sharing module in main process handles crypto, WebSocket relay connection, and auth. Renderer gets new components for share/join modals and account management. IPC bridges the two.

**Tech Stack:** sodium-native (libsodium), socket.io-client, electron (deep links for OAuth callback)

**Prerequisite:** Relay server must be running at api.sytanek.tech (or localhost:3000 for development)

---

## Phase 1: Dependencies & Configuration

### Task 1: Install Sharing Dependencies

**Files:**
- Modify: `package.json`
- Create: `src/shared/constants.ts`

**Step 1: Install dependencies**

```bash
npm install sodium-native socket.io-client
npm install -D @types/sodium-native
```

**Step 2: Create constants file**

Create `src/shared/constants.ts`:
```typescript
export const RELAY_URL = process.env.NODE_ENV === 'development'
  ? 'http://localhost:3000'
  : 'https://api.sytanek.tech';

export const TIER_LIMITS = {
  free: { maxShares: 1, maxViewers: 2, maxDuration: 30, maxCodes: 2 },
  pro: { maxShares: 5, maxViewers: 10, maxDuration: null, maxCodes: null },
  admin: { maxShares: null, maxViewers: null, maxDuration: null, maxCodes: null },
} as const;

export type UserTier = 'free' | 'pro' | 'admin';
```

**Step 3: Commit**

```bash
git add .
git commit -m "chore: add sharing dependencies and constants"
```

---

### Task 2: Add Sharing Types

**Files:**
- Modify: `src/shared/types.ts`

**Step 1: Add sharing types**

Append to `src/shared/types.ts`:
```typescript
// Sharing types
export interface ShareUser {
  id: string;
  username: string;
  email?: string;
  tier: 'free' | 'pro' | 'admin';
}

export interface ShareSession {
  id: string;
  hostPublicKey: string;
  startedAt: string;
  codes: ShareCode[];
}

export interface ShareCode {
  code: string;
  permission: 'read' | 'control';
  maxUses: number | null;
  currentUses: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface CreateCodeOptions {
  permission: 'read' | 'control';
  maxUses?: number;
  expiresInMinutes?: number;
}

export interface SharedSessionInfo {
  sessionId: string;
  hostUsername: string;
  permission: 'read' | 'control';
  connectedAt: Date;
}

export interface GuestInfo {
  userId: string;
  username: string;
  permission: 'read' | 'control';
  publicKey: string;
}
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: add sharing type definitions"
```

---

## Phase 2: Crypto Module

### Task 3: Implement E2E Encryption

**Files:**
- Create: `src/main/sharing/crypto.ts`

**Step 1: Create crypto module**

Create `src/main/sharing/crypto.ts`:
```typescript
import sodium from 'sodium-native';

export interface KeyPair {
  publicKey: Buffer;
  secretKey: Buffer;
}

export interface EncryptedMessage {
  ciphertext: Buffer;
  nonce: Buffer;
}

/**
 * Generate an X25519 key pair for key exchange
 */
export function generateKeyPair(): KeyPair {
  const publicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
  const secretKey = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
  sodium.crypto_box_keypair(publicKey, secretKey);
  return { publicKey, secretKey };
}

/**
 * Derive a shared secret from our secret key and their public key
 */
export function deriveSharedSecret(
  ourSecretKey: Buffer,
  theirPublicKey: Buffer,
): Buffer {
  const sharedSecret = Buffer.alloc(sodium.crypto_box_BEFORENMBYTES);
  sodium.crypto_box_beforenm(sharedSecret, theirPublicKey, ourSecretKey);
  return sharedSecret;
}

/**
 * Encrypt a message using XChaCha20-Poly1305
 */
export function encrypt(
  message: Buffer | string,
  sharedSecret: Buffer,
): EncryptedMessage {
  const messageBuffer = Buffer.isBuffer(message)
    ? message
    : Buffer.from(message, 'utf-8');

  const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
  sodium.randombytes_buf(nonce);

  const ciphertext = Buffer.alloc(
    messageBuffer.length + sodium.crypto_secretbox_MACBYTES,
  );

  sodium.crypto_secretbox_easy(ciphertext, messageBuffer, nonce, sharedSecret);

  return { ciphertext, nonce };
}

/**
 * Decrypt a message using XChaCha20-Poly1305
 */
export function decrypt(
  ciphertext: Buffer,
  nonce: Buffer,
  sharedSecret: Buffer,
): Buffer {
  const message = Buffer.alloc(
    ciphertext.length - sodium.crypto_secretbox_MACBYTES,
  );

  const success = sodium.crypto_secretbox_open_easy(
    message,
    ciphertext,
    nonce,
    sharedSecret,
  );

  if (!success) {
    throw new Error('Decryption failed - message may be corrupted or tampered');
  }

  return message;
}

/**
 * Convert buffer to base64 for transmission
 */
export function toBase64(buffer: Buffer): string {
  return buffer.toString('base64');
}

/**
 * Convert base64 to buffer
 */
export function fromBase64(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: add E2E encryption with libsodium"
```

---

## Phase 3: Auth Module

### Task 4: Implement Auth Service

**Files:**
- Create: `src/main/sharing/auth.ts`

**Step 1: Create auth module**

Create `src/main/sharing/auth.ts`:
```typescript
import { BrowserWindow, shell } from 'electron';
import { RELAY_URL } from '../../shared/constants';
import { ShareUser } from '../../shared/types';
import log from 'electron-log';

interface AuthState {
  token: string | null;
  user: ShareUser | null;
}

class AuthService {
  private state: AuthState = {
    token: null,
    user: null,
  };

  private tokenStorageKey = 'claudelander_auth_token';

  constructor() {
    // Load token from localStorage equivalent would be in renderer
    // For main process, we'll receive it via IPC
  }

  get isAuthenticated(): boolean {
    return this.state.token !== null;
  }

  get currentUser(): ShareUser | null {
    return this.state.user;
  }

  get token(): string | null {
    return this.state.token;
  }

  /**
   * Start GitHub OAuth flow by opening browser
   */
  startLogin(): void {
    const authUrl = `${RELAY_URL}/auth/github`;
    shell.openExternal(authUrl);
  }

  /**
   * Handle the OAuth callback with token
   * Called when deep link claudelander://auth?token=xxx is received
   */
  async handleCallback(token: string): Promise<ShareUser> {
    this.state.token = token;

    // Fetch user info
    const response = await fetch(`${RELAY_URL}/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      this.state.token = null;
      throw new Error('Failed to fetch user info');
    }

    const user = (await response.json()) as ShareUser;
    this.state.user = user;

    log.info('User authenticated:', user.username);
    return user;
  }

  /**
   * Set token directly (for restoring from storage)
   */
  async setToken(token: string): Promise<ShareUser | null> {
    try {
      return await this.handleCallback(token);
    } catch (e) {
      log.error('Failed to restore token:', e);
      return null;
    }
  }

  /**
   * Log out
   */
  logout(): void {
    this.state.token = null;
    this.state.user = null;
  }

  /**
   * Get auth headers for API requests
   */
  getHeaders(): Record<string, string> {
    if (!this.state.token) {
      throw new Error('Not authenticated');
    }
    return {
      Authorization: `Bearer ${this.state.token}`,
      'Content-Type': 'application/json',
    };
  }
}

export const authService = new AuthService();
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: add auth service for GitHub OAuth"
```

---

### Task 5: Register Deep Link Protocol

**Files:**
- Modify: `src/main/index.ts`

**Step 1: Add protocol handler registration**

Add to `src/main/index.ts` after imports:
```typescript
import { authService } from './sharing/auth';

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
}
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: register claudelander:// deep link protocol"
```

---

## Phase 4: Relay Client

### Task 6: Implement Relay Client

**Files:**
- Create: `src/main/sharing/relay-client.ts`

**Step 1: Create relay client**

Create `src/main/sharing/relay-client.ts`:
```typescript
import { io, Socket } from 'socket.io-client';
import { EventEmitter } from 'events';
import { RELAY_URL } from '../../shared/constants';
import { authService } from './auth';
import * as crypto from './crypto';
import log from 'electron-log';

interface RelayEvents {
  connected: () => void;
  disconnected: () => void;
  guestJoined: (info: { userId: string; guestPublicKey: string; permission: string }) => void;
  guestLeft: (info: { userId: string }) => void;
  data: (data: Buffer) => void;
  error: (error: Error) => void;
}

export class RelayClient extends EventEmitter {
  private socket: Socket | null = null;
  private keyPair: crypto.KeyPair | null = null;
  private sharedSecrets: Map<string, Buffer> = new Map();
  private sessionId: string | null = null;
  private isHost = false;
  private permission: 'read' | 'control' = 'read';

  constructor() {
    super();
  }

  /**
   * Connect to relay as host (sharing a session)
   */
  async connectAsHost(localSessionId: string): Promise<{ sessionId: string; publicKey: string }> {
    this.keyPair = crypto.generateKeyPair();
    this.isHost = true;

    // Register session with relay server
    const response = await fetch(`${RELAY_URL}/sessions`, {
      method: 'POST',
      headers: authService.getHeaders(),
      body: JSON.stringify({
        hostPublicKey: crypto.toBase64(this.keyPair.publicKey),
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to create share session');
    }

    const session = await response.json();
    this.sessionId = session.id;

    // Connect WebSocket
    await this.connectSocket();

    // Join as host
    this.socket!.emit('joinAsHost', {
      token: authService.token,
      sessionId: session.id,
    });

    return {
      sessionId: session.id,
      publicKey: crypto.toBase64(this.keyPair.publicKey),
    };
  }

  /**
   * Connect to relay as guest (joining a shared session)
   */
  async connectAsGuest(code: string): Promise<{
    hostPublicKey: string;
    permission: 'read' | 'control';
  }> {
    this.keyPair = crypto.generateKeyPair();
    this.isHost = false;

    await this.connectSocket();

    return new Promise((resolve, reject) => {
      this.socket!.emit(
        'joinAsGuest',
        {
          token: authService.token,
          code,
          guestPublicKey: crypto.toBase64(this.keyPair!.publicKey),
        },
        (response: any) => {
          if (response.error) {
            reject(new Error(response.error));
            return;
          }

          this.permission = response.permission;
          const hostPublicKey = crypto.fromBase64(response.hostPublicKey);
          const sharedSecret = crypto.deriveSharedSecret(
            this.keyPair!.secretKey,
            hostPublicKey,
          );
          this.sharedSecrets.set('host', sharedSecret);

          resolve({
            hostPublicKey: response.hostPublicKey,
            permission: response.permission,
          });
        },
      );
    });
  }

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io(`${RELAY_URL}/relay`, {
        transports: ['websocket'],
      });

      this.socket.on('connect', () => {
        log.info('Connected to relay');
        this.emit('connected');
        resolve();
      });

      this.socket.on('disconnect', () => {
        log.info('Disconnected from relay');
        this.emit('disconnected');
      });

      this.socket.on('connect_error', (error) => {
        log.error('Relay connection error:', error);
        reject(error);
      });

      this.socket.on('guestJoined', (info) => {
        log.info('Guest joined:', info.userId);
        // Derive shared secret for this guest
        const guestPublicKey = crypto.fromBase64(info.guestPublicKey);
        const sharedSecret = crypto.deriveSharedSecret(
          this.keyPair!.secretKey,
          guestPublicKey,
        );
        this.sharedSecrets.set(info.userId, sharedSecret);
        this.emit('guestJoined', info);
      });

      this.socket.on('peerDisconnected', (info) => {
        log.info('Peer disconnected:', info.userId);
        this.sharedSecrets.delete(info.userId);
        this.emit('guestLeft', info);
      });

      this.socket.on('relayData', (data) => {
        try {
          const ciphertext = crypto.fromBase64(data.encryptedData);
          const nonce = crypto.fromBase64(data.nonce);

          // Determine which shared secret to use
          const secretKey = data.from === 'host' ? 'host' : data.fromUserId;
          const sharedSecret = this.sharedSecrets.get(secretKey);

          if (!sharedSecret) {
            log.warn('No shared secret for:', secretKey);
            return;
          }

          const decrypted = crypto.decrypt(ciphertext, nonce, sharedSecret);
          this.emit('data', decrypted);
        } catch (e) {
          log.error('Failed to decrypt relay data:', e);
        }
      });
    });
  }

  /**
   * Send data to all connected peers (encrypted)
   */
  send(data: Buffer | string): void {
    if (!this.socket || !this.keyPair) {
      throw new Error('Not connected');
    }

    // For host: encrypt with each guest's shared secret
    // For guest: encrypt with host's shared secret
    if (this.isHost) {
      for (const [userId, sharedSecret] of this.sharedSecrets) {
        const { ciphertext, nonce } = crypto.encrypt(data, sharedSecret);
        this.socket.emit('relay', {
          encryptedData: crypto.toBase64(ciphertext),
          nonce: crypto.toBase64(nonce),
          targetUserId: userId,
        });
      }
    } else {
      const sharedSecret = this.sharedSecrets.get('host');
      if (sharedSecret) {
        const { ciphertext, nonce } = crypto.encrypt(data, sharedSecret);
        this.socket.emit('relay', {
          encryptedData: crypto.toBase64(ciphertext),
          nonce: crypto.toBase64(nonce),
        });
      }
    }
  }

  /**
   * Check if guest can send input
   */
  canSendInput(): boolean {
    return this.isHost || this.permission === 'control';
  }

  /**
   * Disconnect from relay
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.keyPair = null;
    this.sharedSecrets.clear();
    this.sessionId = null;
  }
}

export const relayClient = new RelayClient();
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: add WebSocket relay client with E2E encryption"
```

---

## Phase 5: Share Manager

### Task 7: Implement Share Manager

**Files:**
- Create: `src/main/sharing/share-manager.ts`

**Step 1: Create share manager**

Create `src/main/sharing/share-manager.ts`:
```typescript
import { EventEmitter } from 'events';
import { RELAY_URL } from '../../shared/constants';
import { ShareCode, CreateCodeOptions, ShareSession } from '../../shared/types';
import { authService } from './auth';
import { RelayClient } from './relay-client';
import { ptyManager } from '../pty-manager';
import log from 'electron-log';

interface ActiveShare {
  localSessionId: string;
  remoteSessionId: string;
  relayClient: RelayClient;
  guests: Map<string, { username: string; permission: string }>;
}

class ShareManager extends EventEmitter {
  private activeShares: Map<string, ActiveShare> = new Map();
  private joinedSessions: Map<string, RelayClient> = new Map();

  /**
   * Start sharing a local session
   */
  async startSharing(localSessionId: string): Promise<ShareSession> {
    if (this.activeShares.has(localSessionId)) {
      throw new Error('Session is already being shared');
    }

    const client = new RelayClient();
    const { sessionId, publicKey } = await client.connectAsHost(localSessionId);

    const share: ActiveShare = {
      localSessionId,
      remoteSessionId: sessionId,
      relayClient: client,
      guests: new Map(),
    };

    this.activeShares.set(localSessionId, share);

    // Forward PTY output to relay
    ptyManager.on('data', (ptySessionId: string, data: string) => {
      if (ptySessionId === localSessionId && share.guests.size > 0) {
        client.send(data);
      }
    });

    // Handle guest events
    client.on('guestJoined', (info) => {
      share.guests.set(info.userId, {
        username: info.userId, // Will be enriched later
        permission: info.permission,
      });
      this.emit('guestJoined', { localSessionId, ...info });
    });

    client.on('guestLeft', (info) => {
      share.guests.delete(info.userId);
      this.emit('guestLeft', { localSessionId, ...info });
    });

    // Handle input from guests with control permission
    client.on('data', (data: Buffer) => {
      ptyManager.write(localSessionId, data.toString());
    });

    log.info('Started sharing session:', localSessionId, '→', sessionId);

    return {
      id: sessionId,
      hostPublicKey: publicKey,
      startedAt: new Date().toISOString(),
      codes: [],
    };
  }

  /**
   * Stop sharing a session
   */
  async stopSharing(localSessionId: string): Promise<void> {
    const share = this.activeShares.get(localSessionId);
    if (!share) return;

    // End session on server
    await fetch(`${RELAY_URL}/sessions/${share.remoteSessionId}`, {
      method: 'DELETE',
      headers: authService.getHeaders(),
    });

    share.relayClient.disconnect();
    this.activeShares.delete(localSessionId);

    log.info('Stopped sharing session:', localSessionId);
  }

  /**
   * Create a share code for a session
   */
  async createCode(
    localSessionId: string,
    options: CreateCodeOptions,
  ): Promise<ShareCode> {
    const share = this.activeShares.get(localSessionId);
    if (!share) {
      throw new Error('Session is not being shared');
    }

    const response = await fetch(
      `${RELAY_URL}/sessions/${share.remoteSessionId}/codes`,
      {
        method: 'POST',
        headers: authService.getHeaders(),
        body: JSON.stringify(options),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to create code');
    }

    return response.json();
  }

  /**
   * Revoke a share code
   */
  async revokeCode(code: string): Promise<void> {
    await fetch(`${RELAY_URL}/codes/${code}`, {
      method: 'DELETE',
      headers: authService.getHeaders(),
    });
  }

  /**
   * Get active codes for a session
   */
  async getCodes(localSessionId: string): Promise<ShareCode[]> {
    const share = this.activeShares.get(localSessionId);
    if (!share) {
      return [];
    }

    const response = await fetch(
      `${RELAY_URL}/sessions/${share.remoteSessionId}/codes`,
      {
        headers: authService.getHeaders(),
      },
    );

    if (!response.ok) {
      return [];
    }

    return response.json();
  }

  /**
   * Join a shared session as a guest
   */
  async joinSession(code: string): Promise<{
    permission: 'read' | 'control';
    relayClient: RelayClient;
  }> {
    const client = new RelayClient();
    const { permission } = await client.connectAsGuest(code);

    this.joinedSessions.set(code, client);

    return { permission, relayClient: client };
  }

  /**
   * Leave a joined session
   */
  leaveSession(code: string): void {
    const client = this.joinedSessions.get(code);
    if (client) {
      client.disconnect();
      this.joinedSessions.delete(code);
    }
  }

  /**
   * Check if a session is being shared
   */
  isSharing(localSessionId: string): boolean {
    return this.activeShares.has(localSessionId);
  }

  /**
   * Get guest count for a session
   */
  getGuestCount(localSessionId: string): number {
    return this.activeShares.get(localSessionId)?.guests.size || 0;
  }
}

export const shareManager = new ShareManager();
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: add share manager for session sharing orchestration"
```

---

## Phase 6: IPC Handlers

### Task 8: Add Sharing IPC Handlers

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/preload.ts`

**Step 1: Add IPC handlers to main process**

Add to `src/main/index.ts`:
```typescript
import { authService } from './sharing/auth';
import { shareManager } from './sharing/share-manager';

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

// Sharing IPC handlers (host)
ipcMain.handle('share:start', async (_, localSessionId: string) => {
  return shareManager.startSharing(localSessionId);
});

ipcMain.handle('share:stop', async (_, localSessionId: string) => {
  return shareManager.stopSharing(localSessionId);
});

ipcMain.handle('share:createCode', async (_, localSessionId: string, options) => {
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
  const { permission, relayClient } = await shareManager.joinSession(code);

  // Forward relay data to renderer
  relayClient.on('data', (data) => {
    mainWindow?.webContents.send('share:data', { code, data: data.toString() });
  });

  relayClient.on('disconnected', () => {
    mainWindow?.webContents.send('share:ended', { code });
  });

  return { permission };
});

ipcMain.handle('share:leave', (_, code: string) => {
  shareManager.leaveSession(code);
});

// Forward share manager events to renderer
shareManager.on('guestJoined', (info) => {
  mainWindow?.webContents.send('share:guestJoined', info);
});

shareManager.on('guestLeft', (info) => {
  mainWindow?.webContents.send('share:guestLeft', info);
});
```

**Step 2: Add to preload.ts**

Add to the electronAPI in `src/main/preload.ts`:
```typescript
// Auth
login: () => ipcRenderer.invoke('auth:login'),
logout: () => ipcRenderer.invoke('auth:logout'),
getUser: () => ipcRenderer.invoke('auth:getUser'),
setAuthToken: (token: string) => ipcRenderer.invoke('auth:setToken', token),
onAuthChanged: (callback: (data: any) => void) => {
  ipcRenderer.on('auth:changed', (_, data) => callback(data));
},
onAuthError: (callback: (data: any) => void) => {
  ipcRenderer.on('auth:error', (_, data) => callback(data));
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
  ipcRenderer.on('share:guestJoined', (_, info) => callback(info));
},
onGuestLeft: (callback: (info: any) => void) => {
  ipcRenderer.on('share:guestLeft', (_, info) => callback(info));
},

// Sharing (guest)
joinSession: (code: string) => ipcRenderer.invoke('share:join', code),
leaveSession: (code: string) => ipcRenderer.invoke('share:leave', code),
onShareData: (callback: (data: any) => void) => {
  ipcRenderer.on('share:data', (_, data) => callback(data));
},
onShareEnded: (callback: (data: any) => void) => {
  ipcRenderer.on('share:ended', (_, data) => callback(data));
},
```

**Step 3: Update types in preload.ts**

Update the ElectronAPI interface accordingly.

**Step 4: Commit**

```bash
git add .
git commit -m "feat: add sharing IPC handlers"
```

---

## Phase 7: UI Components

### Task 9: Create Share Modal Component

**Files:**
- Create: `src/renderer/components/ShareModal.tsx`
- Create: `src/renderer/components/ShareModal.css`

**Step 1: Create ShareModal component**

Create `src/renderer/components/ShareModal.tsx`:
```typescript
import React, { useState, useEffect } from 'react';
import { ShareCode, CreateCodeOptions } from '../../shared/types';
import './ShareModal.css';

interface ShareModalProps {
  sessionId: string;
  sessionName: string;
  isOpen: boolean;
  onClose: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({
  sessionId,
  sessionName,
  isOpen,
  onClose,
}) => {
  const [isSharing, setIsSharing] = useState(false);
  const [codes, setCodes] = useState<ShareCode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Code creation form
  const [permission, setPermission] = useState<'read' | 'control'>('read');
  const [expiresIn, setExpiresIn] = useState<number>(30);
  const [maxUses, setMaxUses] = useState<number | null>(null);

  useEffect(() => {
    if (isOpen) {
      checkSharingStatus();
    }
  }, [isOpen, sessionId]);

  const checkSharingStatus = async () => {
    const sharing = await window.electronAPI.isSharing(sessionId);
    setIsSharing(sharing);
    if (sharing) {
      const existingCodes = await window.electronAPI.getShareCodes(sessionId);
      setCodes(existingCodes);
    }
  };

  const handleStartSharing = async () => {
    setLoading(true);
    setError(null);
    try {
      await window.electronAPI.startSharing(sessionId);
      setIsSharing(true);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };

  const handleStopSharing = async () => {
    setLoading(true);
    try {
      await window.electronAPI.stopSharing(sessionId);
      setIsSharing(false);
      setCodes([]);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };

  const handleCreateCode = async () => {
    setLoading(true);
    setError(null);
    try {
      const options: CreateCodeOptions = {
        permission,
        expiresInMinutes: expiresIn,
        maxUses: maxUses || undefined,
      };
      const code = await window.electronAPI.createShareCode(sessionId, options);
      setCodes([...codes, code]);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };

  const handleRevokeCode = async (code: string) => {
    try {
      await window.electronAPI.revokeShareCode(code);
      setCodes(codes.filter((c) => c.code !== code));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Share Session</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <p className="session-name">Session: {sessionName}</p>

          {error && <div className="error-message">{error}</div>}

          {!isSharing ? (
            <div className="start-sharing">
              <p>Share this session to let others view or collaborate in real-time.</p>
              <button
                className="btn primary"
                onClick={handleStartSharing}
                disabled={loading}
              >
                {loading ? 'Starting...' : 'Start Sharing'}
              </button>
            </div>
          ) : (
            <>
              <div className="create-code-form">
                <h3>Create Share Code</h3>

                <div className="form-group">
                  <label>Permission</label>
                  <select
                    value={permission}
                    onChange={(e) => setPermission(e.target.value as 'read' | 'control')}
                  >
                    <option value="read">Read Only (can view)</option>
                    <option value="control">Full Control (can type)</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Expires In</label>
                  <select
                    value={expiresIn}
                    onChange={(e) => setExpiresIn(Number(e.target.value))}
                  >
                    <option value={30}>30 minutes</option>
                    <option value={60}>1 hour</option>
                    <option value={240}>4 hours</option>
                    <option value={0}>No expiry</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Max Uses</label>
                  <select
                    value={maxUses || 0}
                    onChange={(e) => setMaxUses(Number(e.target.value) || null)}
                  >
                    <option value={1}>1 use</option>
                    <option value={5}>5 uses</option>
                    <option value={0}>Unlimited</option>
                  </select>
                </div>

                <button
                  className="btn primary"
                  onClick={handleCreateCode}
                  disabled={loading}
                >
                  Generate Code
                </button>
              </div>

              {codes.length > 0 && (
                <div className="codes-list">
                  <h3>Active Codes</h3>
                  {codes.map((code) => (
                    <div key={code.code} className="code-item">
                      <div className="code-value">
                        <span className="code">{code.code}</span>
                        <button className="copy-btn" onClick={() => copyCode(code.code)}>
                          Copy
                        </button>
                      </div>
                      <div className="code-meta">
                        <span className={`permission ${code.permission}`}>
                          {code.permission}
                        </span>
                        {code.expiresAt && (
                          <span className="expires">
                            Expires: {new Date(code.expiresAt).toLocaleTimeString()}
                          </span>
                        )}
                        {code.maxUses && (
                          <span className="uses">
                            {code.currentUses}/{code.maxUses} uses
                          </span>
                        )}
                      </div>
                      <button
                        className="revoke-btn"
                        onClick={() => handleRevokeCode(code.code)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="stop-sharing">
                <button
                  className="btn danger"
                  onClick={handleStopSharing}
                  disabled={loading}
                >
                  Stop Sharing
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
```

**Step 2: Create CSS**

Create `src/renderer/components/ShareModal.css`:
```css
.share-modal {
  width: 450px;
  max-height: 80vh;
  overflow-y: auto;
}

.session-name {
  color: #888;
  margin-bottom: 16px;
}

.start-sharing {
  text-align: center;
  padding: 20px;
}

.create-code-form {
  background: #1a1a1a;
  padding: 16px;
  border-radius: 8px;
  margin-bottom: 16px;
}

.create-code-form h3 {
  margin-top: 0;
  margin-bottom: 12px;
}

.form-group {
  margin-bottom: 12px;
}

.form-group label {
  display: block;
  margin-bottom: 4px;
  color: #888;
  font-size: 12px;
}

.form-group select {
  width: 100%;
  padding: 8px;
  background: #2a2a2a;
  border: 1px solid #444;
  border-radius: 4px;
  color: #fff;
}

.codes-list {
  margin-bottom: 16px;
}

.codes-list h3 {
  margin-bottom: 12px;
}

.code-item {
  background: #1a1a1a;
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 8px;
}

.code-value {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.code {
  font-family: monospace;
  font-size: 18px;
  font-weight: bold;
  color: #4ade80;
}

.copy-btn {
  padding: 4px 8px;
  font-size: 12px;
  background: #333;
  border: none;
  border-radius: 4px;
  color: #fff;
  cursor: pointer;
}

.copy-btn:hover {
  background: #444;
}

.code-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #888;
  margin-bottom: 8px;
}

.permission {
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: bold;
}

.permission.read {
  background: #3b82f6;
  color: #fff;
}

.permission.control {
  background: #f59e0b;
  color: #000;
}

.revoke-btn {
  padding: 4px 8px;
  font-size: 12px;
  background: transparent;
  border: 1px solid #ef4444;
  border-radius: 4px;
  color: #ef4444;
  cursor: pointer;
}

.revoke-btn:hover {
  background: #ef4444;
  color: #fff;
}

.stop-sharing {
  text-align: center;
  padding-top: 16px;
  border-top: 1px solid #333;
}

.btn.danger {
  background: #ef4444;
}

.btn.danger:hover {
  background: #dc2626;
}

.error-message {
  background: #7f1d1d;
  border: 1px solid #ef4444;
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 16px;
  color: #fca5a5;
}
```

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add ShareModal component"
```

---

### Task 10: Create Join Session Modal

**Files:**
- Create: `src/renderer/components/JoinSessionModal.tsx`

**Step 1: Create JoinSessionModal component**

Create `src/renderer/components/JoinSessionModal.tsx`:
```typescript
import React, { useState } from 'react';
import './ShareModal.css'; // Reuse styles

interface JoinSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onJoined: (code: string, permission: 'read' | 'control') => void;
}

export const JoinSessionModal: React.FC<JoinSessionModalProps> = ({
  isOpen,
  onClose,
  onJoined,
}) => {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleJoin = async () => {
    if (!code.trim()) {
      setError('Please enter a share code');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await window.electronAPI.joinSession(code.toUpperCase());
      onJoined(code.toUpperCase(), result.permission);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }

    setLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleJoin();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Join Shared Session</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <p>Enter the share code to join a session:</p>

          {error && <div className="error-message">{error}</div>}

          <div className="form-group">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={handleKeyDown}
              placeholder="SYCLX-XXXXXX"
              className="code-input"
              autoFocus
            />
          </div>

          <button
            className="btn primary"
            onClick={handleJoin}
            disabled={loading || !code.trim()}
            style={{ width: '100%' }}
          >
            {loading ? 'Joining...' : 'Join Session'}
          </button>
        </div>
      </div>
    </div>
  );
};
```

**Step 2: Add input styles to ShareModal.css**

Append to `src/renderer/components/ShareModal.css`:
```css
.code-input {
  width: 100%;
  padding: 12px;
  font-size: 18px;
  font-family: monospace;
  text-align: center;
  background: #2a2a2a;
  border: 2px solid #444;
  border-radius: 8px;
  color: #fff;
  letter-spacing: 2px;
}

.code-input:focus {
  outline: none;
  border-color: #4ade80;
}

.code-input::placeholder {
  color: #666;
}
```

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add JoinSessionModal component"
```

---

### Task 11: Create Account Menu Component

**Files:**
- Create: `src/renderer/components/AccountMenu.tsx`
- Create: `src/renderer/components/AccountMenu.css`

**Step 1: Create AccountMenu component**

Create `src/renderer/components/AccountMenu.tsx`:
```typescript
import React, { useState, useEffect, useRef } from 'react';
import { ShareUser } from '../../shared/types';
import './AccountMenu.css';

interface AccountMenuProps {
  user: ShareUser | null;
  onLogin: () => void;
  onLogout: () => void;
}

export const AccountMenu: React.FC<AccountMenuProps> = ({
  user,
  onLogin,
  onLogout,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!user) {
    return (
      <button className="account-btn login-btn" onClick={onLogin}>
        Sign In
      </button>
    );
  }

  return (
    <div className="account-menu" ref={menuRef}>
      <button className="account-btn" onClick={() => setIsOpen(!isOpen)}>
        <span className="avatar">{user.username[0].toUpperCase()}</span>
        <span className="username">{user.username}</span>
        <span className={`tier-badge ${user.tier}`}>{user.tier}</span>
      </button>

      {isOpen && (
        <div className="account-dropdown">
          <div className="account-info">
            <div className="account-name">{user.username}</div>
            <div className="account-email">{user.email}</div>
          </div>

          <div className="dropdown-divider" />

          {user.tier === 'free' && (
            <button
              className="dropdown-item upgrade"
              onClick={() => {
                // Open upgrade URL
                window.electronAPI.openExternal('https://api.sytanek.tech/billing/checkout');
              }}
            >
              Upgrade to Pro - $5/mo
            </button>
          )}

          {user.tier !== 'free' && (
            <button
              className="dropdown-item"
              onClick={() => {
                window.electronAPI.openExternal('https://api.sytanek.tech/billing/portal');
              }}
            >
              Manage Subscription
            </button>
          )}

          <div className="dropdown-divider" />

          <button className="dropdown-item logout" onClick={onLogout}>
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
};
```

**Step 2: Create CSS**

Create `src/renderer/components/AccountMenu.css`:
```css
.account-menu {
  position: relative;
}

.account-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid #444;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
}

.account-btn:hover {
  background: #333;
}

.login-btn {
  background: #4ade80;
  border-color: #4ade80;
  color: #000;
  font-weight: 500;
}

.login-btn:hover {
  background: #22c55e;
}

.avatar {
  width: 24px;
  height: 24px;
  background: #666;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
  font-size: 12px;
}

.tier-badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: bold;
  text-transform: uppercase;
}

.tier-badge.free {
  background: #666;
  color: #fff;
}

.tier-badge.pro {
  background: #f59e0b;
  color: #000;
}

.tier-badge.admin {
  background: #8b5cf6;
  color: #fff;
}

.account-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  width: 220px;
  background: #1a1a1a;
  border: 1px solid #333;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 100;
  overflow: hidden;
}

.account-info {
  padding: 12px;
}

.account-name {
  font-weight: bold;
  margin-bottom: 2px;
}

.account-email {
  font-size: 12px;
  color: #888;
}

.dropdown-divider {
  height: 1px;
  background: #333;
}

.dropdown-item {
  width: 100%;
  padding: 10px 12px;
  background: transparent;
  border: none;
  color: #fff;
  text-align: left;
  cursor: pointer;
  font-size: 13px;
}

.dropdown-item:hover {
  background: #333;
}

.dropdown-item.upgrade {
  color: #4ade80;
}

.dropdown-item.logout {
  color: #ef4444;
}
```

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add AccountMenu component"
```

---

## Phase 8: Integration

### Task 12: Add Sharing Hook

**Files:**
- Create: `src/renderer/store/sharing.ts`

**Step 1: Create sharing hook**

Create `src/renderer/store/sharing.ts`:
```typescript
import { useState, useEffect, useCallback } from 'react';
import { ShareUser } from '../../shared/types';

interface SharingState {
  user: ShareUser | null;
  isLoading: boolean;
}

export function useSharing() {
  const [state, setState] = useState<SharingState>({
    user: null,
    isLoading: true,
  });

  // Load initial auth state
  useEffect(() => {
    const loadUser = async () => {
      try {
        // Try to load saved token
        const savedToken = localStorage.getItem('claudelander_auth_token');
        if (savedToken) {
          const user = await window.electronAPI.setAuthToken(savedToken);
          if (user) {
            setState({ user, isLoading: false });
            return;
          }
        }
      } catch (e) {
        console.error('Failed to restore auth:', e);
      }
      setState({ user: null, isLoading: false });
    };

    loadUser();

    // Listen for auth changes
    window.electronAPI.onAuthChanged((data) => {
      setState({ user: data.user, isLoading: false });
      if (data.token) {
        localStorage.setItem('claudelander_auth_token', data.token);
      }
    });

    window.electronAPI.onAuthError((data) => {
      console.error('Auth error:', data.error);
      setState({ user: null, isLoading: false });
    });
  }, []);

  const login = useCallback(() => {
    window.electronAPI.login();
  }, []);

  const logout = useCallback(() => {
    window.electronAPI.logout();
    localStorage.removeItem('claudelander_auth_token');
    setState({ user: null, isLoading: false });
  }, []);

  return {
    user: state.user,
    isLoading: state.isLoading,
    isAuthenticated: state.user !== null,
    login,
    logout,
  };
}
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: add useSharing hook for auth state"
```

---

### Task 13: Integrate Components into App

**Files:**
- Modify: `src/renderer/App.tsx` (or main layout component)

**Step 1: Add sharing components to main app**

Import and integrate the new components:
```typescript
import { ShareModal } from './components/ShareModal';
import { JoinSessionModal } from './components/JoinSessionModal';
import { AccountMenu } from './components/AccountMenu';
import { useSharing } from './store/sharing';

// In your App component:
const { user, login, logout, isAuthenticated } = useSharing();

const [shareModalSession, setShareModalSession] = useState<string | null>(null);
const [showJoinModal, setShowJoinModal] = useState(false);

// Add to header/toolbar:
<AccountMenu user={user} onLogin={login} onLogout={logout} />

// Add menu item or button to join:
<button onClick={() => setShowJoinModal(true)}>Join Session</button>

// Add share button to session context menu or tab:
{isAuthenticated && (
  <button onClick={() => setShareModalSession(session.id)}>Share</button>
)}

// Add modals:
<ShareModal
  sessionId={shareModalSession || ''}
  sessionName={sessions.find(s => s.id === shareModalSession)?.name || ''}
  isOpen={shareModalSession !== null}
  onClose={() => setShareModalSession(null)}
/>

<JoinSessionModal
  isOpen={showJoinModal}
  onClose={() => setShowJoinModal(false)}
  onJoined={(code, permission) => {
    // Handle joined session - create a remote session tab
    console.log('Joined:', code, permission);
  }}
/>
```

**Step 2: Commit**

```bash
git add .
git commit -m "feat: integrate sharing components into app"
```

---

### Task 14: Final Testing & Cleanup

**Step 1: Build and test**

```bash
npm run build
npm run start
```

**Step 2: Test flows**

1. Click Sign In → GitHub OAuth → Callback → User shown
2. Select session → Share → Generate code
3. Copy code → Open second instance → Join Session → Paste code
4. Verify terminal data flows between instances
5. Test read-only vs control permissions
6. Test code expiry and revocation

**Step 3: Fix any issues found during testing**

**Step 4: Final commit**

```bash
git add .
git commit -m "feat: complete session sharing integration"
```

---

## Summary

This plan creates client-side session sharing with:

1. **Crypto**: E2E encryption with libsodium (X25519 + XChaCha20-Poly1305)
2. **Auth**: GitHub OAuth via deep links
3. **Relay**: WebSocket client with encrypted data relay
4. **Share Manager**: Orchestrates sharing lifecycle
5. **IPC**: Full bridge between main and renderer
6. **UI**: ShareModal, JoinSessionModal, AccountMenu components
7. **State**: useSharing hook for auth state

Total: ~14 tasks with clear steps and commit points.

**Prerequisites:**
- Relay server running (local or production)
- GitHub OAuth app configured
- Native module build environment for sodium-native
