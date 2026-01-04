# Remote Session UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display joined remote sessions in the UI so users can view shared terminal output.

**Architecture:** Relay server returns host metadata on join. Client stores remote sessions in renderer state, displays in "Remote Sessions" group, renders via RemoteTerminal component that receives data via IPC.

**Tech Stack:** NestJS (relay), Electron IPC, React, XTerm.js

---

## Part 1: Relay Server Changes

### Task 1: Add sessionName to ShareSession Entity

**Files:**
- Modify: `../claudelander-relay/src/entities/share-session.entity.ts:27-28`

**Step 1: Add sessionName column**

Add after line 27 (`hostPublicKey` column):

```typescript
@Column({ nullable: true })
sessionName: string;
```

**Step 2: Verify TypeScript compiles**

Run: `cd ../claudelander-relay && npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git -C ../claudelander-relay add src/entities/share-session.entity.ts
git -C ../claudelander-relay commit -m "feat: add sessionName to ShareSession entity"
```

---

### Task 2: Update CreateSessionDto to Accept sessionName

**Files:**
- Modify: `../claudelander-relay/src/sessions/dto/create-session.dto.ts`

**Step 1: Add sessionName to DTO**

Replace entire file:

```typescript
import { IsString, IsOptional } from 'class-validator';

export class CreateSessionDto {
  @IsString()
  hostPublicKey: string;

  @IsString()
  @IsOptional()
  sessionName?: string;
}
```

**Step 2: Commit**

```bash
git -C ../claudelander-relay add src/sessions/dto/create-session.dto.ts
git -C ../claudelander-relay commit -m "feat: add sessionName to CreateSessionDto"
```

---

### Task 3: Update SessionsService to Store sessionName

**Files:**
- Modify: `../claudelander-relay/src/sessions/sessions.service.ts:20-37`

**Step 1: Update create method signature and implementation**

Change the `create` method (lines 20-37) to:

```typescript
async create(user: User, hostPublicKey: string, sessionName?: string): Promise<ShareSession> {
  // Check tier limits
  const activeCount = await this.countActive(user.id);
  const limit = TIER_LIMITS[user.tier]?.maxShares;

  if (limit !== null && activeCount >= limit) {
    throw new ForbiddenException(
      `Share limit reached (${limit}). Upgrade to Pro for more.`,
    );
  }

  const session = this.sessionsRepository.create({
    hostUserId: user.id,
    hostPublicKey,
    sessionName: sessionName || 'Shared Session',
  });

  return this.sessionsRepository.save(session);
}
```

**Step 2: Verify build**

Run: `cd ../claudelander-relay && npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git -C ../claudelander-relay add src/sessions/sessions.service.ts
git -C ../claudelander-relay commit -m "feat: store sessionName when creating session"
```

---

### Task 4: Update SessionsController to Pass sessionName

**Files:**
- Modify: `../claudelander-relay/src/sessions/sessions.controller.ts:21-24`

**Step 1: Update create method**

Change line 22-24:

```typescript
@Post()
create(@Req() req: { user: User }, @Body() dto: CreateSessionDto) {
  return this.sessionsService.create(req.user, dto.hostPublicKey, dto.sessionName);
}
```

**Step 2: Commit**

```bash
git -C ../claudelander-relay add src/sessions/sessions.controller.ts
git -C ../claudelander-relay commit -m "feat: pass sessionName to sessions service"
```

---

### Task 5: Update Gateway to Return Host Metadata on Join

**Files:**
- Modify: `../claudelander-relay/src/relay/relay.gateway.ts:147-151`

**Step 1: Update joinAsGuest return value**

Change lines 147-151 (the return statement in handleJoinAsGuest):

```typescript
return {
  success: true,
  hostPublicKey: session.hostPublicKey,
  hostUsername: session.host.username,
  sessionName: session.sessionName || 'Shared Session',
  permission,
};
```

**Step 2: Verify build**

Run: `cd ../claudelander-relay && npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git -C ../claudelander-relay add src/relay/relay.gateway.ts
git -C ../claudelander-relay commit -m "feat: return hostUsername and sessionName on guest join"
```

---

### Task 6: Run Database Migration (if using migrations)

**Step 1: Check if migrations are used**

Run: `ls ../claudelander-relay/src/migrations 2>/dev/null || echo "No migrations folder"`

If migrations exist, generate one:
```bash
cd ../claudelander-relay && npm run migration:generate -- -n AddSessionName
```

If no migrations (using synchronize: true in dev), skip this task.

**Step 2: Commit migration if created**

```bash
git -C ../claudelander-relay add src/migrations/
git -C ../claudelander-relay commit -m "feat: add migration for sessionName column"
```

---

## Part 2: Client Changes - Share Manager

### Task 7: Update share-manager startSharing to Send sessionName

**Files:**
- Modify: `src/main/sharing/share-manager.ts:23-82`

**Step 1: Update startSharing signature and fetch body**

Change the method signature (line 23) and fetch body (lines 38-43):

```typescript
async startSharing(localSessionId: string, sessionName?: string): Promise<ShareSession> {
```

And update the fetch body:

```typescript
body: JSON.stringify({
  hostPublicKey: crypto.toBase64(this.keyPair.publicKey),
  sessionName: sessionName || 'Shared Session',
}),
```

**Step 2: Commit**

```bash
git add src/main/sharing/share-manager.ts
git commit -m "feat: send sessionName when starting share"
```

---

### Task 8: Update share-manager joinSession Return Type

**Files:**
- Modify: `src/main/sharing/share-manager.ts:188-198`

**Step 1: Update joinSession return type and implementation**

Change the method (lines 188-198):

```typescript
async joinSession(code: string): Promise<{
  permission: 'read' | 'control';
  hostUsername: string;
  sessionName: string;
  relayClient: RelayClient;
}> {
  const client = new RelayClient();
  const result = await client.connectAsGuest(code);

  this.joinedSessions.set(code, client);

  return {
    permission: result.permission,
    hostUsername: result.hostUsername,
    sessionName: result.sessionName,
    relayClient: client,
  };
}
```

**Step 2: Commit**

```bash
git add src/main/sharing/share-manager.ts
git commit -m "feat: return host metadata from joinSession"
```

---

### Task 9: Update RelayClient connectAsGuest Return Type

**Files:**
- Modify: `src/main/sharing/relay-client.ts:73-111`

**Step 1: Update return type and resolve call**

Change the method return type (lines 73-76):

```typescript
async connectAsGuest(code: string): Promise<{
  hostPublicKey: string;
  permission: 'read' | 'control';
  hostUsername: string;
  sessionName: string;
}> {
```

And update the resolve call (lines 104-107):

```typescript
resolve({
  hostPublicKey: response.hostPublicKey,
  permission: response.permission,
  hostUsername: response.hostUsername,
  sessionName: response.sessionName,
});
```

**Step 2: Verify TypeScript compiles**

Run: `npm run build:main`
Expected: Build succeeds (or run `npx tsc --noEmit` to check types)

**Step 3: Commit**

```bash
git add src/main/sharing/relay-client.ts
git commit -m "feat: return host metadata from connectAsGuest"
```

---

## Part 3: Client Changes - IPC Layer

### Task 10: Update share:join IPC Handler to Return Full Metadata

**Files:**
- Modify: `src/main/index.ts:454-467`

**Step 1: Update the share:join handler**

Replace lines 454-467:

```typescript
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
```

**Step 2: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: return host metadata from share:join IPC"
```

---

### Task 11: Add share:write IPC Handler for Guest Input

**Files:**
- Modify: `src/main/index.ts` (after share:leave handler, ~line 471)

**Step 1: Add share:write handler**

Add after the share:leave handler:

```typescript
ipcMain.handle('share:write', (_, code: string, data: string) => {
  const client = shareManager.getJoinedClient(code);
  if (client && client.canSendInput()) {
    client.send(data);
    return { success: true };
  }
  return { success: false, error: 'Cannot send input' };
});
```

**Step 2: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: add share:write IPC handler for guest input"
```

---

### Task 12: Add getJoinedClient Method to ShareManager

**Files:**
- Modify: `src/main/sharing/share-manager.ts` (after leaveSession method, ~line 209)

**Step 1: Add getJoinedClient method**

Add after leaveSession method:

```typescript
/**
 * Get a joined session's relay client
 */
getJoinedClient(code: string): RelayClient | undefined {
  return this.joinedSessions.get(code);
}
```

**Step 2: Commit**

```bash
git add src/main/sharing/share-manager.ts
git commit -m "feat: add getJoinedClient method"
```

---

### Task 13: Update Preload to Expose writeToRemote

**Files:**
- Modify: `src/main/preload.ts:141-153`

**Step 1: Add writeToRemote function**

Add after `leaveSession` (line 143):

```typescript
writeToRemote: (code: string, data: string) =>
  ipcRenderer.invoke('share:write', code, data),
```

**Step 2: Commit**

```bash
git add src/main/preload.ts
git commit -m "feat: expose writeToRemote in preload"
```

---

### Task 14: Update TypeScript Definitions for Electron API

**Files:**
- Modify: `src/renderer/types/electron.d.ts`

**Step 1: Find and update the joinSession return type and add writeToRemote**

First, read the file to find the exact location, then update:

- Change `joinSession` return type to include `hostUsername` and `sessionName`
- Add `writeToRemote` function signature

```typescript
joinSession: (code: string) => Promise<{
  code: string;
  permission: 'read' | 'control';
  hostUsername: string;
  sessionName: string;
}>;
writeToRemote: (code: string, data: string) => Promise<{ success: boolean; error?: string }>;
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/renderer/types/electron.d.ts
git commit -m "feat: update electron API types for remote sessions"
```

---

## Part 4: Client Changes - UI Components

### Task 15: Create RemoteTerminal Component

**Files:**
- Create: `src/renderer/components/RemoteTerminal.tsx`

**Step 1: Create the component**

```typescript
import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import '../styles/terminal.css';

interface RemoteTerminalProps {
  code: string;
  permission: 'read' | 'control';
  isActive: boolean;
}

const RemoteTerminal: React.FC<RemoteTerminalProps> = ({ code, permission, isActive }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [disconnected, setDisconnected] = useState(false);

  // Listen for focus-terminal event
  useEffect(() => {
    const handleFocusTerminal = () => {
      if (isActive && xtermRef.current) {
        xtermRef.current.focus();
      }
    };

    window.addEventListener('focus-terminal', handleFocusTerminal);
    return () => window.removeEventListener('focus-terminal', handleFocusTerminal);
  }, [isActive]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new XTerm({
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: permission === 'control' ? '#d4d4d4' : '#666666',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
      },
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 14,
      cursorBlink: permission === 'control',
      disableStdin: permission === 'read',
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle incoming data from host
    const cleanupData = window.electronAPI.onShareData((event) => {
      if (event.code === code) {
        term.write(event.data);
      }
    });

    // Handle disconnection
    const cleanupEnded = window.electronAPI.onShareEnded((event) => {
      if (event.code === code) {
        setDisconnected(true);
        term.write('\r\n\x1b[31m[Host disconnected]\x1b[0m\r\n');
      }
    });

    // Handle keyboard shortcuts
    term.attachCustomKeyEventHandler((event) => {
      const isMod = event.ctrlKey || event.metaKey;

      // Ctrl+Shift+C = Copy
      if (isMod && event.shiftKey && event.key === 'C') {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
        return false;
      }

      // Global shortcuts
      const key = event.key.toLowerCase();
      const isGlobalShortcut = (
        (isMod && key === 'q') ||
        (isMod && event.key === 'Tab') ||
        (isMod && key === 'w') ||
        (isMod && key === 'n') ||
        (isMod && key === 'g')
      );

      if (isGlobalShortcut && event.type === 'keydown') {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          bubbles: true,
        }));
        return false;
      }

      return true;
    });

    // Handle user input (only if control permission)
    if (permission === 'control') {
      term.onData((data) => {
        window.electronAPI.writeToRemote(code, data);
      });
    }

    // Handle resize
    const handleResize = () => {
      if (fitAddonRef.current && xtermRef.current) {
        fitAddonRef.current.fit();
      }
    };

    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        requestAnimationFrame(handleResize);
      }
    });

    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    window.addEventListener('resize', handleResize);
    requestAnimationFrame(() => setTimeout(handleResize, 50));

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      cleanupData();
      cleanupEnded();
      term.dispose();
    };
  }, [code, permission]);

  if (disconnected) {
    return (
      <div className="terminal-error">
        <div className="error-icon">!</div>
        <p className="error-title">Session Ended</p>
        <p className="error-message">The host has disconnected.</p>
      </div>
    );
  }

  return (
    <div
      ref={terminalRef}
      className="terminal-container"
    />
  );
};

export default RemoteTerminal;
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/renderer/components/RemoteTerminal.tsx
git commit -m "feat: add RemoteTerminal component"
```

---

### Task 16: Add Remote Sessions State to App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: Add RemoteSession interface and state**

Add import at top:
```typescript
import RemoteTerminal from './components/RemoteTerminal';
```

Add interface after existing imports (around line 13):
```typescript
interface RemoteSession {
  code: string;
  hostUsername: string;
  sessionName: string;
  permission: 'read' | 'control';
  connectedAt: string;
}
```

Add state inside App component (after other useState calls, around line 60):
```typescript
const [remoteSessions, setRemoteSessions] = useState<RemoteSession[]>([]);
```

**Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: add remote sessions state to App"
```

---

### Task 17: Update onJoined Handler in App.tsx

**Files:**
- Modify: `src/renderer/App.tsx:1036-1044`

**Step 1: Update JoinSessionModal onJoined callback**

Replace the onJoined callback (lines 1039-1042):

```typescript
onJoined={(result) => {
  setRemoteSessions(prev => [...prev, {
    code: result.code,
    hostUsername: result.hostUsername,
    sessionName: result.sessionName,
    permission: result.permission,
    connectedAt: new Date().toISOString(),
  }]);
  // Select the new remote session
  setActiveSessionId(`remote:${result.code}`);
}}
```

**Step 2: Update JoinSessionModal props type**

Also need to update JoinSessionModal component - will handle in next task.

**Step 3: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: store remote sessions on join"
```

---

### Task 18: Update JoinSessionModal to Return Full Result

**Files:**
- Modify: `src/renderer/components/JoinSessionModal.tsx:4-8, 28-31`

**Step 1: Update props interface**

Change the interface (lines 4-8):

```typescript
interface JoinSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onJoined: (result: { code: string; hostUsername: string; sessionName: string; permission: 'read' | 'control' }) => void;
}
```

**Step 2: Update handleJoin to pass full result**

Change lines 28-31:

```typescript
try {
  const result = await window.electronAPI.joinSession(code.toUpperCase());
  onJoined(result);
  onClose();
} catch (e) {
```

**Step 3: Commit**

```bash
git add src/renderer/components/JoinSessionModal.tsx
git commit -m "feat: return full result from JoinSessionModal"
```

---

### Task 19: Handle Remote Session Disconnection in App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

**Step 1: Add useEffect to listen for share:ended**

Add after the existing useEffect hooks (around line 549):

```typescript
// Handle remote session disconnection
useEffect(() => {
  const cleanup = window.electronAPI.onShareEnded((event) => {
    // Mark session as disconnected or remove it
    setRemoteSessions(prev => prev.filter(s => s.code !== event.code));
    // If viewing this session, switch away
    if (activeSessionId === `remote:${event.code}`) {
      const firstLocal = sessions[0];
      if (firstLocal) {
        setActiveSessionId(firstLocal.id);
      }
    }
  });
  return cleanup;
}, [activeSessionId, sessions, setActiveSessionId]);
```

**Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: handle remote session disconnection"
```

---

### Task 20: Render Remote Sessions Group in Sidebar

**Files:**
- Modify: `src/renderer/App.tsx` (in the sidebar JSX, after existing groups)

**Step 1: Add Remote Sessions group rendering**

After the existing groups map (around line 955), add:

```typescript
{/* Remote Sessions group - only visible when authenticated */}
{isAuthenticated && (
  <div className="group-container">
    <div className="group remote-group">
      <div className="group-header">
        <button
          className="group-chevron"
          onClick={() => {/* Could add collapse state */}}
          title="Remote Sessions"
        >
          ▼
        </button>
        <span className="group-color remote-color" style={{ background: '#9333ea' }} />
        <span className="group-name">Remote Sessions</span>
      </div>
      <div className="group-sessions">
        {/* Group by host */}
        {Object.entries(
          remoteSessions.reduce((acc, session) => {
            if (!acc[session.hostUsername]) acc[session.hostUsername] = [];
            acc[session.hostUsername].push(session);
            return acc;
          }, {} as Record<string, RemoteSession[]>)
        ).map(([hostUsername, hostSessions]) => (
          <div key={hostUsername} className="remote-host-group">
            <div className="remote-host-header">{hostUsername}</div>
            {hostSessions.map(session => (
              <div
                key={session.code}
                className={`session ${activeSessionId === `remote:${session.code}` ? 'active' : ''}`}
                onClick={() => setActiveSessionId(`remote:${session.code}`)}
              >
                <div className="session-info">
                  <span className="session-name">{session.sessionName}</span>
                </div>
                <span className={`status-pill ${session.permission}`}>
                  {session.permission}
                </span>
                <button
                  className="session-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.electronAPI.leaveSession(session.code);
                    setRemoteSessions(prev => prev.filter(s => s.code !== session.code));
                  }}
                  title="Leave session"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ))}
        {remoteSessions.length === 0 && (
          <div className="remote-empty">
            Click ⇄ to join a shared session
          </div>
        )}
      </div>
    </div>
  </div>
)}
```

**Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: render Remote Sessions group in sidebar"
```

---

### Task 21: Render RemoteTerminal for Active Remote Session

**Files:**
- Modify: `src/renderer/App.tsx` (in the terminal-area JSX)

**Step 1: Add RemoteTerminal rendering**

After the existing sessions.map (around line 984), add:

```typescript
{/* Remote sessions */}
{remoteSessions.map(session => (
  <div
    key={`remote:${session.code}`}
    className="terminal-wrapper"
    style={{ display: activeSessionId === `remote:${session.code}` ? 'flex' : 'none' }}
  >
    <div className="terminal-header">
      <div className="terminal-header-left">
        <span className="terminal-title">
          {session.sessionName} (from {session.hostUsername})
        </span>
        <span className={`permission-badge ${session.permission}`}>
          {session.permission === 'read' ? 'Read-only' : 'Control'}
        </span>
      </div>
      <div className="terminal-header-right">
        <button
          className="header-btn"
          onClick={() => {
            window.electronAPI.leaveSession(session.code);
            setRemoteSessions(prev => prev.filter(s => s.code !== session.code));
          }}
          title="Leave session"
        >
          Leave
        </button>
      </div>
    </div>
    <RemoteTerminal
      code={session.code}
      permission={session.permission}
      isActive={activeSessionId === `remote:${session.code}`}
    />
  </div>
))}
```

**Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: render RemoteTerminal for active remote session"
```

---

### Task 22: Add CSS Styles for Remote Sessions

**Files:**
- Modify: `src/renderer/styles/global.css`

**Step 1: Add remote session styles**

Add at end of file:

```css
/* Remote Sessions */
.remote-group {
  border-left: 3px solid #9333ea;
}

.remote-color {
  background: #9333ea !important;
}

.remote-host-group {
  margin-left: 8px;
}

.remote-host-header {
  font-size: 11px;
  color: #888;
  padding: 4px 8px;
  font-weight: 500;
}

.remote-empty {
  padding: 12px;
  color: #666;
  font-size: 12px;
  text-align: center;
}

.status-pill.read {
  background: #4a5568;
}

.status-pill.control {
  background: #9333ea;
}

.permission-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: 8px;
}

.permission-badge.read {
  background: #4a5568;
  color: #fff;
}

.permission-badge.control {
  background: #9333ea;
  color: #fff;
}
```

**Step 2: Commit**

```bash
git add src/renderer/styles/global.css
git commit -m "feat: add CSS styles for remote sessions"
```

---

## Part 5: Testing

### Task 23: Build and Test End-to-End

**Step 1: Build relay server**

```bash
cd ../claudelander-relay && npm run build
```

Expected: Build succeeds

**Step 2: Build client**

```bash
npm run build:main
```

Expected: Build succeeds

**Step 3: Start relay server**

```bash
cd ../claudelander-relay && npm run start:dev
```

**Step 4: Start client**

```bash
npm start
```

**Step 5: Manual test**

1. Sign in to both instances (host and guest)
2. Host: Right-click session → Share Session → Create code
3. Guest: Click ⇄ button → Enter code → Join
4. Verify: Remote Sessions group appears with host username sub-group
5. Verify: Clicking remote session shows terminal with host output
6. Verify: If control permission, typing works
7. Verify: Leaving session removes it from list

**Step 6: Final commit**

```bash
git add .
git commit -m "feat: complete remote session UI implementation"
```

---

## Summary

| Part | Tasks | Description |
|------|-------|-------------|
| 1 | 1-6 | Relay server: sessionName field + return host metadata |
| 2 | 7-9 | Share manager: pass/return session metadata |
| 3 | 10-14 | IPC layer: full metadata + writeToRemote |
| 4 | 15-22 | UI: RemoteTerminal + App.tsx integration |
| 5 | 23 | Testing end-to-end |
