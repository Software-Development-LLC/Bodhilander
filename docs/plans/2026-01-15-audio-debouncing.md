# Audio Debouncing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-session sound debouncing with state validation and configurable presets to reduce overwhelming audio feedback.

**Architecture:** Wrap existing `playSound()` calls in a debounce mechanism that uses per-session timers. When timer fires, validate the session is still in the triggering state before playing. Add a dropdown in Settings to configure debounce duration.

**Tech Stack:** Electron (main process), React (renderer), TypeScript

---

## Task 1: Add Debounce Types and Preset Config

**Files:**
- Modify: `D:\Projects\claudelander\src\main\sound-manager.ts:1-15`

**Step 1: Add types and constants**

Add after line 6 (after `SoundEvent` type):

```typescript
export type DebouncePreset = 'fast' | 'normal' | 'relaxed';

const DEBOUNCE_PRESETS: Record<DebouncePreset, number> = {
  fast: 200,
  normal: 500,
  relaxed: 1000,
};
```

**Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: No errors related to sound-manager.ts

**Step 3: Commit**

```bash
git add src/main/sound-manager.ts
git commit -m "feat(sound): add debounce preset types and constants"
```

---

## Task 2: Add Debounce State to SoundManager

**Files:**
- Modify: `D:\Projects\claudelander\src\main\sound-manager.ts:37-43`

**Step 1: Add timer tracking and state lookup**

In the `SoundManager` class, add after line 39 (`lastState` declaration):

```typescript
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private getSessionState: ((sessionId: string) => string | undefined) | null = null;

  /**
   * Set the session state lookup function (called from index.ts)
   */
  setSessionStateLookup(lookup: (sessionId: string) => string | undefined): void {
    this.getSessionState = lookup;
  }
```

**Step 2: Add method to get debounce duration**

Add after the `isSoundEnabled()` method (around line 69):

```typescript
  /**
   * Get the current debounce duration in milliseconds
   */
  getDebounceDuration(): number {
    const preset = getPreference('soundDebouncePreset') as DebouncePreset | null;
    return DEBOUNCE_PRESETS[preset || 'normal'];
  }
```

**Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 4: Commit**

```bash
git add src/main/sound-manager.ts
git commit -m "feat(sound): add debounce timer tracking and state lookup"
```

---

## Task 3: Implement scheduleSound Method

**Files:**
- Modify: `D:\Projects\claudelander\src\main\sound-manager.ts`

**Step 1: Add state validation mapping**

Add after `getDebounceDuration()` method:

```typescript
  /**
   * Check if a sound event is still valid for the current session state
   */
  private isEventValidForState(event: SoundEvent, currentState: string | undefined): boolean {
    if (!currentState) return false;

    switch (event) {
      case 'waiting':
        return currentState === 'waiting';
      case 'error':
        return currentState === 'error';
      case 'start':
        return true; // Start sound always valid (one-time event)
      case 'complete':
        return currentState === 'idle'; // Complete fires on working->idle
      default:
        return false;
    }
  }
```

**Step 2: Add scheduleSound method**

Add after `isEventValidForState()`:

```typescript
  /**
   * Schedule a sound to play after debounce delay
   * Validates session state before playing
   */
  scheduleSound(sessionId: string, event: SoundEvent): void {
    // Clear any existing timer for this session
    const existingTimer = this.debounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const delay = this.getDebounceDuration();

    const timer = setTimeout(() => {
      // Clean up timer reference
      this.debounceTimers.delete(sessionId);

      // Validate session state before playing
      if (this.getSessionState) {
        const currentState = this.getSessionState(sessionId);
        if (!this.isEventValidForState(event, currentState)) {
          console.debug(`[SoundManager] Skipping ${event} sound - session ${sessionId} state changed to ${currentState}`);
          return;
        }
      }

      // Play the sound
      this.playSound(event);
    }, delay);

    this.debounceTimers.set(sessionId, timer);
  }
```

**Step 3: Update removeSession to clear timers**

Modify the existing `removeSession` method (around line 199):

```typescript
  /**
   * Clean up state for a removed session
   */
  removeSession(sessionId: string): void {
    this.lastState.delete(sessionId);

    // Clear any pending debounce timer
    const timer = this.debounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(sessionId);
    }
  }
```

**Step 4: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 5: Commit**

```bash
git add src/main/sound-manager.ts
git commit -m "feat(sound): implement scheduleSound with state validation"
```

---

## Task 4: Wire Up Debounce in handleStateChange

**Files:**
- Modify: `D:\Projects\claudelander\src\main\sound-manager.ts:172-187`

**Step 1: Update handleStateChange to use scheduleSound**

Replace the current `handleStateChange` method:

```typescript
  /**
   * Handle session state change and schedule appropriate sound
   */
  handleStateChange(sessionId: string, newState: string, previousState?: string): void {
    const lastKnown = previousState || this.lastState.get(sessionId);

    // Determine which sound to schedule based on state transition
    if (newState === 'waiting') {
      this.scheduleSound(sessionId, 'waiting');
    } else if (newState === 'error') {
      this.scheduleSound(sessionId, 'error');
    } else if (newState === 'idle' && lastKnown === 'working') {
      // Task completed (working -> idle)
      this.scheduleSound(sessionId, 'complete');
    }

    // Update last known state
    this.lastState.set(sessionId, newState);
  }
```

**Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add src/main/sound-manager.ts
git commit -m "feat(sound): wire handleStateChange to use debounced scheduling"
```

---

## Task 5: Connect State Lookup in index.ts

**Files:**
- Modify: `D:\Projects\claudelander\src\main\index.ts`

**Step 1: Add state lookup function after sessionStates declaration**

Find line 114 (`const sessionStates: Map<string, { name: string; state: string }> = new Map();`) and add after it:

```typescript
// Provide state lookup to sound manager for debounce validation
soundManager.setSessionStateLookup((sessionId: string) => {
  return sessionStates.get(sessionId)?.state;
});
```

**Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Test debounce manually**

Run: `npm start`

Test by:
1. Open a session
2. Rapidly change states (if possible via CLI interactions)
3. Observe sounds are debounced (not playing back-to-back)

**Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(sound): connect session state lookup for debounce validation"
```

---

## Task 6: Build Sound Settings UI - State and Hooks

**Files:**
- Modify: `D:\Projects\claudelander\src\renderer\components\SettingsModal.tsx`

**Step 1: Add sound settings state**

Add after line 27 (`const [remoteLoading, setRemoteLoading] = useState(false);`):

```typescript
  // Sound settings state
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundVolume, setSoundVolume] = useState(70);
  const [debouncePreset, setDebouncePreset] = useState<'fast' | 'normal' | 'relaxed'>('normal');
  const [soundWaitingEnabled, setSoundWaitingEnabled] = useState(true);
  const [soundErrorEnabled, setSoundErrorEnabled] = useState(true);
  const [soundStartEnabled, setSoundStartEnabled] = useState(true);
  const [soundCompleteEnabled, setSoundCompleteEnabled] = useState(true);
```

**Step 2: Load sound settings in useEffect**

In the `loadState` async function (around line 34), add to the Promise.all array and handling:

Replace the existing `loadState` function:

```typescript
    const loadState = async () => {
      try {
        const [status, devices, hasPairingResult, remoteAccessStatus] = await Promise.all([
          window.electronAPI.apiGetStatus(),
          window.electronAPI.apiGetPairedDevices(),
          window.electronAPI.apiHasPairingCode(),
          window.electronAPI.apiGetRemoteAccessStatus(),
        ]);
        setApiStatus(status);
        setPairedDevices(devices);
        if (!hasPairingResult.active) {
          setPairingCode(null);
        }
        setRemoteStatus(remoteAccessStatus);

        // Load sound settings
        if (window.settingsAPI) {
          const [
            soundEnabledPref,
            volumePref,
            debouncePref,
            waitingPref,
            errorPref,
            startPref,
            completePref,
          ] = await Promise.all([
            window.settingsAPI.getPreference('notificationSound'),
            window.settingsAPI.getPreference('soundVolume'),
            window.settingsAPI.getPreference('soundDebouncePreset'),
            window.settingsAPI.getPreference('soundWaitingEnabled'),
            window.settingsAPI.getPreference('soundErrorEnabled'),
            window.settingsAPI.getPreference('soundStartEnabled'),
            window.settingsAPI.getPreference('soundCompleteEnabled'),
          ]);

          setSoundEnabled(soundEnabledPref !== 'false');
          setSoundVolume(volumePref ? parseInt(volumePref, 10) : 70);
          setDebouncePreset((debouncePref as 'fast' | 'normal' | 'relaxed') || 'normal');
          setSoundWaitingEnabled(waitingPref !== 'false');
          setSoundErrorEnabled(errorPref !== 'false');
          setSoundStartEnabled(startPref !== 'false');
          setSoundCompleteEnabled(completePref !== 'false');
        }
      } catch (err) {
        console.error('Failed to load API state:', err);
      }
    };
```

**Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 4: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx
git commit -m "feat(ui): add sound settings state and loading"
```

---

## Task 7: Build Sound Settings UI - Handlers

**Files:**
- Modify: `D:\Projects\claudelander\src\renderer\components\SettingsModal.tsx`

**Step 1: Add sound setting handlers**

Add after `handleDisableRemoteAccess` callback (around line 165):

```typescript
  // Sound setting handlers
  const handleSoundEnabledChange = useCallback(async (enabled: boolean) => {
    setSoundEnabled(enabled);
    await window.settingsAPI?.setPreference('notificationSound', enabled.toString());
  }, []);

  const handleVolumeChange = useCallback(async (volume: number) => {
    setSoundVolume(volume);
    await window.settingsAPI?.setPreference('soundVolume', volume.toString());
  }, []);

  const handleDebouncePresetChange = useCallback(async (preset: 'fast' | 'normal' | 'relaxed') => {
    setDebouncePreset(preset);
    await window.settingsAPI?.setPreference('soundDebouncePreset', preset);
  }, []);

  const handleSoundToggle = useCallback(async (
    event: 'waiting' | 'error' | 'start' | 'complete',
    enabled: boolean
  ) => {
    const prefKey = `sound${event.charAt(0).toUpperCase() + event.slice(1)}Enabled`;
    await window.settingsAPI?.setPreference(prefKey, enabled.toString());

    switch (event) {
      case 'waiting': setSoundWaitingEnabled(enabled); break;
      case 'error': setSoundErrorEnabled(enabled); break;
      case 'start': setSoundStartEnabled(enabled); break;
      case 'complete': setSoundCompleteEnabled(enabled); break;
    }
  }, []);

  const handleTestSound = useCallback(async (event: 'waiting' | 'error' | 'start' | 'complete') => {
    await window.settingsAPI?.testSound(event, soundVolume);
  }, [soundVolume]);
```

**Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx
git commit -m "feat(ui): add sound settings handlers"
```

---

## Task 8: Build Sound Settings UI - Render

**Files:**
- Modify: `D:\Projects\claudelander\src\renderer\components\SettingsModal.tsx:409-414`

**Step 1: Replace notifications placeholder with Sound Settings UI**

Replace the notifications tab content (lines 409-414):

```typescript
            {activeTab === 'notifications' && (
              <div className="settings-section">
                <h3>Sound Settings</h3>

                <div className="settings-group">
                  <div className="settings-row">
                    <label htmlFor="sound-enabled">Enable Sounds:</label>
                    <input
                      id="sound-enabled"
                      type="checkbox"
                      checked={soundEnabled}
                      onChange={e => handleSoundEnabledChange(e.target.checked)}
                    />
                  </div>
                </div>

                {soundEnabled && (
                  <>
                    <div className="settings-group">
                      <h4>Sound Frequency</h4>
                      <p className="settings-description">
                        Controls how rapidly sounds can play when states change quickly.
                      </p>
                      <div className="settings-row">
                        <label htmlFor="debounce-preset">Preset:</label>
                        <select
                          id="debounce-preset"
                          value={debouncePreset}
                          onChange={e => handleDebouncePresetChange(e.target.value as 'fast' | 'normal' | 'relaxed')}
                        >
                          <option value="fast">Fast (200ms)</option>
                          <option value="normal">Normal (500ms) - Recommended</option>
                          <option value="relaxed">Relaxed (1000ms)</option>
                        </select>
                      </div>
                    </div>

                    <div className="settings-group">
                      <h4>Master Volume</h4>
                      <div className="settings-row volume-row">
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={soundVolume}
                          onChange={e => handleVolumeChange(parseInt(e.target.value, 10))}
                        />
                        <span className="volume-value">{soundVolume}%</span>
                      </div>
                    </div>

                    <div className="settings-group">
                      <h4>Individual Sounds</h4>
                      <div className="sound-events-list">
                        {[
                          { event: 'waiting' as const, label: 'Waiting for Input', enabled: soundWaitingEnabled },
                          { event: 'error' as const, label: 'Error', enabled: soundErrorEnabled },
                          { event: 'start' as const, label: 'Session Start', enabled: soundStartEnabled },
                          { event: 'complete' as const, label: 'Task Complete', enabled: soundCompleteEnabled },
                        ].map(({ event, label, enabled }) => (
                          <div key={event} className="sound-event-row">
                            <span className="sound-event-label">{label}</span>
                            <label className="sound-event-toggle">
                              <input
                                type="checkbox"
                                checked={enabled}
                                onChange={e => handleSoundToggle(event, e.target.checked)}
                              />
                              <span>{enabled ? 'On' : 'Off'}</span>
                            </label>
                            <button
                              className="btn btn-small btn-secondary"
                              onClick={() => handleTestSound(event)}
                              disabled={!enabled}
                            >
                              Test
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
```

**Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Commit**

```bash
git add src/renderer/components/SettingsModal.tsx
git commit -m "feat(ui): implement sound settings panel with debounce preset dropdown"
```

---

## Task 9: Add CSS Styles for Sound Settings

**Files:**
- Modify: `D:\Projects\claudelander\src\renderer\styles\settings.css` (or wherever settings styles live)

**Step 1: Find the settings styles file**

Run: `dir /s /b D:\Projects\claudelander\src\renderer\*.css | findstr -i settings`

If not found, check for a main styles file or add to existing styles.

**Step 2: Add sound settings styles**

Add these styles:

```css
/* Sound Settings */
.volume-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.volume-row input[type="range"] {
  flex: 1;
  max-width: 200px;
}

.volume-value {
  min-width: 40px;
  text-align: right;
}

.sound-events-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sound-event-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-color, #333);
}

.sound-event-row:last-child {
  border-bottom: none;
}

.sound-event-label {
  flex: 1;
  min-width: 120px;
}

.sound-event-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 60px;
}

.sound-event-toggle input {
  margin: 0;
}
```

**Step 3: Verify app renders correctly**

Run: `npm start`

Navigate to Settings > Notifications and verify:
- Sound Frequency dropdown appears
- Volume slider works
- Individual sound toggles appear
- Test buttons play sounds

**Step 4: Commit**

```bash
git add src/renderer/
git commit -m "feat(ui): add CSS styles for sound settings panel"
```

---

## Task 10: Add settingsAPI Type Declaration

**Files:**
- Modify: Type declaration file for window.settingsAPI

**Step 1: Find the type declaration**

Run: `findstr /s /i "settingsAPI" D:\Projects\claudelander\src\*.d.ts D:\Projects\claudelander\src\*.ts`

**Step 2: Add settingsAPI to window type if missing**

If not declared, add to the appropriate `.d.ts` file or create one:

```typescript
interface SettingsAPI {
  getPreference: (key: string) => Promise<string | null>;
  setPreference: (key: string, value: string) => Promise<void>;
  getAllSettings: () => Promise<Record<string, string>>;
  testSound: (event: 'waiting' | 'error' | 'start' | 'complete', volume?: number, customPath?: string) => Promise<void>;
  selectSoundFile: () => Promise<string | null>;
  platform: string;
  githubLogin: () => Promise<void>;
  githubLogout: () => Promise<void>;
  githubGetUser: () => Promise<{ username: string; avatarUrl: string } | null>;
  teamsLogin: () => Promise<void>;
  teamsLogout: () => Promise<void>;
  teamsGetStatus: () => Promise<{ connected: boolean; user: { email: string; displayName: string } | null }>;
  teamsTestNotification: () => Promise<boolean>;
}

declare global {
  interface Window {
    settingsAPI?: SettingsAPI;
  }
}
```

**Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: No errors

**Step 4: Commit**

```bash
git add src/
git commit -m "fix(types): add settingsAPI window type declaration"
```

---

## Task 11: Final Integration Test

**Step 1: Run full build**

Run: `npm run build`
Expected: Build succeeds

**Step 2: Run type check**

Run: `npm run typecheck`
Expected: No errors

**Step 3: Manual testing**

Run: `npm start`

Test scenarios:
1. Open Settings > Notifications
2. Verify Sound Frequency dropdown shows Fast/Normal/Relaxed
3. Change preset and verify it persists after closing/reopening settings
4. Test volume slider
5. Toggle individual sounds and test each
6. Open a Claude session and observe sounds are debounced
7. Rapidly trigger state changes and verify only appropriate sounds play

**Step 4: Final commit**

```bash
git add .
git commit -m "feat(sound): complete audio debouncing implementation

- Add per-session debounce with configurable presets (Fast/Normal/Relaxed)
- Validate session state before playing debounced sounds
- Build Sound Settings UI in Settings > Notifications
- Include volume control and per-event toggles

Closes #25"
```

---

## Summary

| Task | Description |
|------|-------------|
| 1 | Add debounce types and preset constants |
| 2 | Add timer tracking and state lookup to SoundManager |
| 3 | Implement scheduleSound with state validation |
| 4 | Wire handleStateChange to use debounced scheduling |
| 5 | Connect state lookup in index.ts |
| 6 | Add sound settings state and loading in UI |
| 7 | Add sound setting handlers |
| 8 | Build Sound Settings UI render |
| 9 | Add CSS styles |
| 10 | Add settingsAPI type declaration |
| 11 | Final integration test |
