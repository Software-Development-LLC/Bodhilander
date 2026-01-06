# Sound Notifications Design

## Overview

Add customizable sound notifications for session state changes with volume control and per-event configuration.

## Sound Events

| Event | Trigger | Sound Character |
|-------|---------|-----------------|
| `waiting` | Session needs user input | Gentle chime |
| `error` | Session entered error state | Low warning tone |
| `start` | New session created | Rising tone |
| `complete` | Session finished (working → idle) | Pleasant ding |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  SoundManager (main process)                        │
│  - Manages sound playback via IPC to renderer       │
│  - Reads volume/custom paths from preferences       │
│  - Exposes: playSound(event), testSound(event)      │
└─────────────────────────────────────────────────────┘
          │ IPC: sound:play
          ▼
┌─────────────────────────────────────────────────────┐
│  Renderer Process                                   │
│  - HTML5 Audio for cross-platform playback          │
│  - Applies volume setting                           │
└─────────────────────────────────────────────────────┘
```

## Settings UI

New "Sound Notifications" section in settings:

```
┌─────────────────────────────────────────────────────┐
│ SOUND NOTIFICATIONS                                 │
├─────────────────────────────────────────────────────┤
│ Master Volume          [━━━━━━━━━●━━] 70%          │
├─────────────────────────────────────────────────────┤
│ Waiting Sound          [✓]  [Default ▼] [Test]     │
│ Session needs input                                 │
├─────────────────────────────────────────────────────┤
│ Error Sound            [✓]  [Default ▼] [Test]     │
│ Session entered error state                         │
├─────────────────────────────────────────────────────┤
│ Session Start Sound    [✓]  [Default ▼] [Test]     │
│ New session created                                 │
├─────────────────────────────────────────────────────┤
│ Complete Sound         [✓]  [Default ▼] [Test]     │
│ Session finished task                               │
└─────────────────────────────────────────────────────┘
```

Each row:
- Toggle: enable/disable specific sound
- Dropdown: "Default" or "Custom..."
- Custom selection opens file picker (.wav, .mp3, .ogg)
- Test button plays sound at current volume

## Preferences

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `soundVolume` | string | "70" | Master volume 0-100 |
| `soundWaitingEnabled` | string | "true" | Enable waiting sound |
| `soundWaitingCustomPath` | string | "" | Custom file path (empty = default) |
| `soundErrorEnabled` | string | "true" | Enable error sound |
| `soundErrorCustomPath` | string | "" | Custom file path |
| `soundStartEnabled` | string | "true" | Enable start sound |
| `soundStartCustomPath` | string | "" | Custom file path |
| `soundCompleteEnabled` | string | "true" | Enable complete sound |
| `soundCompleteCustomPath` | string | "" | Custom file path |

## File Structure

**New files:**
```
src/main/sound-manager.ts     # SoundManager class
resources/sounds/             # Bundled with app via extraResources
  waiting.wav
  error.wav
  start.wav
  complete.wav
```

**Modified files:**
- `src/main/index.ts` - Wire up SoundManager, add IPC handlers
- `src/main/preload.ts` - Expose sound IPC
- `src/renderer/types/electron.d.ts` - Type definitions
- `src/renderer/settings.html` - Sound settings UI
- `electron-builder.json` - extraResources for sounds

## Implementation Details

### SoundManager (main process)

```typescript
class SoundManager {
  playSound(event: 'waiting' | 'error' | 'start' | 'complete'): void
  testSound(event: string): void
  private getSoundPath(event: string): string
  private isEnabled(event: string): boolean
  private getVolume(): number
}
```

### Trigger Points

| Event | File | Location |
|-------|------|----------|
| waiting | `index.ts` | stateMonitor 'stateChange' handler |
| error | `index.ts` | stateMonitor 'stateChange' handler |
| start | `index.ts` | createSession IPC handler |
| complete | `index.ts` | stateMonitor 'stateChange' handler (working→idle) |

### Sound Playback Flow

1. State change detected in main process
2. SoundManager checks if sound enabled for event
3. SoundManager gets sound path (custom or default)
4. IPC send to renderer: `sound:play { path, volume }`
5. Renderer creates Audio element and plays

### Bundled Sounds

Source royalty-free notification sounds or generate simple tones:
- Short duration (0.3-1.0 seconds)
- Distinct character for each event
- Pleasant, non-jarring tones

## Testing

- [ ] Volume slider changes playback volume
- [ ] Each sound can be toggled on/off independently
- [ ] Test buttons play correct sounds
- [ ] Custom file picker works
- [ ] Sounds trigger on correct state changes
- [ ] Sounds respect enabled/disabled state
- [ ] Works on Windows, macOS, Linux
