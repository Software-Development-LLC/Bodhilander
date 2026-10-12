/**
 * Review-reading tests (CO-722).
 *
 * Three of these fixtures are shapes measured on this org's own PRs on
 * 2026-09-13 rather than shapes imagined for a test: GitHub keeps every
 * review row forever, the arbiter verdict arrives as a StatusContext beside a
 * review authored by a human login, and that review carries no markers at
 * all.
 *
 * The rest are about what happens when the module is wrong, and the two
 * directions are not symmetric. Reading a bot nit as a person costs one owner
 * cycle. Reading a person's blocking review as a bot nit ignores somebody who
 * said stop, and ships the change. Every default here leans the first way,
 * and the tests say so where they do.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import {
  readReviews,
  reviewEvent,
  type MarkerReading,
  type ReviewRow,
} from '../reviews';

const APPROVERS = ['brannon-bowden', 'William-Long-II'];

function row(over: Partial<ReviewRow> & Pick<ReviewRow, 'state'>): ReviewRow {
  return {
    author: 'brannon-bowden',
    submittedAt: '2026-09-13T16:00:00Z',
    ...over,
  };
}

function read(rows: ReviewRow[], approvers: readonly string[] = APPROVERS) {
  return readReviews({ rows, approvers });
}

const ARBITER: MarkerReading = { arbiter: true, highest: 'nit', code: 1 };
const NOT_ARBITER: MarkerReading = { arbiter: false, highest: null, code: 3 };
const UNREADABLE: MarkerReading = { arbiter: true, highest: null, code: 2 };

describe('GitHub keeps every review, not the current one', () => {
  test('an approval after a block is the position that stands', () => {
    // Measured: a PR where an approver requested changes and later approved
    // carries both rows forever. Reading the first would hold the run on a
    // block that was lifted an hour ago.
    const reading = read([
      row({ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-13T15:00:00Z' }),
      row({ state: 'APPROVED', submittedAt: '2026-09-13T16:00:00Z' }),
    ]);
    expect(reading.status).toBe('approved');
  });

  test('a block after an approval is the position that stands', () => {
    // The control, and the direction that matters more: a reviewer who
    // approved and then found something must not be outranked by their own
    // earlier row.
    const reading = read([
      row({ state: 'APPROVED', submittedAt: '2026-09-13T15:00:00Z' }),
      row({ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-13T16:00:00Z' }),
    ]);
    expect(reading.status).toBe('changesRequested');
  });

  test('row order in the array decides nothing — the timestamp does', () => {
    // gh returns them oldest-first today. A module that trusted the order
    // would invert the moment that changed, and nothing would look wrong.
    const older = row({ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-13T15:00:00Z' });
    const newer = row({ state: 'APPROVED', submittedAt: '2026-09-13T16:00:00Z' });
    expect(read([older, newer]).status).toBe('approved');
    expect(read([newer, older]).status).toBe('approved');
  });

  test('a dismissed review is not a position', () => {
    const reading = read([
      row({ state: 'APPROVED', submittedAt: '2026-09-13T15:00:00Z' }),
      row({ state: 'DISMISSED', submittedAt: '2026-09-13T16:00:00Z' }),
    ]);
    expect(reading.status).toBe('approved');
  });

  test('a comment does not outrank the approval before it', () => {
    const reading = read([
      row({ state: 'APPROVED', submittedAt: '2026-09-13T15:00:00Z' }),
      row({ state: 'COMMENTED', submittedAt: '2026-09-13T16:00:00Z' }),
    ]);
    expect(reading.status).toBe('approved');
  });
});

describe('two approvers are two opinions', () => {
  test('an approval beside somebody else’s open block is not approved', () => {
    // The recorded hazard. One person's approval does not answer another's
    // block, and releasing the run here ships a change over an objection
    // nobody withdrew.
    const reading = read([
      row({ author: 'brannon-bowden', state: 'CHANGES_REQUESTED' }),
      row({ author: 'William-Long-II', state: 'APPROVED', submittedAt: '2026-09-13T17:00:00Z' }),
    ]);
    expect(reading.status).toBe('changesRequested');
    if (reading.status !== 'changesRequested') throw new Error('unreachable');
    expect(reading.by).toBe('brannon-bowden');
  });

  test('a later approval from the blocker clears it', () => {
    const reading = read([
      row({ author: 'brannon-bowden', state: 'CHANGES_REQUESTED', submittedAt: '2026-09-13T15:00:00Z' }),
      row({ author: 'brannon-bowden', state: 'APPROVED', submittedAt: '2026-09-13T16:00:00Z' }),
      row({ author: 'William-Long-II', state: 'APPROVED', submittedAt: '2026-09-13T15:30:00Z' }),
    ]);
    expect(reading.status).toBe('approved');
  });

  test('an author is matched case-insensitively', () => {
    // The login as gh reports it and the login as somebody typed it into a
    // config are not reliably the same string.
    const reading = read([row({ author: 'Brannon-Bowden', state: 'APPROVED' })]);
    expect(reading.status).toBe('approved');
  });
});

describe('only an approver decides', () => {
  test('a review from someone else is not an approval', () => {
    const reading = read([row({ author: 'a-passer-by', state: 'APPROVED' })]);
    expect(reading.status).toBe('waiting');
  });

  test('a block from someone else does not hold the run', () => {
    // The same rule in the other direction: if a stranger could block, anyone
    // could park a run indefinitely.
    const reading = read([
      row({ author: 'a-passer-by', state: 'CHANGES_REQUESTED' }),
      row({ author: 'brannon-bowden', state: 'APPROVED' }),
    ]);
    expect(reading.status).toBe('approved');
  });

  test('a forged arbiter marker from a stranger decides nothing', () => {
    // read-review.sh says it plainly: it reads markers, it cannot
    // authenticate them, and where the body came from is the caller's
    // problem. This is the caller, and this is the answer.
    const reading = read([
      row({
        author: 'a-passer-by',
        state: 'APPROVED',
        marker: { arbiter: true, highest: null, code: 0 },
      }),
    ]);
    expect(reading.status).toBe('waiting');
  });

  test('a run with no approvers recorded is undriveable, not waiting', () => {
    // Nobody is empowered to decide, so the run would wait forever on an
    // answer that cannot arrive.
    const reading = read([row({ state: 'APPROVED' })], []);
    expect(reading.status).toBe('undriveable');
    if (reading.status !== 'undriveable') throw new Error('unreachable');
    expect(reading.reason).toContain('no approvers recorded');
  });

  test('no reviews yet is waiting', () => {
    expect(read([]).status).toBe('waiting');
  });
});

describe('a review is a person’s unless something proves otherwise', () => {
  test('an unmarked block is a human block', () => {
    // Measured: the review row beside the arbiter status is authored by a
    // human login and carries no markers at all. Nothing here proves a bot,
    // so nothing infers one.
    const reading = read([row({ state: 'CHANGES_REQUESTED', marker: NOT_ARBITER })]);
    if (reading.status !== 'changesRequested') throw new Error('expected changesRequested');
    expect(reading.verdict).toEqual({ actor: 'human' });
  });

  test('a block never passed to the marker reader is a human block', () => {
    // Absent means "not asked", which is not evidence of anything.
    const reading = read([row({ state: 'CHANGES_REQUESTED' })]);
    if (reading.status !== 'changesRequested') throw new Error('expected changesRequested');
    expect(reading.verdict).toEqual({ actor: 'human' });
  });

  test('a marked block is a bot block, with its severity', () => {
    const reading = read([row({ state: 'CHANGES_REQUESTED', marker: ARBITER })]);
    if (reading.status !== 'changesRequested') throw new Error('expected changesRequested');
    expect(reading.verdict).toEqual({ actor: 'bot', severity: 'nit' });
  });

  test('a bot block at major is a major', () => {
    const reading = read([
      row({ state: 'CHANGES_REQUESTED', marker: { ...ARBITER, highest: 'major' } }),
    ]);
    if (reading.status !== 'changesRequested') throw new Error('expected changesRequested');
    expect(reading.verdict).toEqual({ actor: 'bot', severity: 'major' });
  });

  test('a bot block whose severity is unknown is a major, not a nit', () => {
    // The state machine records anything below major and carries on. An
    // unknown severity arriving as a nit is a blocking finding waved through
    // on a missing count — a pass by the back door.
    const reading = read([
      row({ state: 'CHANGES_REQUESTED', marker: { ...ARBITER, highest: null } }),
    ]);
    if (reading.status !== 'changesRequested') throw new Error('expected changesRequested');
    expect(reading.verdict).toEqual({ actor: 'bot', severity: 'major' });
  });

  test('the asymmetry itself: unmarked and marked differ only in the marker', () => {
    // One field is the whole difference between "send the owner back" and
    // "record it and keep waiting", so it is asserted directly rather than
    // left to two tests that could both drift the same way.
    const human = read([row({ state: 'CHANGES_REQUESTED', marker: NOT_ARBITER })]);
    const bot = read([row({ state: 'CHANGES_REQUESTED', marker: ARBITER })]);
    if (human.status !== 'changesRequested' || bot.status !== 'changesRequested') {
      throw new Error('both must be changesRequested');
    }
    expect(human.verdict.actor).toBe('human');
    expect(bot.verdict.actor).toBe('bot');
  });
});

describe('who gets named does not depend on the order gh returned', () => {
  test('the same two blocks name the same reviewer either way round', () => {
    // The status would be right either way. The NAME is what a person reads
    // in the notification, and it should not move between two polls that saw
    // the same PR.
    const first = row({
      author: 'brannon-bowden', state: 'CHANGES_REQUESTED', submittedAt: '2026-09-13T15:00:00Z',
    });
    const second = row({
      author: 'William-Long-II', state: 'CHANGES_REQUESTED', submittedAt: '2026-09-13T16:00:00Z',
    });
    for (const rows of [[first, second], [second, first]]) {
      const reading = read(rows);
      if (reading.status !== 'changesRequested') throw new Error('expected changesRequested');
      expect(reading.by).toBe('brannon-bowden');
    }
  });

  test('the same is true of two unreadable reviews', () => {
    const first = row({
      author: 'brannon-bowden', state: 'APPROVED',
      submittedAt: '2026-09-13T15:00:00Z', marker: UNREADABLE,
    });
    const second = row({
      author: 'William-Long-II', state: 'APPROVED',
      submittedAt: '2026-09-13T16:00:00Z', marker: UNREADABLE,
    });
    for (const rows of [[first, second], [second, first]]) {
      const reading = read(rows);
      if (reading.status !== 'undriveable') throw new Error('expected undriveable');
      expect(reading.reason).toContain('brannon-bowden');
    }
  });
});

describe('a review that could not be read', () => {
  test('unreadable markers are undriveable, not a person’s review', () => {
    // Exit 2 one level up. Markers were there and could not be read, so what
    // this review decided is genuinely unknown — the one case where reading
    // on would be a guess in either direction.
    const reading = read([row({ state: 'CHANGES_REQUESTED', marker: UNREADABLE })]);
    expect(reading.status).toBe('undriveable');
    if (reading.status !== 'undriveable') throw new Error('unreachable');
    expect(reading.reason).toContain('could not be read');
  });

  test('an unreadable APPROVAL is undriveable too', () => {
    // The direction that matters: an approval nobody could read must not
    // release the run.
    const reading = read([row({ state: 'APPROVED', marker: UNREADABLE })]);
    expect(reading.status).toBe('undriveable');
  });

  test('unreadable outranks a clean approval from someone else', () => {
    const reading = read([
      row({ author: 'brannon-bowden', state: 'APPROVED', marker: UNREADABLE }),
      row({ author: 'William-Long-II', state: 'APPROVED' }),
    ]);
    expect(reading.status).toBe('undriveable');
  });

  test('code 3 is not unreadable — it is the ordinary case', () => {
    // CONTROL. read-review.sh answers 3 for every human review, and treating
    // that as a parse failure would park the run on every one of them.
    const reading = read([row({ state: 'APPROVED', marker: NOT_ARBITER })]);
    expect(reading.status).toBe('approved');
  });
});

describe('the reading as an event', () => {
  test('each decisive reading produces its own event', () => {
    expect(reviewEvent({ status: 'approved', by: 'x' })).toEqual({ kind: 'reviewApproved' });
    expect(
      reviewEvent({ status: 'changesRequested', by: 'x', verdict: { actor: 'human' } }),
    ).toEqual({ kind: 'reviewChangesRequested', verdict: { actor: 'human' } });
    expect(reviewEvent({ status: 'undriveable', reason: 'markers unreadable' })).toEqual({
      kind: 'reviewUndriveable',
      reason: 'markers unreadable',
    });
  });

  test('waiting produces nothing', () => {
    expect(reviewEvent({ status: 'waiting', reason: 'nobody yet' })).toBeNull();
  });

  test('the verdict travels with the event', () => {
    // The severity is what the state machine gates re-entry on, so losing it
    // here turns every bot nit into an owner cycle.
    const event = reviewEvent({
      status: 'changesRequested',
      by: 'brannon-bowden',
      verdict: { actor: 'bot', severity: 'nit' },
    });
    expect(event).toEqual({
      kind: 'reviewChangesRequested',
      verdict: { actor: 'bot', severity: 'nit' },
    });
  });

  test('an undriveable review is not reported as a check problem', () => {
    // They are different events because they arrive in different states, and
    // an event a state does not handle is silently ignored — a run waiting
    // forever on a verdict that already came.
    const event = reviewEvent({ status: 'undriveable', reason: 'x' });
    expect(event?.kind).not.toBe('checksUndriveable');
  });
});
