/**
 * Install-prompt state store + gating logic for the mobile PWA (BDHLNDR-61).
 *
 * iOS Web Push (BDHLNDR-49) only works for PWAs *installed* to the home
 * screen — Safari refuses to register push for ordinary tabs. Android Chrome
 * is more forgiving but installing still significantly improves UX
 * (full-screen, persistent notifications, faster launch).
 *
 * After a successful first pair (BDHLNDR-54 wrote a `paired_at` timestamp
 * into the auth row), we show a platform-specific walkthrough. The user can
 * dismiss it; we snooze for 7 days. Once the PWA is actually installed
 * (detected via `display-mode: standalone` matching or the `appinstalled`
 * event), we mark `installed_at` and never show again.
 *
 * State lives in IndexedDB so it survives reloads. We share the existing
 * `bodhilander` database created by `auth.ts` — this module is responsible
 * for bumping the schema to v2 (adding the `install_prompt` store). The
 * `auth` store created at v1 is left untouched.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import { detectPlatform } from './platform';

const DB_NAME = 'bodhilander';
/**
 * v2 = added `install_prompt` store (BDHLNDR-61).
 * v1 = `auth` store (BDHLNDR-54).
 *
 * If you bump this further, mirror the new version in `auth.ts:DB_VERSION`
 * — both modules must agree on which version they're opening at, otherwise
 * one of them triggers a `VersionError` on `openDB`.
 */
const DB_VERSION = 2;
const AUTH_STORE = 'auth';
const PROMPT_STORE = 'install_prompt';
const PROMPT_ROW_ID = 'state';

/** 7 days in ms — how long "Maybe later" snoozes the iOS prompt. */
const DISMISS_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The single row we persist in `install_prompt`. All timestamps are
 * `Date.now()` epoch ms, or `null` if the corresponding event hasn't
 * happened yet.
 */
export interface InstallState {
  id: typeof PROMPT_ROW_ID;
  dismissed_at: number | null;
  installed_at: number | null;
  last_shown_at: number | null;
}

interface BodhilanderDB extends DBSchema {
  [AUTH_STORE]: {
    key: string;
    // We don't read auth here, so leave the value type open. The real
    // shape is owned by `auth.ts:AuthRecord`.
    value: unknown;
  };
  [PROMPT_STORE]: {
    key: string;
    value: InstallState;
  };
}

let dbPromise: Promise<IDBPDatabase<BodhilanderDB>> | null = null;

function getDB(): Promise<IDBPDatabase<BodhilanderDB>> {
  if (!dbPromise) {
    dbPromise = openDB<BodhilanderDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1: create the auth store (BDHLNDR-54). Safe to re-run defensively
        // in case this module wins the race to open the DB before auth.ts.
        if (oldVersion < 1 && !db.objectStoreNames.contains(AUTH_STORE)) {
          db.createObjectStore(AUTH_STORE, { keyPath: 'id' });
        }
        // v2: install-prompt state (this ticket).
        if (oldVersion < 2 && !db.objectStoreNames.contains(PROMPT_STORE)) {
          db.createObjectStore(PROMPT_STORE, { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

function emptyState(): InstallState {
  return {
    id: PROMPT_ROW_ID,
    dismissed_at: null,
    installed_at: null,
    last_shown_at: null,
  };
}

/**
 * Read the install-prompt row. Returns a zeroed-out state if the row hasn't
 * been written yet (first run) or if IndexedDB throws (private browsing,
 * locked-down contexts) — the gating logic then falls back to
 * "act as if we've never shown it", which is the desired UX.
 */
export async function getInstallState(): Promise<InstallState> {
  try {
    const db = await getDB();
    const row = await db.get(PROMPT_STORE, PROMPT_ROW_ID);
    return row ?? emptyState();
  } catch (err) {
    console.error('[install-prompt] Failed to read IndexedDB:', err);
    return emptyState();
  }
}

async function patchState(patch: Partial<InstallState>): Promise<void> {
  try {
    const db = await getDB();
    const current = (await db.get(PROMPT_STORE, PROMPT_ROW_ID)) ?? emptyState();
    const next: InstallState = { ...current, ...patch, id: PROMPT_ROW_ID };
    await db.put(PROMPT_STORE, next);
  } catch (err) {
    // Non-fatal — at worst we re-prompt next session.
    console.error('[install-prompt] Failed to write IndexedDB:', err);
  }
}

/**
 * User tapped "Maybe later" / "Not now". Snoozes for ~7 days via the
 * gating logic in `shouldShowPrompt`.
 */
export async function markDismissed(): Promise<void> {
  await patchState({ dismissed_at: Date.now() });
}

/**
 * User tapped "Got it" (iOS) without dismissing — they've seen the
 * walkthrough but might come back. We don't snooze, we just record that
 * the prompt has been displayed at least once so we don't re-pop it
 * aggressively on every reload.
 */
export async function markShown(): Promise<void> {
  await patchState({ last_shown_at: Date.now() });
}

/**
 * The PWA is now installed (display-mode flipped to standalone OR the
 * Android `appinstalled` event fired). Persist so we never prompt again.
 */
export async function markInstalled(): Promise<void> {
  await patchState({ installed_at: Date.now() });
}

/**
 * True if the PWA is currently running as an installed app. Checks both
 * the standard `display-mode: standalone` media query and the legacy iOS
 * `navigator.standalone` boolean (Safari < 17 doesn't expose
 * display-mode for PWAs).
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone;
  return legacy === true;
}

/**
 * True if this looks like a touch device — used to skip the prompt on
 * desktop browsers where PWA install is either unsupported (Safari) or
 * better handled by the browser's own install affordance (Chrome's URL
 * bar icon). The pointer-coarse query is the most reliable cross-browser
 * touch check; `'ontouchstart' in window` is gameable by emulators.
 */
function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches === true;
}

/**
 * Gating decision for `<InstallPrompt />`.
 *
 *   Show if:
 *     - we're not already standalone
 *     - we're on iOS or Android (the only platforms we have a UX for)
 *     - we're on a touch device (skip desktop browsers — see above)
 *     - the user has paired at least once (`paired_at` exists on auth row)
 *     - AND either
 *         - we've never shown it, OR
 *         - the user last dismissed it more than 7 days ago, OR
 *         - the user paired *after* their last dismissal (re-pair = reset)
 *
 * `pairedAt` is passed in by the caller (`InstallPrompt`) so the gating
 * logic stays pure / testable and so we don't reach into auth.ts from here
 * (avoiding a circular IndexedDB-open race between the two modules).
 */
export async function shouldShowPrompt(pairedAt: number | null): Promise<boolean> {
  if (isStandalone()) return false;
  if (!isTouchDevice()) return false;

  const platform = detectPlatform();
  if (platform !== 'ios' && platform !== 'android') return false;

  if (pairedAt == null) return false;

  const state = await getInstallState();
  if (state.installed_at != null) return false;

  // Never shown before → show.
  if (state.last_shown_at == null && state.dismissed_at == null) return true;

  const now = Date.now();
  // Re-pair after a previous dismissal resets the snooze.
  if (state.dismissed_at != null && pairedAt > state.dismissed_at) return true;
  // Snooze expired.
  if (state.dismissed_at != null && now - state.dismissed_at > DISMISS_SNOOZE_MS) {
    return true;
  }
  // User saw the prompt before but never dismissed it → re-show on first
  // load after a fresh pair (i.e. pair happened after the last show).
  if (state.dismissed_at == null && state.last_shown_at != null && pairedAt > state.last_shown_at) {
    return true;
  }
  return false;
}
