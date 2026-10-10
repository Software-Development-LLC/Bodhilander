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

function visibleTitleBar(x: number, y: number, width: number, area: Rect): { width: number; height: number } {
  return {
    width: overlap(x, width, area.x, area.width),
    height: overlap(y, TITLE_BAR_HEIGHT, area.y, area.height),
  };
}

function clampSize(width: number, height: number, area: Rect): { width: number; height: number } {
  return { width: Math.min(width, area.width), height: Math.min(height, area.height) };
}

/**
 * Drops a saved position whose title bar no connected display shows enough of,
 * so Electron centers the window on the primary display, and clamps the size
 * to the display the window opens on.
 */
export function resolveWindowBounds(
  saved: SavedBounds | null | undefined,
  displays: Rect[],
  primary: Rect,
): BoundsResolution {
  const savedWidth = isPositiveSize(saved?.width) ? saved.width : DEFAULT_WINDOW_SIZE.width;
  const savedHeight = isPositiveSize(saved?.height) ? saved.height : DEFAULT_WINDOW_SIZE.height;
  const hasPosition = isCoordinate(saved?.x) && isCoordinate(saved?.y);

  if (!hasPosition) {
    const size = clampSize(savedWidth, savedHeight, primary);
    const clamped = size.width !== savedWidth || size.height !== savedHeight;
    return {
      bounds: size,
      adjustment: clamped ? `size ${savedWidth}x${savedHeight} clamped to ${size.width}x${size.height}` : null,
    };
  }

  const x = saved!.x as number;
  const y = saved!.y as number;
  const minWidth = Math.min(MIN_VISIBLE_TITLE_BAR_WIDTH, savedWidth);
  let target: Rect | null = null;
  let bestVisible = 0;
  for (const area of displays) {
    const visible = visibleTitleBar(x, y, savedWidth, area);
    if (visible.width < minWidth || visible.height < MIN_VISIBLE_TITLE_BAR_HEIGHT) continue;
    if (visible.width * visible.height > bestVisible) {
      bestVisible = visible.width * visible.height;
      target = area;
    }
  }

  if (!target) {
    const size = clampSize(savedWidth, savedHeight, primary);
    return {
      bounds: size,
      adjustment: `saved position (${x}, ${y}) is not on any connected display; centering on the primary display`,
    };
  }

  const size = clampSize(savedWidth, savedHeight, target);
  if (size.width === savedWidth && size.height === savedHeight) {
    return { bounds: { x, y, width: savedWidth, height: savedHeight }, adjustment: null };
  }

  // A clamped window is pulled fully inside the display so its new edges land on-screen.
  const fittedX = Math.min(Math.max(x, target.x), target.x + target.width - size.width);
  const fittedY = Math.min(Math.max(y, target.y), target.y + target.height - size.height);
  return {
    bounds: { x: fittedX, y: fittedY, ...size },
    adjustment: `size ${savedWidth}x${savedHeight} clamped to ${size.width}x${size.height} at (${fittedX}, ${fittedY})`,
  };
}

export interface ShowableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  show(): void;
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown;
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
  // Once either path has run, a later one must not re-show a window the user hid.
  let settled = false;
  const timer = setTimeout(() => {
    settled = true;
    if (win.isDestroyed() || win.isVisible()) return;
    onFallback(timeoutMs);
    win.show();
  }, timeoutMs);

  win.once('ready-to-show', () => {
    clearTimeout(timer);
    if (settled || win.isDestroyed()) return;
    settled = true;
    win.show();
  });
  win.once('closed', () => clearTimeout(timer));
}
