import { describe, test, expect } from 'bun:test';
import {
  resolveWindowBounds,
  restoreMainWindowBounds,
  showWhenReady,
  watchMainWindowLoad,
  DEFAULT_WINDOW_SIZE,
} from '../window-bounds';
import type { LoadableWindow, Rect, SavedBounds, WindowBoundsStore } from '../window-bounds';

const PRIMARY: Rect = { x: 0, y: 25, width: 1440, height: 875 };
const LEFT_EXTERNAL: Rect = { x: -1920, y: -200, width: 1920, height: 1080 };

function centredOnPrimary(width: number, height: number) {
  return {
    x: PRIMARY.x + Math.round((PRIMARY.width - width) / 2),
    y: PRIMARY.y + Math.round((PRIMARY.height - height) / 2),
    width,
    height,
  };
}

describe('resolveWindowBounds', () => {
  test('keeps bounds that sit on a connected display', () => {
    const saved = { x: 100, y: 100, width: 1200, height: 700 };
    expect(resolveWindowBounds(saved, [PRIMARY], PRIMARY)).toEqual({ bounds: saved, adjustment: null });
  });

  test('centres bounds saved on a display that is no longer connected on the primary', () => {
    const saved = { x: 2000, y: 300, width: 1200, height: 700 };
    const result = resolveWindowBounds(saved, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual(centredOnPrimary(1200, 700));
    expect(result.adjustment).toContain('not on any connected display');
  });

  test('keeps a partially visible window whose title bar is reachable', () => {
    const saved = { x: 1000, y: 400, width: 1200, height: 700 };
    expect(resolveWindowBounds(saved, [PRIMARY], PRIMARY)).toEqual({ bounds: saved, adjustment: null });
  });

  test('centres a window whose body is visible but whose title bar is above every display', () => {
    const saved = { x: 100, y: -300, width: 1200, height: 700 };
    const result = resolveWindowBounds(saved, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual(centredOnPrimary(1200, 700));
    expect(result.adjustment).not.toBeNull();
  });

  test('centres a window when only a sliver of its title bar is on screen', () => {
    const saved = { x: 1400, y: 100, width: 1200, height: 700 };
    expect(resolveWindowBounds(saved, [PRIMARY], PRIMARY).bounds).toEqual(centredOnPrimary(1200, 700));
  });

  test('keeps a window that extends past the work area, such as under the Dock', () => {
    const saved = { x: 0, y: 25, width: 1440, height: 900 };
    expect(resolveWindowBounds(saved, [PRIMARY], PRIMARY)).toEqual({ bounds: saved, adjustment: null });
  });

  test('keeps a snapped window whose invisible border sits just outside the work area', () => {
    const saved = { x: -7, y: 25, width: 734, height: 882 };
    expect(resolveWindowBounds(saved, [PRIMARY], PRIMARY)).toEqual({ bounds: saved, adjustment: null });
  });

  test('keeps a window spanning two monitors', () => {
    const left: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
    const right: Rect = { x: 1920, y: 0, width: 1920, height: 1040 };
    const saved = { x: 100, y: 0, width: 3600, height: 1000 };
    expect(resolveWindowBounds(saved, [left, right], left)).toEqual({ bounds: saved, adjustment: null });
    expect(resolveWindowBounds(saved, [right, left], left)).toEqual({ bounds: saved, adjustment: null });
  });

  test('clamps an off-screen oversized window to the primary display it is centred on', () => {
    const saved = { x: 5000, y: 100, width: 2560, height: 1440 };
    const result = resolveWindowBounds(saved, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
    expect(result.adjustment).toContain('1440x875');
  });

  test('clamps an oversized window that has no saved position to the primary display', () => {
    const result = resolveWindowBounds({ width: 3000, height: 2000 }, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual({ width: 1440, height: 875 });
    expect(result.adjustment).toContain('clamped');
  });

  test('keeps a window on a monitor at negative coordinates while it is connected', () => {
    const saved = { x: -1800, y: -100, width: 1200, height: 800 };
    expect(resolveWindowBounds(saved, [PRIMARY, LEFT_EXTERNAL], PRIMARY)).toEqual({
      bounds: saved,
      adjustment: null,
    });
  });

  test('centres a window from a negative-coordinate monitor once it is disconnected', () => {
    const saved = { x: -1800, y: -100, width: 1900, height: 1000 };
    const result = resolveWindowBounds(saved, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
  });

  test('uses the default size with no position when nothing was saved', () => {
    expect(resolveWindowBounds(null, [PRIMARY], PRIMARY)).toEqual({
      bounds: { ...DEFAULT_WINDOW_SIZE },
      adjustment: null,
    });
  });

  test('replaces a zero or missing saved size with the default', () => {
    const result = resolveWindowBounds({ x: 100, y: 100, width: 0 }, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual({ x: 100, y: 100, ...DEFAULT_WINDOW_SIZE });
  });

  test('treats a non-finite saved position as no position', () => {
    const result = resolveWindowBounds({ x: Number.NaN, y: 100, width: 800, height: 600 }, [PRIMARY], PRIMARY);
    expect(result).toEqual({ bounds: { width: 800, height: 600 }, adjustment: null });
  });

  test('centres on the primary when no displays are reported', () => {
    const result = resolveWindowBounds({ x: 100, y: 100, width: 800, height: 600 }, [], PRIMARY);
    expect(result.bounds).toEqual(centredOnPrimary(800, 600));
  });
});

class MemoryStore implements WindowBoundsStore {
  writes: SavedBounds[] = [];
  constructor(private saved: SavedBounds | null) {}
  getWindowBounds(): SavedBounds | null { return this.saved; }
  setWindowBounds(bounds: SavedBounds): void { this.writes.push(bounds); this.saved = bounds; }
}

class MemoryLog {
  lines: string[] = [];
  info(message: string): void { this.lines.push(`info ${message}`); }
  warn(message: string): void { this.lines.push(`warn ${message}`); }
  error(message: string): void { this.lines.push(`error ${message}`); }
}

describe('restoreMainWindowBounds', () => {
  test('uses on-screen bounds without logging or writing anything', () => {
    const store = new MemoryStore({ x: 100, y: 100, width: 1200, height: 700, isMaximized: false });
    const log = new MemoryLog();
    expect(restoreMainWindowBounds(store, [PRIMARY], PRIMARY, log)).toEqual({
      bounds: { x: 100, y: 100, width: 1200, height: 700 },
      maximize: false,
    });
    expect(store.writes).toEqual([]);
    expect(log.lines).toEqual([]);
  });

  test('logs and persists an adjustment, keeping the maximized flag', () => {
    const store = new MemoryStore({ x: 4000, y: 100, width: 1200, height: 700, isMaximized: true });
    const log = new MemoryLog();
    const placement = restoreMainWindowBounds(store, [PRIMARY], PRIMARY, log);
    expect(placement).toEqual({ bounds: centredOnPrimary(1200, 700), maximize: true });
    expect(store.writes).toEqual([{ ...centredOnPrimary(1200, 700), isMaximized: true }]);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toStartWith('info [Window] Saved bounds adjusted:');
  });

  test('makes an adjustment once: the next launch finds the persisted bounds on screen', () => {
    const store = new MemoryStore({ x: 4000, y: 100, width: 1200, height: 700 });
    restoreMainWindowBounds(store, [PRIMARY], PRIMARY, new MemoryLog());
    const log = new MemoryLog();
    restoreMainWindowBounds(store, [PRIMARY], PRIMARY, log);
    expect(store.writes).toHaveLength(1);
    expect(log.lines).toEqual([]);
  });

  test('writes nothing when there is no position to persist', () => {
    const store = new MemoryStore({ width: 3000, height: 2000 } as SavedBounds);
    const log = new MemoryLog();
    expect(restoreMainWindowBounds(store, [PRIMARY], PRIMARY, log).bounds).toEqual({ width: 1440, height: 875 });
    expect(store.writes).toEqual([]);
    expect(log.lines).toHaveLength(1);
  });

  test('opens at the default size when nothing was saved', () => {
    const store = new MemoryStore(null);
    expect(restoreMainWindowBounds(store, [PRIMARY], PRIMARY, new MemoryLog())).toEqual({
      bounds: { ...DEFAULT_WINDOW_SIZE },
      maximize: false,
    });
    expect(store.writes).toEqual([]);
  });
});

type FailLoadListener = (event: unknown, errorCode: number, errorDescription: string, validatedURL: string) => void;

class FakeWindow implements LoadableWindow {
  destroyed = false;
  visible = false;
  shows = 0;
  failLoad: FailLoadListener | null = null;
  private listeners = new Map<string, () => void>();
  webContents = {
    on: (_event: 'did-fail-load', listener: FailLoadListener) => { this.failLoad = listener; },
  };

  isDestroyed(): boolean { return this.destroyed; }
  isVisible(): boolean { return this.visible; }
  show(): void {
    this.shows++;
    this.visible = true;
    this.emit('show');
  }
  hide(): void { this.visible = false; }
  once(event: string, listener: () => void): void { this.listeners.set(event, listener); }
  emit(event: string): void {
    const listener = this.listeners.get(event);
    this.listeners.delete(event);
    listener?.();
  }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('showWhenReady', () => {
  test('shows on ready-to-show and never falls back afterwards', async () => {
    const win = new FakeWindow();
    const fallbacks: number[] = [];
    showWhenReady(win, ms => fallbacks.push(ms), 10);
    win.emit('ready-to-show');
    win.hide();
    await wait(200);
    expect(win.shows).toBe(1);
    expect(fallbacks).toEqual([]);
  });

  test('shows the window and reports it when ready-to-show never fires', async () => {
    const win = new FakeWindow();
    const fallbacks: number[] = [];
    showWhenReady(win, ms => fallbacks.push(ms), 10);
    await wait(200);
    expect(win.shows).toBe(1);
    expect(fallbacks).toEqual([10]);
  });

  test('does not show a window that was destroyed before the timeout', async () => {
    const win = new FakeWindow();
    const fallbacks: number[] = [];
    showWhenReady(win, ms => fallbacks.push(ms), 10);
    win.destroyed = true;
    await wait(200);
    expect(win.shows).toBe(0);
    expect(fallbacks).toEqual([]);
  });

  test('does not show a window that was closed before the timeout', async () => {
    const win = new FakeWindow();
    const fallbacks: number[] = [];
    showWhenReady(win, ms => fallbacks.push(ms), 10);
    win.emit('closed');
    await wait(200);
    expect(win.shows).toBe(0);
    expect(fallbacks).toEqual([]);
  });

  test('does not re-show a window hidden after the fallback when ready-to-show arrives late', async () => {
    const win = new FakeWindow();
    showWhenReady(win, () => {}, 10);
    await wait(200);
    win.hide();
    win.emit('ready-to-show');
    expect(win.shows).toBe(1);
  });

  test('does not re-show a window something else showed and the user then hid', async () => {
    const win = new FakeWindow();
    const fallbacks: number[] = [];
    showWhenReady(win, ms => fallbacks.push(ms), 10);
    win.show();
    win.hide();
    await wait(200);
    win.emit('ready-to-show');
    expect(win.shows).toBe(1);
    expect(fallbacks).toEqual([]);
  });
});

describe('watchMainWindowLoad', () => {
  test('logs a failed load with its code, description and url', () => {
    const win = new FakeWindow();
    const log = new MemoryLog();
    watchMainWindowLoad(win, log, 10);
    win.failLoad?.({}, -6, 'ERR_FILE_NOT_FOUND', 'file:///app/renderer/index.html');
    win.emit('closed');
    expect(log.lines).toEqual(['error [Window] Failed to load file:///app/renderer/index.html: -6 ERR_FILE_NOT_FOUND']);
  });

  test('warns when it had to show the window without ready-to-show', async () => {
    const win = new FakeWindow();
    const log = new MemoryLog();
    watchMainWindowLoad(win, log, 10);
    await wait(200);
    expect(win.shows).toBe(1);
    expect(log.lines).toEqual(["warn [Window] 'ready-to-show' did not fire within 10ms; showing the window anyway"]);
  });

  test('shows on ready-to-show without logging', async () => {
    const win = new FakeWindow();
    const log = new MemoryLog();
    watchMainWindowLoad(win, log, 10);
    win.emit('ready-to-show');
    await wait(200);
    expect(win.shows).toBe(1);
    expect(log.lines).toEqual([]);
  });
});
