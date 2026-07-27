/**
 * Reconnect scheduler for the relay connection. Kept DOM-free so the timer logic
 * (schedule-at-most-one, bail-if-torn-down, cancel) is unit-testable without a
 * browser harness.
 *
 * Behavior:
 *  - schedule(delay) is a no-op if a reconnect is already pending (at most one
 *    in flight), so repeated offline/closed events don't stack timers.
 *  - when the timer fires it checks `isAlive()` first: if the app deliberately
 *    tore the connection down (nulled its connection), it must NOT resurrect it.
 *  - cancel() clears any pending timer (used on `ready` and on a hard `error`).
 */
export interface ReconnectScheduler {
  schedule(delayMs: number): void;
  cancel(): void;
  readonly pending: boolean;
}

export function createReconnectScheduler(opts: {
  isAlive: () => boolean;
  reconnect: () => void;
}): ReconnectScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(delayMs: number) {
      if (timer) return; // one attempt already in flight
      timer = setTimeout(() => {
        timer = null;
        if (!opts.isAlive()) return; // deliberate teardown — don't resurrect
        opts.reconnect();
      }, delayMs);
    },
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
    get pending() { return timer != null; },
  };
}
