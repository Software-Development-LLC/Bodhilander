/**
 * Sessions restored from another machine whose working directory is not here.
 * `PtyManager.createSession` throws on a missing cwd, which surfaces as a
 * spawn failure, so such a session is held back at the launch boundary.
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
