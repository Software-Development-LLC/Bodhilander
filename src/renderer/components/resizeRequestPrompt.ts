/**
 * The owner's side of "Fit to my screen": whether a guest's request is worth
 * asking about, and what the question says.
 *
 * Pure, and apart from Terminal.tsx, so the decision can be tested without a
 * canvas, a laid-out container or an xterm.
 */

import { RelayResizeRequest } from '../../shared/types';

export const RESIZE_ONCE = 'Resize once';
export const KEEP_MY_SIZE = 'Keep my size';

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * Whether to raise the prompt at all.
 *
 * A request for another session belongs to another terminal, and one that
 * already matches this size asks for nothing — interrupting the owner to
 * offer them a no-op spends their attention for nothing.
 */
export function shouldPrompt(
  request: RelayResizeRequest,
  sessionId: string,
  current: TerminalSize | null,
): boolean {
  if (request.sessionId !== sessionId) return false;
  if (request.cols < 1 || request.rows < 1) return false;
  return !current || current.cols !== request.cols || current.rows !== request.rows;
}

/**
 * Who is asking. The GitHub login is the immutable identity, so it is
 * preferred over a display name the account holder can change to anything.
 */
export function whoIsAsking(request: RelayResizeRequest): string {
  if (request.login) return `@${request.login}`;
  return request.displayName ?? 'Someone watching';
}

/**
 * The question. It names the size being asked for and the one it replaces,
 * because "resize this terminal" without numbers asks the owner to agree to
 * something they cannot see the shape of.
 */
export function resizeRequestCopy(request: RelayResizeRequest, current: TerminalSize | null): string {
  const asked = `${request.cols}×${request.rows}`;
  const mine = current ? ` — yours is ${current.cols}×${current.rows}` : '';
  return `${whoIsAsking(request)} asked to fit this session to their screen (${asked})${mine}.`;
}
