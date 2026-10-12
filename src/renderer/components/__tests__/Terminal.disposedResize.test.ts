/**
 * A resize deferred while rendering is paused runs on a later tick;
 * `dispose()` never cancels it. Unmocked xterm — the bug is internal to
 * its own dispose/idle-task interaction.
 */
import { test, expect } from 'bun:test';
import { Terminal } from '@xterm/xterm';

test('a paused resize queued before dispose does not throw once it runs', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const term = new Terminal({ cols: 80, rows: 24 });
  term.open(host);

  try {
    // _isPaused is normally driven by an IntersectionObserver (the terminal
    // scrolled out of view); setting it directly reaches the same branch
    // without depending on happy-dom's observer behaviour.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderService = (term as any)._core._renderService;
    expect(renderService._renderer.value).toBeDefined();
    renderService._isPaused = true;
    renderService.handleResize(100, 30);

    // Proves the paused-resize branch actually queued a task — without this,
    // a rename of `_isPaused` would make handleResize take the normal path,
    // queue nothing, and let the test pass having exercised no risk at all.
    expect(renderService._pausedResizeTask._queue._tasks.length).toBe(1);

    let uncaught: unknown = null;
    const onError = (e: ErrorEvent) => { uncaught = e.error ?? e.message; };
    window.addEventListener('error', onError);

    term.dispose();

    // The deferred resize task runs on a later tick (idle callback / timeout
    // fallback), after dispose has already torn the renderer down.
    await new Promise((resolve) => setTimeout(resolve, 100));
    window.removeEventListener('error', onError);

    expect(uncaught).toBeNull();
  } finally {
    document.body.removeChild(host);
  }
});
