/**
 * What the app says to a guest, in the guest's voice: a guest was invited by a
 * person, so the copy names that person. Owner vocabulary describes a
 * relationship they do not have. Apart from main.ts so it can be tested.
 */

import { roleWord } from './shares';

/** "Will's" when the name is known, "their" when it is not. Never a blank. */
export function ownerPossessive(ownerName?: string | null): string {
  return ownerName ? `${ownerName}'s` : 'their';
}

/** The same, starting a sentence: `display_name` is nullable in the relay. */
function openingPossessive(ownerName?: string | null): string {
  const word = ownerPossessive(ownerName);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The offline state. The guest version promises the retry that actually
 * happens — the client keeps re-opening the channel until the agent appears —
 * rather than telling someone to wait for a machine they cannot see.
 */
export function offlineCopy(guest: boolean, ownerName?: string | null): string {
  if (!guest) return "This machine is offline. It'll appear here when it reconnects.";
  return `${openingPossessive(ownerName)} machine is offline right now. We'll ask again as soon as it's back.`;
}

/**
 * A connection problem. `detail` is the specific reason when there is one
 * (identity verification, an unsupported agent) and is preferred over any
 * voice, because a specific true sentence beats a friendly vague one.
 */
export function connectionProblemCopy(guest: boolean, ownerName: string | null | undefined, detail?: string): string {
  if (detail) return detail;
  return guest ? `Can't reach ${ownerPossessive(ownerName)} machine right now.` : 'Connection problem.';
}

export interface WaitingCopy {
  title: string;
  body: string;
}

/**
 * Waiting on the owner to answer. The most-travelled path in the feature and
 * the guest's whole first impression, so it says what is happening, that it is
 * normal, and what to do.
 */
export function waitingCopy(ownerName?: string | null): WaitingCopy {
  return {
    title: ownerName ? `Waiting for ${ownerName} to let you in…` : 'Waiting to be let in…',
    body: ownerName
      ? `${ownerName} will get a prompt on their machine. Keep this page open — it'll update on its own.`
      : "They'll get a prompt on their machine. Keep this page open — it'll update on its own.",
  };
}

/**
 * The terminal subtitle: who shared this, and what you can do with it. The
 * role reaches the reader as one of the two words and nothing else — `viewer`
 * and `operator` are our vocabulary, not theirs.
 */
export function guestSubtitle(ownerName: string | null | undefined, role: string | null | undefined): string {
  const who = ownerName ? `Shared by ${ownerName}` : 'Shared with you';
  return `${who} · ${roleWord(role ?? '').toLowerCase()}`;
}

/**
 * Why the view is wider than the screen. Without it the horizontal cut-off
 * reads as a rendering bug rather than as somebody else's terminal.
 */
export function wideBannerCopy(ownerName: string | null | undefined, cols: number): string {
  return `Sized for ${ownerPossessive(ownerName)} screen (${cols} columns). Drag sideways to read.`;
}

/** The action that asks the owner to resize once. */
export const FIT_ACTION = 'Fit to my screen';

/**
 * After the ask. It promises nothing: the request surfaces as a prompt the
 * owner may decline, and a declined request changes nothing here — so this
 * says exactly that instead of implying a resize is on its way.
 */
export function fitAskedCopy(ownerName?: string | null): string {
  const who = ownerName ?? 'them';
  return `Asked ${who} to resize. Nothing changes unless they say yes — you can keep reading meanwhile.`;
}
