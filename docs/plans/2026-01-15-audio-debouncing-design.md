# Audio Debouncing Design

**Issue:** #25 - Debounce on sounds generated
**Date:** 2026-01-15
**Status:** Approved

## Problem

ClaudeLander can produce too many concurrent/back-to-back sounds when session states change rapidly, creating an overwhelming audio experience.

## Solution

Implement per-session debouncing with state validation and configurable presets.

### Behavior

- **Debounce (trailing):** When sounds fire in quick succession, wait for a quiet period then play the *last* sound
- **State validation:** When the debounce timer fires, verify the session is still in the triggering state. If not, skip the sound (prevents stale/confusing audio)
- **Per-session:** Each session has its own debounce timer. Sounds from different sessions don't interfere with each other

### Configuration

**Preference:** `soundDebouncePreset`
**Type:** `'fast' | 'normal' | 'relaxed'`
**Default:** `'normal'`

| Preset | Duration | Description |
|--------|----------|-------------|
| Fast | 200ms | Quicker audio feedback |
| Normal | 500ms | Balanced (recommended) |
| Relaxed | 1000ms | Fewer interruptions |

## Technical Design

### Core Logic

```
Session state changes → scheduleSound(sessionId, event) called
    ↓
Clear any existing timer for this session
    ↓
Set new timer (duration from preset preference)
    ↓
When timer fires:
    1. Get current session state
    2. Compare to the event we were going to play
    3. If state still matches → play sound
    4. If state changed → skip (stale)
    ↓
Clean up timer reference
```

**Data structure:** `Map<sessionId, NodeJS.Timeout>` to track pending timers per session.

### State Validation Mapping

| Sound Event | Valid if session state is... |
|-------------|------------------------------|
| `waiting` | `waiting` |
| `error` | `error` |
| `start` | any (always valid - one-time event) |
| `complete` | `idle` (fires on working→idle) |

**Edge case:** If session is closed before timer fires, silently skip the sound.

### UI Layout

Located in Settings → Notifications tab → Sound Settings section:

```
┌─ Sound Settings ─────────────────────────────────────┐
│                                                      │
│  Sound Frequency                                     │
│  ┌──────────────────────────┐                        │
│  │ Normal (500ms)        ▼  │  ← Dropdown            │
│  └──────────────────────────┘                        │
│  "Controls how rapidly sounds can play"              │
│                                                      │
│  ─────────────────────────────────────────────────   │
│                                                      │
│  Master Volume                                       │
│  ○━━━━━━━━━━━●━━━━━━━━○  70%   ← Slider              │
│                                                      │
│  ─────────────────────────────────────────────────   │
│                                                      │
│  Individual Sounds                                   │
│  ┌─────────────┬────────┬────────┐                   │
│  │ Waiting     │  [On]  │ [Test] │                   │
│  │ Error       │  [On]  │ [Test] │                   │
│  │ Start       │  [Off] │ [Test] │                   │
│  │ Complete    │  [On]  │ [Test] │                   │
│  └─────────────┴────────┴────────┘                   │
│                                                      │
└──────────────────────────────────────────────────────┘
```

## Implementation

### Files to Modify

| File | Changes |
|------|---------|
| `src/main/sound-manager.ts` | Add debounce logic, timer map, state validation, `scheduleSound()` method |
| `src/main/index.ts` | Pass session state lookup function to SoundManager, update `handleStateChange` calls |
| `src/renderer/components/SettingsModal.tsx` | Build out Sound Settings UI with dropdown, volume slider, per-event toggles |
| `src/main/preload-settings.ts` | Ensure `soundDebouncePreset` pref is accessible |

### Implementation Order

1. Add debounce preference and preset mapping to SoundManager
2. Implement per-session timer tracking
3. Add state lookup integration
4. Wire up `scheduleSound()` to replace direct `playSound()` calls
5. Build Settings UI
6. Test with rapid state changes

### Breaking Changes

None - existing sound behavior preserved, just wrapped in debounce logic.
