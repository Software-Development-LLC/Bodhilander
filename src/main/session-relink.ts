/**
 * Sessions restored from another machine whose working directory is not here.
 *
 * `PtyManager.createSession` throws when the cwd is missing, and that throw
 * surfaces as a spawn failure with nothing the user can do about it. A session
 * in this state is held back at the launch boundary and asked about instead.
 */

import { SessionState } from '../shared/types';

export const NEEDS_RELINK_STATE: SessionState = 'needs-relink';

export function needsRelink(state: string | null | undefined): boolean {
  return state === NEEDS_RELINK_STATE;
}

export interface LaunchCandidate {
  name: string;
  state: string;
  workingDir: string;
}

/** Why this session must not be launched, or null when it may be. */
export function launchBlockReason(session: LaunchCandidate | null | undefined): string | null {
  if (!session || !needsRelink(session.state)) return null;
  return `"${session.name}" needs relinking: ${session.workingDir || 'its working directory'} is not on this machine.`;
}
