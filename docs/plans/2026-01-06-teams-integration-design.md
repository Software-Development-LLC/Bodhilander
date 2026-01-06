# Microsoft Teams Integration Design

## Overview

Add native Microsoft Teams notifications to ClaudeLander, allowing users to receive activity feed notifications when sessions need attention. Also includes a settings UI refactor to support future integrations.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Integration type | Native Teams Activity Feed | Better UX than webhooks, no channel setup required |
| Auth flow | OAuth via external browser | Reuses existing deep link infrastructure, more trusted |
| Azure app | Single developer-managed app | Users just sign in, no Azure portal navigation |
| Events | Waiting, Error, Complete | "Needs attention" + "finished" - not session start |
| Scope | Global toggle only | Keep simple, add per-session overrides if requested |
| Settings UI | Sidebar navigation | Scales better, familiar Electron pattern |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ClaudeLander App                      │
├─────────────────────────────────────────────────────────┤
│  teams-auth.ts          - Microsoft OAuth flow          │
│  teams-notifier.ts      - Graph API notification sender │
│  notification-manager.ts - Extended to dispatch to Teams│
│  Settings UI            - Sidebar with Integrations tab │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│              Microsoft Graph API                         │
│  - OAuth 2.0 token exchange                             │
│  - POST /me/teamwork/sendActivityNotification           │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│              User's Teams Activity Feed                  │
│  - Notification appears in bell icon                    │
│  - Clicking opens claudelander:// deep link             │
└─────────────────────────────────────────────────────────┘
```

## Settings UI Refactor

### Sidebar Layout

```
┌──────────────────────────────────────────────────────────┐
│  Settings                                            ✕   │
├────────────┬─────────────────────────────────────────────┤
│            │                                             │
│  General   │  [Content for selected section]             │
│  Appearance│                                             │
│  Sounds    │                                             │
│Integrations│                                             │
│  Terminal  │                                             │
│            │                                             │
├────────────┴─────────────────────────────────────────────┤
│                    Reset to Defaults    Save & Close     │
└──────────────────────────────────────────────────────────┘
```

### Tab Contents

- **General** - Auto-launch Claude, custom shell path, close to tray
- **Appearance** - Splash screen toggle, duration
- **Sounds** - Master volume, per-event toggles and custom files
- **Integrations** - GitHub (sharing), Teams (notifications), future: Slack
- **Terminal** - Font size, WebGL renderer

### Integrations Section

```
┌─────────────────────────────────────────────────────────┐
│  Integrations                                           │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐    │
│  │ ⬛ GitHub                  user@email.com [Sign Out] │
│  │    ✓ Connected                                  │    │
│  │    Used for: Session sharing                    │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ 🟦 Microsoft Teams    user@company.com [Sign Out]│   │
│  │    ✓ Connected                                  │    │
│  │    Used for: Notifications                      │    │
│  │                                                 │    │
│  │    Notify on:                                   │    │
│  │    [✓] Waiting for input                        │    │
│  │    [✓] Errors                                   │    │
│  │    [✓] Task complete                            │    │
│  └─────────────────────────────────────────────────┘    │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │ 🟪 Slack                        [Coming Soon]   │    │
│  │    Not available yet                            │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## Authentication Flow

1. User clicks "Sign In" on Teams card
2. App opens default browser to Microsoft OAuth URL:
   ```
   https://login.microsoftonline.com/common/oauth2/v2.0/authorize
   ?client_id=<CLAUDELANDER_APP_ID>
   &response_type=code
   &redirect_uri=https://claudelander.app/auth/callback
   &scope=User.Read TeamsActivity.Send
   ```
3. User authenticates with Microsoft
4. Callback redirects to `claudelander://auth/teams?code=...`
5. App exchanges code for access token + refresh token
6. Tokens stored encrypted in preferences database
7. UI updates to show connected state + user email

### Token Management

- Access tokens expire (~1 hour) - auto-refresh using refresh token
- Refresh tokens last 90 days - if expired, user re-authenticates
- Sign Out clears all stored tokens

### Required Azure Permissions

- `User.Read` - Get user's email/name for display
- `TeamsActivity.Send` - Send activity feed notifications

## Notification Payload

```json
{
  "topic": {
    "source": "text",
    "value": "ClaudeLander",
    "webUrl": "claudelander://session/{sessionId}"
  },
  "activityType": "sessionWaiting",
  "previewText": {
    "content": "Session 'API Refactor' is waiting for input"
  },
  "templateParameters": [
    { "name": "sessionName", "value": "API Refactor" },
    { "name": "projectPath", "value": "/projects/myapp" },
    { "name": "eventType", "value": "Waiting for input" }
  ]
}
```

### Activity Types

| Type | Display |
|------|---------|
| `sessionWaiting` | ⏳ {sessionName} needs input |
| `sessionError` | ❌ {sessionName} encountered an error |
| `sessionComplete` | ✅ {sessionName} finished |

### Error Handling

- Token expired → Auto-refresh and retry once
- Refresh failed → Mark as disconnected, prompt re-auth
- Network error → Silent fail (don't block app)
- Rate limited → Back off, queue notifications

## Implementation

### New Files

```
src/main/
  teams-auth.ts          - Microsoft OAuth flow, token storage/refresh
  teams-notifier.ts      - Graph API calls to send activity notifications
```

### Modified Files

```
src/main/
  index.ts               - Add Teams IPC handlers
  notification-manager.ts - Dispatch to teams-notifier when connected
  preload-settings.ts    - Expose Teams auth APIs

src/renderer/
  settings.html          - Complete refactor to sidebar layout
```

### IPC Channels

```
teams:login              - Start OAuth flow
teams:logout             - Clear tokens
teams:getStatus          - Get connection state + user info
teams:testNotification   - Send a test notification
```

### New Preferences

```
teamsAccessToken         - Encrypted access token
teamsRefreshToken        - Encrypted refresh token
teamsUserEmail           - Display email
teamsNotifyWaiting       - Toggle (default: true)
teamsNotifyError         - Toggle (default: true)
teamsNotifyComplete      - Toggle (default: true)
```

## Azure Setup Required

1. Register app in Azure AD (Microsoft Entra)
2. Configure as public client (no client secret needed)
3. Add redirect URI: `https://claudelander.app/auth/callback`
4. Configure Teams activity notification types in manifest
5. Store Client ID in app config

## Future Considerations

- Slack integration (similar OAuth + API pattern)
- Discord integration
- Per-session notification overrides if requested
- Notification throttling/batching for high-activity sessions
