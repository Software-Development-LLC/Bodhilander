# Settings Consolidation Design

**Date:** 2026-01-16
**Status:** Approved

## Problem

ClaudeLander has two separate settings interfaces:
1. **Cog Wheel SettingsModal** - React component with 3 tabs
2. **Ctrl+Comma Settings Window** - Separate HTML window with 5 panels

This is confusing for users and duplicates the Sound settings.

## Solution

Consolidate all settings into the SettingsModal (cog wheel) and make Ctrl+Comma open it.

## Tab Structure

**6 tabs in logical grouping order:**

| Tab | Content |
|-----|---------|
| **General** | Auto-launch Claude toggle, Custom Shell Path input, Close to Tray toggle |
| **Appearance** | Show Splash Screen toggle, Splash Duration slider (1-5s) |
| **Terminal** | Font Size slider (10-24px), Enable WebGL Rendering toggle |
| **Sound** | Desktop Notifications toggle, Master Volume, Debounce Preset dropdown, Individual sound toggles with Test buttons |
| **Integrations** | GitHub Sign In/Out, Microsoft Teams (Coming Soon) |
| **Mobile App** | API server, pairing, remote access (existing) |

**Default tab:** General

## Technical Changes

### Files to Modify

| File | Change |
|------|--------|
| `src/renderer/components/SettingsModal.tsx` | Add 4 new tabs, update Sound tab, change default to 'general' |
| `src/main/menu.ts` | Change Ctrl+Comma to send IPC message instead of creating window |
| `src/main/preload.ts` | Expose `onOpenSettings` listener |
| `src/renderer/App.tsx` | Listen for open-settings event |

### Files to Delete

| File | Reason |
|------|--------|
| `src/renderer/settings.html` | Replaced by SettingsModal |
| `src/main/preload-settings.ts` | No longer needed |

### Menu Changes

- Remove "Settings" / "Preferences..." from Session menu
- Keep Ctrl+Comma shortcut but redirect to SettingsModal

## IPC Flow

```
Menu Ctrl+Comma click
    ↓
mainWindow.webContents.send('open-settings')
    ↓
preload.ts onOpenSettings listener
    ↓
App.tsx callback sets showSettings state
    ↓
SettingsModal opens with General tab
```

## Migration

No data migration needed - preferences are stored in SQLite and both UIs use the same preference keys.

## Tab Type

```typescript
// New tab type
type SettingsTab = 'general' | 'appearance' | 'terminal' | 'sound' | 'integrations' | 'mobile';

// Default
const [activeTab, setActiveTab] = useState<SettingsTab>('general');
```
