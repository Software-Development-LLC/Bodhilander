/**
 * The sharing sheets' data and copy. What matters here is honesty: the two
 * role words are the ONLY capability vocabulary that may reach a person, the
 * "until you revoke it" sentinel must not render as a date, and the
 * after-revoke copy must not claim more than the relay actually did.
 */
import { describe, expect, test } from 'bun:test';
import {
  confirmCopy,
  guestShareRows,
  ownerShareRows,
  revokeDoneCopy,
  revokeFailedCopy,
  roleWord,
  timeLeft,
  type ShareRow,
  type WireMyShare,
  type WireShareGrant,
  type WireShareInvite,
} from './shares';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
// What the desktop binds for a share that lasts until revoked: the largest
// timestamp Date can represent.
const NEVER = 8_640_000_000_000_000;

function grant(over: Partial<WireShareGrant> = {}): WireShareGrant {
  return {
    id: 'g1',
    role: 'viewer',
    status: 'active',
    granteeName: 'Dana',
    granteeLogin: 'dana-k',
    expiresAt: NOW + 4 * HOUR,
    ...over,
  };
}

function invite(over: Partial<WireShareInvite> = {}): WireShareInvite {
  return { id: 'i1', expectedGithubLogin: 'dana-k', role: 'viewer', status: 'pending', expiresAt: NOW + 24 * HOUR, ...over };
}

function myShare(over: Partial<WireMyShare> = {}): WireMyShare {
  return { ...grant(), machineName: 'laptop', ownerName: 'Will', ...over };
}

describe('roleWord', () => {
  test('maps the two server roles to the two words', () => {
    expect(roleWord('viewer')).toBe('Watching');
    expect(roleWord('operator')).toBe('Watching and typing');
  });

  test('an unknown role reads as the smaller capability', () => {
    expect(roleWord('admin')).toBe('Watching');
    expect(roleWord('')).toBe('Watching');
  });
});

describe('timeLeft', () => {
  test('scales through minutes, hours and days', () => {
    expect(timeLeft(20_000)).toBe('under a minute');
    expect(timeLeft(60_000)).toBe('1 minute');
    expect(timeLeft(5 * 60_000)).toBe('5 minutes');
    expect(timeLeft(HOUR)).toBe('1 hour');
    expect(timeLeft(4 * HOUR)).toBe('4 hours');
    expect(timeLeft(26 * HOUR)).toBe('1 day');
    expect(timeLeft(3 * 24 * HOUR)).toBe('3 days');
  });
});

describe('ownerShareRows', () => {
  test('an active timed grant renders the person, the role word and the end', () => {
    const rows = ownerShareRows([], [grant()], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'grant',
      id: 'g1',
      person: '@dana-k',
      roleWord: 'Watching',
      pending: false,
      detail: 'Ends in 4 hours',
      action: 'Revoke',
    });
  });

  test('the until-revoked sentinel renders as words, never as a date', () => {
    const rows = ownerShareRows([], [grant({ expiresAt: NEVER })], NOW);
    expect(rows[0]!.detail).toBe('Until you revoke it');
  });

  test('an operator grant says "Watching and typing"', () => {
    expect(ownerShareRows([], [grant({ role: 'operator' })], NOW)[0]!.roleWord).toBe('Watching and typing');
  });

  test('a person with no handle on file still gets a name', () => {
    expect(ownerShareRows([], [grant({ granteeLogin: null })], NOW)[0]!.person).toBe('Dana');
  });

  test('a pending grant is marked pending, with a Refuse action', () => {
    const rows = ownerShareRows([], [grant({ status: 'pending', expiresAt: null })], NOW);
    expect(rows[0]).toMatchObject({
      pending: true,
      detail: 'Waiting for your approval in the desktop app',
      action: 'Refuse',
    });
  });

  test('an expired grant is dropped — it no longer lets anyone in', () => {
    expect(ownerShareRows([], [grant({ expiresAt: NOW - 1 })], NOW)).toHaveLength(0);
  });

  test('an addressed invite is a pending row for that handle', () => {
    const rows = ownerShareRows([invite()], [], NOW);
    expect(rows[0]).toMatchObject({
      kind: 'invite',
      person: '@dana-k',
      pending: true,
      detail: 'Invite link not used yet — it expires in 1 day',
      action: 'Cancel',
    });
  });

  test('an open invite says who it admits: anyone holding it', () => {
    expect(ownerShareRows([invite({ expectedGithubLogin: null })], [], NOW)[0]!.person).toBe('Anyone with the link');
  });

  test('redeemed, revoked and expired invites are not rows', () => {
    const gone = [
      invite({ status: 'redeemed' }),
      invite({ status: 'revoked' }),
      invite({ expiresAt: NOW - 1 }),
    ];
    expect(ownerShareRows(gone, [], NOW)).toHaveLength(0);
  });

  test('who has access now comes first, then the waiting, then the links', () => {
    const rows = ownerShareRows(
      [invite({ id: 'i1' })],
      [grant({ id: 'pend', status: 'pending', expiresAt: null }), grant({ id: 'act' })],
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(['act', 'pend', 'i1']);
  });

  test('no server vocabulary reaches any rendered string', () => {
    const rows = ownerShareRows(
      [invite(), invite({ expectedGithubLogin: null, role: 'operator' })],
      [grant(), grant({ id: 'g2', role: 'operator', expiresAt: NEVER }), grant({ id: 'g3', status: 'pending', expiresAt: null })],
      NOW,
    );
    expectHumanWordsOnly(rows);
  });
});

describe('guestShareRows', () => {
  test('a share is labelled by person, the way a guest was invited', () => {
    const rows = guestShareRows([myShare()], NOW);
    expect(rows[0]).toMatchObject({
      person: "Will's laptop",
      roleWord: 'Watching',
      pending: false,
      detail: 'Ends in 4 hours',
      action: 'Leave',
    });
  });

  test('falls back through the labels it has', () => {
    expect(guestShareRows([myShare({ ownerName: null })], NOW)[0]!.person).toBe('laptop');
    expect(guestShareRows([myShare({ ownerName: null, machineName: null })], NOW)[0]!.person).toBe('A shared session');
  });

  test('a pending share reads as waiting, in the guest voice', () => {
    const rows = guestShareRows([myShare({ status: 'pending', expiresAt: null })], NOW);
    expect(rows[0]!.pending).toBe(true);
    expect(rows[0]!.detail).toBe("Waiting to be let in — they'll get a prompt on their machine");
  });

  test('the sentinel reads in the guest voice, not the owner one', () => {
    expect(guestShareRows([myShare({ expiresAt: NEVER })], NOW)[0]!.detail).toBe('Until you leave, or they stop sharing');
  });

  test('an expired share is dropped', () => {
    expect(guestShareRows([myShare({ expiresAt: NOW - 1 })], NOW)).toHaveLength(0);
  });

  test('no server vocabulary reaches the guest either', () => {
    expectHumanWordsOnly(guestShareRows([myShare(), myShare({ role: 'operator', status: 'pending', expiresAt: null })], NOW));
  });
});

describe('the copy around a revoke', () => {
  const activeRow = ownerShareRows([], [grant()], NOW)[0]!;
  const pendingRow = ownerShareRows([], [grant({ status: 'pending', expiresAt: null })], NOW)[0]!;
  const inviteRow = ownerShareRows([invite()], [], NOW)[0]!;
  const leaveRow = guestShareRows([myShare()], NOW)[0]!;

  test('each action asks a question about what it actually does', () => {
    expect(confirmCopy(activeRow)).toContain('Revoke access for @dana-k');
    expect(confirmCopy(pendingRow)).toContain('Refuse @dana-k');
    expect(confirmCopy(inviteRow)).toContain('Cancel this invite');
    expect(confirmCopy(leaveRow)).toContain("Leave Will's laptop");
  });

  test('revoking with the machine connected says the guest was cut off', () => {
    expect(revokeDoneCopy(activeRow, false)).toBe("Access ended. If they were connected, they've been disconnected.");
  });

  test('revoking with the machine offline is honest about when it lands there', () => {
    const copy = revokeDoneCopy(activeRow, true);
    expect(copy).toContain('offline');
    expect(copy).toContain('reconnects');
    expect(copy).toContain("can't get back in");
  });

  test('cancelling an invite and refusing a request each say what happened', () => {
    expect(revokeDoneCopy(inviteRow, false)).toContain("That link doesn't work any more");
    expect(revokeDoneCopy(pendingRow, true)).toContain("They haven't been let in");
  });

  test('leaving reads the same whatever the machine is doing', () => {
    expect(revokeDoneCopy(leaveRow, true)).toBe(revokeDoneCopy(leaveRow, false));
    expect(revokeDoneCopy(leaveRow, false)).toContain("You've left");
  });

  test('failure copy distinguishes gone, unreachable and refused', () => {
    expect(revokeFailedCopy(404)).toBe('That share was already gone.');
    expect(revokeFailedCopy(null)).toContain("Couldn't reach the server");
    expect(revokeFailedCopy(500)).toContain('Try again');
  });
});

/** Every string a person could read, checked against the words that must not appear. */
function expectHumanWordsOnly(rows: ShareRow[]): void {
  for (const row of rows) {
    const visible = [row.person, row.roleWord, row.detail, row.action, confirmCopy(row), revokeDoneCopy(row, false), revokeDoneCopy(row, true)].join(' ');
    expect(visible).not.toMatch(/viewer|operator|grantee|scope|\bgrants?\b/i);
  }
}
