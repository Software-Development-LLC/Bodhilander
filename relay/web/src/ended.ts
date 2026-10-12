/**
 * Why access ended, in the guest's words. Apart from main.ts so the choice
 * of story can be tested: main.ts pulls in xterm and runs boot() at import
 * time, so nothing in it is reachable from a unit test.
 */

export interface EndedCopy {
  icon: string;
  title: string;
  body: string;
}

/**
 * Distinct per reason on purpose: telling someone "Will revoked your access"
 * when Will merely closed a terminal is a false and socially loaded story,
 * and the agent already knows which one it was.
 */
const ENDED_COPY: Record<string, EndedCopy> = {
  revoked: { icon: '🔒', title: 'Your access was ended', body: 'The person who shared this session stopped sharing it.' },
  expired: { icon: '⌛', title: 'Your access expired', body: 'Shared access runs out on a timer. Ask for a new link if you still need it.' },
  session_ended: { icon: '⏹', title: 'That session ended', body: 'The terminal you were watching was closed. Nothing was taken away from you.' },
  machine_unlinked: { icon: '🔌', title: 'That machine was unlinked', body: 'It is no longer reachable through Bodhilander.' },
  not_authorized: { icon: '🚫', title: "You're not in yet", body: 'This machine did not accept the invitation. Ask for a new link.' },
};

/**
 * The story-free ending, for any reason the table does not name. Guessing a
 * cause we do not know puts a false and socially loaded story in front of
 * someone — the exact failure the table above exists to prevent.
 */
const ENDED_FALLBACK: EndedCopy = {
  icon: '🔌',
  title: 'This session ended',
  body: 'The connection to that machine closed. Ask whoever shared it if you still need access.',
};

/**
 * Person-attributed stories come only from keys in the table, which only
 * SEALED frames select — a close-derived ending arrives as CONNECTION_ENDED
 * and lands on the fallback. Never interpolate a name or login into these.
 */
export function endedCopy(reason: string): EndedCopy {
  return ENDED_COPY[reason] ?? ENDED_FALLBACK;
}
