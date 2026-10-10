import { describe, test, expect } from 'bun:test';
import { resolveWindowBounds, showWhenReady, DEFAULT_WINDOW_SIZE, Rect, ShowableWindow } from '../window-bounds';

const PRIMARY: Rect = { x: 0, y: 25, width: 1440, height: 875 };
const LEFT_EXTERNAL: Rect = { x: -1920, y: -200, width: 1920, height: 1080 };

describe('resolveWindowBounds', () => {
  test('keeps bounds that sit on a connected display', () => {
    const saved = { x: 100, y: 100, width: 1200, height: 700 };
    expect(resolveWindowBounds(saved, [PRIMARY], PRIMARY)).toEqual({ bounds: saved, adjustment: null });
  });

  test('drops the position of bounds saved on a display that is no longer connected', () => {
    const saved = { x: 2000, y: 300, width: 1200, height: 700 };
    const result = resolveWindowBounds(saved, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual({ width: 1200, height: 700 });
    expect(result.adjustment).toContain('not on any connected display');
  });

  test('keeps a partially visible window whose title bar is reachable', () => {
    const saved = { x: 1000, y: 400, width: 1200, height: 700 };
    expect(resolveWindowBounds(saved, [PRIMARY], PRIMARY)).toEqual({ bounds: saved, adjustment: null });
  });

  test('drops the position when the body is visible but the title bar is above every display', () => {
    const saved = { x: 100, y: -300, width: 1200, height: 700 };
    const result = resolveWindowBounds(saved, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual({ width: 1200, height: 700 });
    expect(result.adjustment).not.toBeNull();
  });

  test('drops the position when only a sliver of the title bar is on screen', () => {
    const saved = { x: 1400, y: 100, width: 1200, height: 700 };
    const result = resolveWindowBounds(saved, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual({ width: 1200, height: 700 });
  });

  test('clamps an oversized window to the display it opens on and pulls it inside', () => {
    const saved = { x: 200, y: 100, width: 2560, height: 1440 };
    const result = resolveWindowBounds(saved, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
    expect(result.adjustment).toContain('clamped');
  });

  test('clamps an oversized window that has no saved position to the primary display', () => {
    const result = resolveWindowBounds({ width: 3000, height: 2000 }, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual({ width: 1440, height: 875 });
    expect(result.adjustment).toContain('clamped');
  });

  test('clamps to the primary display when an off-screen window is re-centered', () => {
    const saved = { x: -1800, y: 0, width: 1900, height: 1000 };
    const result = resolveWindowBounds(saved, [PRIMARY], PRIMARY);
    expect(result.bounds).toEqual({ width: 1440, height: 875 });
  });

  test('keeps a window on a monitor at negative coordinates while it is connected', () => {
    const saved = { x: -1800, y: -100, width: 1200, height: 800 };
    expect(resolveWindowBounds(saved, [PRIMARY, LEFT_EXTERNAL], PRIMARY)).toEqual({
      bounds: saved,
      adjustment: null,
    });
  });

  test('measures size against the display the window is on, not the primary', () => {
    const saved = { x: -1800, y: -100, width: 1900, height: 1000 };
    const result = resolveWindowBounds(saved, [PRIMARY, LEFT_EXTERNAL], PRIMARY);
    expect(result.bounds).toEqual({ x: -1800, y: -100, width: 1900, height: 1000 });
    expect(result.adjustment).toBeNull();
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
});

class FakeWindow implements ShowableWindow {
  destroyed = false;
  visible = false;
  shows = 0;
  private listeners = new Map<string, () => void>();

  isDestroyed(): boolean { return this.destroyed; }
  isVisible(): boolean { return this.visible; }
  show(): void { this.shows++; this.visible = true; }
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
    showWhenReady(win, ms => fallbacks.push(ms), 20);
    win.emit('ready-to-show');
    win.visible = false;
    await wait(50);
    expect(win.shows).toBe(1);
    expect(fallbacks).toEqual([]);
  });

  test('shows the window and reports it when ready-to-show never fires', async () => {
    const win = new FakeWindow();
    const fallbacks: number[] = [];
    showWhenReady(win, ms => fallbacks.push(ms), 20);
    await wait(50);
    expect(win.shows).toBe(1);
    expect(fallbacks).toEqual([20]);
  });

  test('does not show a window that was destroyed before the timeout', async () => {
    const win = new FakeWindow();
    const fallbacks: number[] = [];
    showWhenReady(win, ms => fallbacks.push(ms), 20);
    win.destroyed = true;
    await wait(50);
    expect(win.shows).toBe(0);
    expect(fallbacks).toEqual([]);
  });

  test('does not show a window that was closed before the timeout', async () => {
    const win = new FakeWindow();
    const fallbacks: number[] = [];
    showWhenReady(win, ms => fallbacks.push(ms), 20);
    win.emit('closed');
    await wait(50);
    expect(win.shows).toBe(0);
    expect(fallbacks).toEqual([]);
  });

  test('does not show again when something else already showed the window', async () => {
    const win = new FakeWindow();
    const fallbacks: number[] = [];
    showWhenReady(win, ms => fallbacks.push(ms), 20);
    win.show();
    await wait(50);
    expect(win.shows).toBe(1);
    expect(fallbacks).toEqual([]);
  });
});
