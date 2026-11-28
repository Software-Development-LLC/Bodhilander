/** Crew's Sign in again: the account's login flow, answered once it ends. */
import type { CrewEditResult } from '../../shared/types';

export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export interface CrewSignInDeps {
  handle(channel: string, fn: (...args: unknown[]) => unknown): void;
  resumeLogin(accountId: string): { ptyId: string };
  loginSettled(ptyId: string): Promise<boolean>;
  cancelLogin(ptyId: string): void;
  recordSignIn(accountId: string): void;
  setLoginCompletedHook(fn: ((accountId: string) => void) | null): void;
  timeoutMs?: number;
}

/** Only a login Crew started counts as a Crew sign-in; any other login of the account leaves Crew's state alone. */
export function registerCrewSignIn(deps: CrewSignInDeps): void {
  const fromCrew = new Map<string, number>();
  deps.setLoginCompletedHook((accountId) => {
    if (fromCrew.has(accountId)) deps.recordSignIn(accountId);
  });
  deps.handle('crew:signInAgain', async (accountId: unknown): Promise<CrewEditResult> => {
    const id = typeof accountId === 'string' ? accountId.trim() : '';
    if (!id) return { ok: false, error: 'Account id is required.' };
    fromCrew.set(id, (fromCrew.get(id) ?? 0) + 1);
    try {
      return await signInFor(id);
    } finally {
      const left = (fromCrew.get(id) ?? 1) - 1;
      if (left > 0) fromCrew.set(id, left);
      else fromCrew.delete(id);
    }
  });

  async function signInFor(id: string): Promise<CrewEditResult> {
    let ptyId: string;
    try {
      ptyId = deps.resumeLogin(id).ptyId;
    } catch {
      return { ok: false, error: "The sign-in couldn't start." };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
    });
    const outcome = await Promise.race([deps.loginSettled(ptyId), timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      deps.cancelLogin(ptyId);
      return { ok: false, error: 'Sign-in timed out.' };
    }
    return outcome ? { ok: true } : { ok: false, error: 'Sign-in was cancelled.' };
  }
}
