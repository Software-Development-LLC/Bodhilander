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

/** A command to send, in the order it must be sent. Shaped as a wire frame. */
export interface ReadyCommand {
  type: string;
  sessionId?: string;
  [key: string]: unknown;
}

/**
 * What to send when a channel reports ready. A reconnect is a NEW socket
 * whose client session has no subscriptions, so an open terminal receives
 * nothing until it asks again — and a landed guest has no row left to tap.
 */
export function readyCommands(activeSessionId: string | null): ReadyCommand[] {
  const commands: ReadyCommand[] = [{ type: 'groups:list' }, { type: 'sessions:list' }];
  if (activeSessionId) commands.push({ type: 'terminal:subscribe', sessionId: activeSessionId });
  return commands;
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
