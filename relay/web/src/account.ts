/**
 * Per-account local state, and the rules for clearing it at sign-out.
 *
 * This lives apart from main.ts so it can be tested: main.ts pulls in xterm and
 * runs boot() at import time, so nothing in it is reachable from a unit test.
 * The sequencing below is the kind of thing that is silently wrong if you get
 * it backwards, which is exactly what wants a test rather than a comment.
 */

/** Which machine this browser last looked at. Belongs to the ACCOUNT: leaving
 *  it behind greets the next person to sign in with the last one's context. */
export const MACHINE_PREF_KEY = 'bodhi.machineId';

/** A share link caught mid-redemption, held across an OAuth round trip. */
export const INVITE_STASH = 'bodhi.invite';

export interface AccountStores {
  local: Pick<Storage, 'removeItem'>;
  session: Pick<Storage, 'removeItem' | 'setItem'>;
}

/**
 * Wipe the signed-out account's traces.
 *
 * `keepInvite` is the one exception, and the order matters: the invite is
 * written back AFTER the wipe, never protected from it. Someone switching
 * accounts to accept a link that refused them is the only case where a pending
 * invite must outlive the session it was refused by — and stashing it first
 * would simply be erased a line later, sending them to an empty home page with
 * no sign of the link they were trying to open.
 */
export function clearAccountState(stores: AccountStores, keepInvite?: string): void {
  stores.local.removeItem(MACHINE_PREF_KEY);
  stores.session.removeItem(INVITE_STASH);
  if (keepInvite) stores.session.setItem(INVITE_STASH, keepInvite);
}
