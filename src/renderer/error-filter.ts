/**
 * Recognising the one uncaught renderer error we know to be benign teardown
 * noise (BDHLNDR-43 follow-up).
 *
 * xterm 5.3.0 schedules deferred work on its own internal IdleTaskQueue
 * (requestIdleCallback, or setTimeout(_, 0) as a fallback). When a Terminal is
 * disposed, a task queued a moment earlier can still run on the NEXT tick and
 * dereference the render service that dispose() just tore down, throwing
 * `Cannot read properties of undefined (reading 'handleResize')` from
 * `IdleTaskQueue._process`.
 *
 * Because it fires from a timer rather than from our call stack, it is:
 *   - NOT catchable at the call site — Terminal.tsx already try/catches every
 *     fit()/dispose() it makes, and this still escapes;
 *   - NOT caught by React's ErrorBoundary — that only sees errors thrown during
 *     render/commit, not from a later timer callback.
 *
 * It is harmless: the terminal it belonged to is already gone, and observed
 * sessions keep working straight through it. But it lands on window.onerror as
 * an uncaught error, so in the field it spams the log (seen dozens of times per
 * session across multiple macOS users) and reads like a crash. This predicate
 * lets index.tsx swallow exactly that error and nothing else.
 *
 * The real fix is upgrading to the maintained `@xterm/xterm` (>= 5.5), whose
 * dispose path cancels pending queue work; this guard is the safety net until
 * that migration lands.
 */
export function isBenignXtermTeardownError(message: unknown, stack?: string): boolean {
  const text = typeof message === 'string' ? message : '';
  // "reading 'handleResize'" is a property READ on an undefined object. Our own
  // code only ever CALLS handleResize() as a closure — it never reads
  // `something.handleResize` — so this exact shape belongs to xterm's internal
  // render service and cannot match app code we would want to crash on.
  const readsHandleResize = /Cannot read propert(?:y|ies) of undefined \(reading 'handleResize'\)/.test(text);
  // Belt-and-suspenders: any handleResize failure originating from xterm's
  // IdleTaskQueue is the same teardown race, whatever the exact phrasing.
  const fromXtermIdleQueue = /handleResize/.test(text) && /IdleTaskQueue/.test(stack ?? '');
  return readsHandleResize || fromXtermIdleQueue;
}
