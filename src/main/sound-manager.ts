import { BrowserWindow, app, webContents } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getPreference } from './repositories/preferences';

export type SoundEvent = 'waiting' | 'error' | 'start' | 'complete';

export type DebouncePreset = 'fast' | 'normal' | 'relaxed';

const DEBOUNCE_PRESETS: Record<DebouncePreset, number> = {
  fast: 200,
  normal: 500,
  relaxed: 1000,
};

interface SoundConfig {
  enabledKey: string;
  customPathKey: string;
  defaultFile: string;
}

const SOUND_CONFIGS: Record<SoundEvent, SoundConfig> = {
  waiting: {
    enabledKey: 'soundWaitingEnabled',
    customPathKey: 'soundWaitingCustomPath',
    defaultFile: 'waiting.wav',
  },
  error: {
    enabledKey: 'soundErrorEnabled',
    customPathKey: 'soundErrorCustomPath',
    defaultFile: 'error.wav',
  },
  start: {
    enabledKey: 'soundStartEnabled',
    customPathKey: 'soundStartCustomPath',
    defaultFile: 'start.wav',
  },
  complete: {
    enabledKey: 'soundCompleteEnabled',
    customPathKey: 'soundCompleteCustomPath',
    defaultFile: 'complete.wav',
  },
};

class SoundManager {
  private mainWindow: BrowserWindow | null = null;
  private lastState: Map<string, string> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private getSessionState: ((sessionId: string) => string | undefined) | null = null;

  /**
   * Set the session state lookup function (called from index.ts)
   */
  setSessionStateLookup(lookup: (sessionId: string) => string | undefined): void {
    this.getSessionState = lookup;
  }

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Get the master volume (0-100)
   */
  getVolume(): number {
    const pref = getPreference('soundVolume');
    const volume = pref ? parseInt(pref, 10) : 70;
    return Math.max(0, Math.min(100, volume));
  }

  /**
   * Check if a specific sound event is enabled
   */
  isEnabled(event: SoundEvent): boolean {
    const config = SOUND_CONFIGS[event];
    const pref = getPreference(config.enabledKey);
    return pref !== 'false'; // Default to true
  }

  /**
   * Check if sound notifications are globally enabled
   */
  isSoundEnabled(): boolean {
    const pref = getPreference('notificationSound');
    return pref !== 'false'; // Default to true
  }

  /**
   * Get the current debounce duration in milliseconds
   */
  getDebounceDuration(): number {
    const preset = getPreference('soundDebouncePreset') as DebouncePreset | null;
    return DEBOUNCE_PRESETS[preset || 'normal'];
  }

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

  /**
   * Get the sound file path for an event (custom or default)
   */
  getSoundPath(event: SoundEvent): string {
    const config = SOUND_CONFIGS[event];

    // Check for custom path
    const customPath = getPreference(config.customPathKey);
    if (customPath && fs.existsSync(customPath)) {
      return customPath;
    }

    // Use default bundled sound
    return this.getDefaultSoundPath(config.defaultFile);
  }

  /**
   * Get path to bundled default sound
   */
  private getDefaultSoundPath(filename: string): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'sounds', filename);
    }
    // Development: use resources folder
    return path.join(__dirname, '../../resources/sounds', filename);
  }

  /**
   * Play a sound for the given event
   */
  playSound(event: SoundEvent): void {
    // Check global sound setting
    if (!this.isSoundEnabled()) {
      return;
    }

    // Check if this specific event is enabled
    if (!this.isEnabled(event)) {
      return;
    }

    const soundPath = this.getSoundPath(event);
    if (!fs.existsSync(soundPath)) {
      console.warn(`Sound file not found: ${soundPath}`);
      return;
    }

    const volume = this.getVolume() / 100;

    // Send to renderer to play
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('sound:play', {
        path: soundPath,
        volume,
      });
    }
  }

  /**
   * Test play a sound (ignores enabled state, sends to all windows)
   * @param event - The sound event type
   * @param overrideVolume - Optional volume override (0-100), uses saved preference if not provided
   * @param overridePath - Optional path override, uses saved preference if not provided (empty string = use default)
   */
  testSound(event: SoundEvent, overrideVolume?: number, overridePath?: string): void {
    let soundPath: string;

    if (overridePath !== undefined) {
      // Use override path: empty string means default, otherwise use custom path
      if (overridePath === '' || !fs.existsSync(overridePath)) {
        soundPath = this.getDefaultSoundPath(SOUND_CONFIGS[event].defaultFile);
      } else {
        soundPath = overridePath;
      }
    } else {
      soundPath = this.getSoundPath(event);
    }

    if (!fs.existsSync(soundPath)) {
      console.warn(`Sound file not found: ${soundPath}`);
      return;
    }

    // Use override volume if provided, otherwise use saved preference
    const volumePercent = overrideVolume !== undefined ? overrideVolume : this.getVolume();
    const volume = Math.max(0, Math.min(100, volumePercent)) / 100;

    // Send to all windows (settings window may be focused)
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('sound:play', {
          path: soundPath,
          volume,
        });
      }
    });
  }

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

  /**
   * Play the session start sound
   * Note: This bypasses the debounce system intentionally because start sounds
   * are one-time events triggered on session creation, not state transitions.
   * There's no session state to validate against when a session is first created.
   */
  playStartSound(): void {
    this.playSound('start');
  }

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
}

export const soundManager = new SoundManager();
