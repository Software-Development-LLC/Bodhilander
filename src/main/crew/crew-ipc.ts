/** Crew's main-side IPC; the preload and renderer declarations live with the UI. */
export interface CrewIpcDeps<R> {
  handle(channel: string, fn: (...args: unknown[]) => unknown): void;
  resumeLogin(accountId: string): R;
  recordSignIn(accountId: string): void;
  setLoginCompletedHook(fn: ((accountId: string) => void) | null): void;
}

export function registerCrewIpc<R>(deps: CrewIpcDeps<R>): void {
  deps.setLoginCompletedHook((accountId) => deps.recordSignIn(accountId));
  deps.handle('crew:signInAgain', (accountId: unknown) => {
    const id = typeof accountId === 'string' ? accountId.trim() : '';
    if (!id) throw new Error('Account id is required');
    return deps.resumeLogin(id);
  });
}
