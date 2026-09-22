/**
 * xterm's RenderService defers a resize that arrives while rendering is
 * paused (the terminal is off-screen) onto a DebouncedIdleTask, which runs on
 * a later tick. `dispose()` never cancels that task, so it can still run
 * after the renderer it closed over is gone.
 *
 * Unlike the other Terminal tests, this one imports the real `@xterm/xterm`
 * package instead of mocking it — the bug lives inside the library's own
 * dispose/idle-task interaction, which a FakeTerm cannot reproduce.
 */
import { test, expect } from 'bun:test';
import { Terminal } from '@xterm/xterm';

test('a paused resize queued before dispose does not throw once it runs', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const term = new Terminal({ cols: 80, rows: 24 });
  term.open(host);

  // _isPaused is normally driven by an IntersectionObserver (the terminal
  // scrolled out of view); setting it directly reaches the same branch
  // without depending on happy-dom's observer behaviour.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderService = (term as any)._core._renderService;
  renderService._isPaused = true;
  renderService.handleResize(100, 30);

  let uncaught: unknown = null;
  const onError = (e: ErrorEvent) => { uncaught = e.error ?? e.message; };
  window.addEventListener('error', onError);

  term.dispose();

  // The deferred resize task runs on a later tick (idle callback / timeout
  // fallback), after dispose has already torn the renderer down.
  await new Promise((resolve) => setTimeout(resolve, 100));
  window.removeEventListener('error', onError);

  expect(uncaught).toBeNull();

  document.body.removeChild(host);
});
