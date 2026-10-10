// Kept free of any `electron` import so it is unit-testable under `bun test`.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedBounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
}

export interface RestoredBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export interface BoundsResolution {
  bounds: RestoredBounds;
  /** Why the saved bounds were not used as-is; null when they were. */
  adjustment: string | null;
}

export const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 };

// The strip a user grabs to move the window. If none of it is on a display,
// the window cannot be reached even when part of its body is visible.
const TITLE_BAR_HEIGHT = 32;
const MIN_VISIBLE_TITLE_BAR_WIDTH = 100;
const MIN_VISIBLE_TITLE_BAR_HEIGHT = 16;

function isPositiveSize(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isCoordinate(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function overlap(aStart: number, aLength: number, bStart: number, bLength: number): number {
  return Math.max(0, Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart));
}

function isTitleBarReachable(x: number, y: number, width: number, displays: Rect[]): boolean {
  const minWidth = Math.min(MIN_VISIBLE_TITLE_BAR_WIDTH, width);
  return displays.some(area =>
    overlap(x, width, area.x, area.width) >= minWidth &&
    overlap(y, TITLE_BAR_HEIGHT, area.y, area.height) >= MIN_VISIBLE_TITLE_BAR_HEIGHT,
  );
}

function clampSize(width: number, height: number, area: Rect): { width: number; height: number } {
  return { width: Math.min(width, area.width), height: Math.min(height, area.height) };
}

/**
 * Keeps saved bounds whose title bar some connected display can reach, exactly
 * as saved. Otherwise the window is centred on the primary display and its size
 * clamped to fit there.
 */
export function resolveWindowBounds(
  saved: SavedBounds | null | undefined,
  displays: Rect[],
  primary: Rect,
): BoundsResolution {
  const width = isPositiveSize(saved?.width) ? saved.width : DEFAULT_WINDOW_SIZE.width;
  const height = isPositiveSize(saved?.height) ? saved.height : DEFAULT_WINDOW_SIZE.height;
  const x = saved?.x;
  const y = saved?.y;

  if (!isCoordinate(x) || !isCoordinate(y)) {
    const size = clampSize(width, height, primary);
    const clamped = size.width !== width || size.height !== height;
    return {
      bounds: size,
      adjustment: clamped ? `size ${width}x${height} clamped to ${size.width}x${size.height}` : null,
    };
  }

  if (isTitleBarReachable(x, y, width, displays)) {
    return { bounds: { x, y, width, height }, adjustment: null };
  }

  const size = clampSize(width, height, primary);
  const centred = {
    x: primary.x + Math.round((primary.width - size.width) / 2),
    y: primary.y + Math.round((primary.height - size.height) / 2),
    ...size,
  };
  return {
    bounds: centred,
    adjustment:
      `saved position (${x}, ${y}) is not on any connected display; ` +
      `centred on the primary display at (${centred.x}, ${centred.y}) ${size.width}x${size.height}`,
  };
}

export interface WindowBoundsStore {
  getWindowBounds(): SavedBounds | null;
  setWindowBounds(bounds: { x: number; y: number; width: number; height: number; isMaximized?: boolean }): void;
}

export interface WindowLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface MainWindowPlacement {
  bounds: RestoredBounds;
  maximize: boolean;
}

/** Reads the saved bounds, resolves them, and writes back any adjustment so it is made once. */
export function restoreMainWindowBounds(
  store: WindowBoundsStore,
  displays: Rect[],
  primary: Rect,
  log: WindowLogger,
): MainWindowPlacement {
  const saved = store.getWindowBounds();
  const { bounds, adjustment } = resolveWindowBounds(saved, displays, primary);
  if (adjustment) {
    log.info(`[Window] Saved bounds adjusted: ${adjustment}`);
    if (bounds.x !== undefined && bounds.y !== undefined) {
      try {
        store.setWindowBounds({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized: saved?.isMaximized ?? false,
        });
      } catch (error) {
        log.warn(`[Window] Could not save adjusted bounds: ${String(error)}`);
      }
    }
  }
  return { bounds, maximize: saved?.isMaximized === true };
}

export interface ShowableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  once(event: 'ready-to-show' | 'show' | 'closed', listener: () => void): unknown;
}

export const READY_TO_SHOW_FALLBACK_MS = 5000;

/**
 * Show the window on 'ready-to-show', or after `timeoutMs` if that event never
 * arrives. `onFallback` runs only when the timeout is what showed it.
 */
export function showWhenReady(
  win: ShowableWindow,
  onFallback: (timeoutMs: number) => void,
  timeoutMs: number = READY_TO_SHOW_FALLBACK_MS,
): void {
  // Once the window has been shown by anything, neither path may show it again.
  let settled = false;
  const timer = setTimeout(() => {
    if (settled || win.isDestroyed() || win.isVisible()) return;
    settled = true;
    onFallback(timeoutMs);
    win.show();
  }, timeoutMs);
  const settle = () => {
    settled = true;
    clearTimeout(timer);
  };

  win.once('show', settle);
  win.once('closed', settle);
  win.once('ready-to-show', () => {
    if (settled || win.isDestroyed()) return;
    settle();
    win.show();
  });
}

export interface LoadableWindow extends ShowableWindow {
  webContents: {
    on(
      event: 'did-fail-load',
      listener: (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => void,
    ): unknown;
  };
}

/** Wires everything that reports on, or recovers from, the main window failing to appear. */
export function watchMainWindowLoad(
  win: LoadableWindow,
  log: WindowLogger,
  timeoutMs: number = READY_TO_SHOW_FALLBACK_MS,
): void {
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    const message = `[Window] Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`;
    // -3 is ERR_ABORTED: one navigation replaced another, not a failure to load.
    if (isMainFrame && errorCode !== -3) log.error(message);
    else log.warn(message);
  });
  showWhenReady(win, ms => {
    log.warn(`[Window] 'ready-to-show' did not fire within ${ms}ms; showing the window anyway`);
  }, timeoutMs);
}
