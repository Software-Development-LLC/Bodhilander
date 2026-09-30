import log from 'electron-log';
import { routeNewSession } from './account-failover';

type RoutedListener = (sessionId: string) => void;

let routedListener: RoutedListener | null = null;

/** Told about each new session a usage move re-homed, so the window can refresh. */
export function setSessionRoutedListener(listener: RoutedListener | null): void {
  routedListener = listener;
}

/**
 * Move a just-created session off a near-limit account. Every creation path
 * calls this before the pty spawns, because the account is fixed at spawn.
 */
export function routeNewSessionByUsage(sessionId: string): void {
  try {
    const moved = routeNewSession(sessionId);
    if (!moved) return;
    log.info(`[Usage] New session started on ${moved.to.label}; ${moved.from.label} is near its usage limit`);
    routedListener?.(sessionId);
  } catch (err) {
    log.warn('[Usage] Could not route a new session by usage:', err);
  }
}
