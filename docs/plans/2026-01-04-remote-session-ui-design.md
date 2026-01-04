# Remote Session UI Design

**Date:** 2026-01-04
**Status:** Approved

## Overview

Implement UI for viewing joined remote sessions. Currently, joining a session works on the backend (RelayClient connects successfully) but there's no UI to display the remote session content.

## Data Flow

```
Renderer                    Main Process                 Relay Server
   |                            |                            |
   |-- joinSession(code) ------>|                            |
   |                            |-- connectAsGuest(code) --->|
   |                            |<-- {hostUsername,          |
   |                            |     sessionName,           |
   |                            |     permission} -----------|
   |                            |                            |
   |<-- {id, hostUsername,      |                            |
   |     sessionName,           |                            |
   |     permission} -----------|                            |
   |                            |                            |
   |   [User selects session]   |                            |
   |                            |<== encrypted data =========|
   |<-- onRemoteData(id, data) -|                            |
   |                            |                            |
   |-- writeToRemote(id, input)-|== encrypted input ========>|
```

Remote sessions are NOT stored in the database - they're ephemeral and exist only while connected. Tracked in renderer state.

### New IPC Channels

- `joinSession(code)` → returns `{code, hostUsername, sessionName, permission}`
- `onRemoteData(callback)` → receives terminal output from host
- `writeToRemote(code, data)` → sends input to host (if permission = 'control')
- `leaveSession(code)` → disconnects
- `onRemoteDisconnected(callback)` → notifies when host disconnects

## UI Structure

### Sidebar Hierarchy

```
Groups (existing)
├── My Project
│   └── Session 1
└── Another Group
    └── Session 2

Remote Sessions (always visible when signed in)
├── alice-github (auto sub-group per host)
│   └── "Feature Work" [read]
└── bob-dev (auto sub-group per host)
    └── "Bug Fix" [control]
```

### Remote Sessions Group Behavior

- Always visible when `isAuthenticated` (makes join feature discoverable)
- Not stored in database - rendered conditionally
- Not draggable, not deletable, no working directory
- Sub-groups auto-created when joining, auto-removed when leaving
- Sessions show permission badge: `[read]` or `[control]`

### Renderer State

```typescript
interface RemoteSession {
  code: string;           // Share code (used as ID)
  hostUsername: string;   // GitHub username of host
  sessionName: string;    // What host named their session
  permission: 'read' | 'control';
  connectedAt: string;    // ISO timestamp
}

// In App.tsx or dedicated store
const [remoteSessions, setRemoteSessions] = useState<RemoteSession[]>([]);
```

Group by `hostUsername` to render sub-groups.

## RemoteTerminal Component

New component: `src/renderer/components/RemoteTerminal.tsx`

### Props

```typescript
interface RemoteTerminalProps {
  code: string;                    // Share code (session ID)
  permission: 'read' | 'control';
  isActive: boolean;
}
```

### Differences from Local Terminal

| Local Terminal | Remote Terminal |
|----------------|-----------------|
| Creates PTY via `createSession()` | No PTY - already connected |
| Receives via `onPtyData()` | Receives via `onRemoteData()` |
| Sends via `writeToSession()` | Sends via `writeToRemote()` |
| Resize notifies PTY | Resize is local-only (display) |
| Can always type | Only if `permission === 'control'` |

### Read-only Mode

When `permission === 'read'`:
- Disable keyboard input (don't send to relay)
- Show visual indicator (e.g., "Read-only" in header or cursor style)
- Copy still works (Ctrl+Shift+C)

### Connection Handling

- Listen for `onRemoteDisconnected(code)` to show "Host disconnected" state
- Cleanup on unmount doesn't kill anything (host owns the session)

## Relay Server Changes

### 1. Add sessionName to ShareSession Entity

```typescript
// src/entities/share-session.entity.ts
@Column({ nullable: true })
sessionName: string;
```

### 2. Update Session Creation

Accept `sessionName` in POST /sessions body.

### 3. Update joinAsGuest Response

```typescript
// relay.gateway.ts - handleJoinAsGuest
return {
  success: true,
  hostPublicKey: session.hostPublicKey,
  hostUsername: session.host.username,  // NEW
  sessionName: session.sessionName,      // NEW
  permission,
};
```

### 4. Include Host Relation in Query

Ensure session query joins the host user to get username.

## Client Changes (claudelander)

### 1. Update share-manager.ts

- `startSharing()` - pass session name to server
- `joinSession()` - return full metadata from server response

### 2. Update IPC handlers (index.ts, preload.ts)

- Add `onRemoteData` channel
- Add `writeToRemote` channel
- Add `onRemoteDisconnected` channel
- Update `joinSession` return type

### 3. Update App.tsx

- Add `remoteSessions` state
- Render "Remote Sessions" group when authenticated
- Group sessions by hostUsername for sub-groups
- Handle `onJoined` to add to state
- Render RemoteTerminal for active remote session

### 4. Create RemoteTerminal.tsx

New component using XTerm.js with relay data instead of PTY.

## Implementation Order

1. Relay server changes (entity, gateway response)
2. Client share-manager updates
3. IPC channel additions
4. RemoteTerminal component
5. App.tsx UI integration
6. Testing end-to-end
