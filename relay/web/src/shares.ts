/**
 * Data and copy for the sharing sheets. Apart from main.ts so it can be
 * tested: main.ts pulls in xterm and runs boot() at import time, so nothing
 * in it is reachable from a unit test.
 */

/** An invite as `GET /api/machines/:id/shares` returns it (the fields read here). */
export interface WireShareInvite {
  id: string;
  expectedGithubLogin: string | null;
  role: string;
  status: string;
  expiresAt: number;
}

/** A grant from the same listing. `expiresAt` is null until the machine countersigns. */
export interface WireShareGrant {
  id: string;
  role: string;
  status: string;
  granteeName: string | null;
  granteeLogin: string | null;
  expiresAt: number | null;
}

/** The guest's own holdings, from `GET /api/shares`. */
export interface WireMyShare extends WireShareGrant {
  machineName: string | null;
  ownerName: string | null;
}

/** One row of a sharing sheet, ready to render. */
export interface ShareRow {
  kind: 'grant' | 'invite';
  id: string;
  person: string;
  roleWord: string;
  pending: boolean;
  detail: string;
  action: string;
}

/**
 * The only vocabulary for what shared access allows. Server role names never
 * reach the UI, and an unknown role reads as the smaller capability rather
 * than promising typing it may not include.
 */
export function roleWord(role: string): string {
  return role === 'operator' ? 'Watching and typing' : 'Watching';
}

// Timed certificates are capped at a day; "until revoked" is bound with the
// largest timestamp Date can represent. An expiry even a year out can only be
// that sentinel, so the horizon reads it without hard-coding the exact value.
const UNTIL_REVOKED_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

const expired = (g: WireShareGrant, now: number) => g.expiresAt !== null && g.expiresAt <= now;
const untilRevoked = (g: WireShareGrant, now: number) =>
  g.expiresAt === null || g.expiresAt - now >= UNTIL_REVOKED_HORIZON_MS;
const personOf = (g: WireShareGrant) => (g.granteeLogin ? `@${g.granteeLogin}` : (g.granteeName ?? 'Someone'));

/** "under a minute", "5 minutes", "3 hours", "2 days" — for expiry copy. */
export function timeLeft(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * The owner's rows: who has access now, who is waiting to be let in, and
 * which invite links are still out. Expired entries are dropped — they no
 * longer let anyone in, and the reaper sweeps them.
 */
export function ownerShareRows(invites: WireShareInvite[], grants: WireShareGrant[], now: number): ShareRow[] {
  const active = grants
    .filter((g) => g.status === 'active' && !expired(g, now))
    .map(
      (g): ShareRow => ({
        kind: 'grant',
        id: g.id,
        person: personOf(g),
        roleWord: roleWord(g.role),
        pending: false,
        detail: untilRevoked(g, now) ? 'Until you revoke it' : `Ends in ${timeLeft(g.expiresAt! - now)}`,
        action: 'Revoke',
      }),
    );
  const waiting = grants
    .filter((g) => g.status === 'pending')
    .map(
      (g): ShareRow => ({
        kind: 'grant',
        id: g.id,
        person: personOf(g),
        roleWord: roleWord(g.role),
        pending: true,
        detail: 'Waiting for your approval in the desktop app',
        action: 'Refuse',
      }),
    );
  const links = invites
    .filter((i) => i.status === 'pending' && i.expiresAt > now)
    .map(
      (i): ShareRow => ({
        kind: 'invite',
        id: i.id,
        person: i.expectedGithubLogin ? `@${i.expectedGithubLogin}` : 'Anyone with the link',
        roleWord: roleWord(i.role),
        pending: true,
        detail: `Invite link not used yet — it expires in ${timeLeft(i.expiresAt - now)}`,
        action: 'Cancel',
      }),
    );
  return [...active, ...waiting, ...links];
}

/** The guest's mirror: each share they hold, labelled by person, with a way out. */
export function guestShareRows(shares: WireMyShare[], now: number): ShareRow[] {
  return shares
    .filter((g) => !(g.status === 'active' && expired(g, now)))
    .map(
      (g): ShareRow => ({
        kind: 'grant',
        id: g.id,
        person:
          g.ownerName && g.machineName
            ? `${g.ownerName}'s ${g.machineName}`
            : (g.machineName ?? g.ownerName ?? 'A shared session'),
        roleWord: roleWord(g.role),
        pending: g.status === 'pending',
        detail:
          g.status === 'pending'
            ? "Waiting to be let in — they'll get a prompt on their machine"
            : untilRevoked(g, now)
              ? 'Until you leave, or they stop sharing'
              : `Ends in ${timeLeft(g.expiresAt! - now)}`,
        action: 'Leave',
      }),
    );
}

/** The question a revoke action asks, honest about what saying yes does. */
export function confirmCopy(row: ShareRow): string {
  if (row.action === 'Leave') return `Leave ${row.person}? You'll need a new link to come back.`;
  if (row.kind === 'invite') return 'Cancel this invite? The link will stop working.';
  if (row.pending) return `Refuse ${row.person}? They won't be let in.`;
  return `Revoke access for ${row.person}? If they're connected, they'll be cut off.`;
}

/**
 * What a 204 actually did, without overclaiming: the relay bars the door
 * immediately, but an offline machine only applies the change to its own
 * records when it next connects.
 */
export function revokeDoneCopy(row: ShareRow, machineOffline: boolean): string {
  if (row.action === 'Leave') return "You've left. Ask for a new link if you need access again.";
  if (row.kind === 'invite') return "Cancelled. That link doesn't work any more.";
  if (row.pending) return "Refused. They haven't been let in.";
  return machineOffline
    ? "Access ended. They can't get back in — this machine is offline, so it finishes applying the change when it reconnects."
    : "Access ended. If they were connected, they've been disconnected.";
}

/** `status` is the HTTP status, or null when the request never got through. */
export function revokeFailedCopy(status: number | null): string {
  if (status === 404) return 'That share was already gone.';
  if (status === null) return "Couldn't reach the server. Check your connection and try again.";
  return "The server couldn't do that just now. Try again.";
}
