import type { CrewSignInStarted } from '../../shared/types';

export const SIGN_IN_STARTED_CHANNEL = 'crew:signInStarted';

/** Wraps the login start so the renderer is told which pty to show while Sign in again waits on it. */
export function announceSignInStart(
  resumeLogin: (accountId: string) => { ptyId: string },
  send: (channel: string, data: CrewSignInStarted) => void,
): (accountId: string) => { ptyId: string } {
  return (accountId) => {
    const started = resumeLogin(accountId);
    send(SIGN_IN_STARTED_CHANNEL, { accountId, ptyId: started.ptyId });
    return started;
  };
}
