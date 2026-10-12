/**
 * Review-marker tests (CO-722, Phase 3 — the TS port of read_review.py).
 *
 * The exit-code contract is the load-bearing bit: 0 pass, 1 blocks, 2 unreadable
 * (half a review), 3 not an arbiter review at all. The rule that costs something
 * to learn — a non-integer count makes the whole marker unreadable rather than
 * zero, so a blocking finding is never silently forgiven — gets its own case.
 *
 * Run with: bun test src/main/run-engine/__tests__/review-markers.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { readReviewMarkers } from '../review-markers';

const verdict = (v: string) => `<!-- arbiter:verdict=${v} -->`;
const findings = (o: object) => `<!-- arbiter:findings=${JSON.stringify(o)} -->`;
const zero = { blocking: 0, major: 0, minor: 0, nit: 0 };

describe('readReviewMarkers', () => {
  test('an approve with zero blocking findings passes (0)', () => {
    const r = readReviewMarkers(`Looks good.\n${verdict('approve')}\n${findings(zero)}`);
    expect(r.code).toBe(0);
    expect(r.payload).toMatchObject({ arbiter: true, verdict: 'approve', blocks: false, highest: null });
  });

  test('request-changes blocks (1) even with zero counts — either signal alone blocks', () => {
    const r = readReviewMarkers(`${verdict('request-changes')}\n${findings(zero)}`);
    expect(r.code).toBe(1);
    expect(r.payload.blocks).toBe(true);
  });

  test('approve with a blocking count > 0 still blocks (1)', () => {
    const r = readReviewMarkers(`${verdict('approve')}\n${findings({ blocking: 1, major: 0, minor: 0, nit: 0 })}`);
    expect(r.code).toBe(1);
  });

  test('highest severity is reported highest-first', () => {
    const r = readReviewMarkers(`${verdict('comment')}\n${findings({ blocking: 0, major: 1, minor: 3, nit: 5 })}`);
    expect(r.code).toBe(0); // comment + no blocking = does not block
    expect(r.payload.highest).toBe('major');
  });

  test('a body with no markers is not-an-arbiter-review (3), treated as a person\'s', () => {
    const r = readReviewMarkers('LGTM, nice work — merging on green.');
    expect(r.code).toBe(3);
    expect(r.payload.arbiter).toBe(false);
  });

  test('a verdict with no findings counts is unreadable (2), not a lenient pass', () => {
    const r = readReviewMarkers(verdict('approve'));
    expect(r.code).toBe(2);
    expect(r.payload).toMatchObject({ arbiter: true, verdict: 'approve', counts: null });
  });

  test('findings with no verdict marker is half a review, unreadable (2)', () => {
    const r = readReviewMarkers(findings(zero));
    expect(r.code).toBe(2);
    expect(r.payload).toMatchObject({ arbiter: true, verdict: null });
  });

  test('a non-integer count makes the whole marker unreadable (2), never zero', () => {
    // {"blocking": "2"} read as 0 would silently forgive a blocking finding.
    const r = readReviewMarkers(`${verdict('approve')}\n${findings({ blocking: '2', major: 0, minor: 0, nit: 0 })}`);
    expect(r.code).toBe(2);
    expect(r.payload.counts).toBeNull();
  });

  test('a negative or boolean count is also unreadable', () => {
    expect(readReviewMarkers(`${verdict('approve')}\n${findings({ blocking: -1, major: 0, minor: 0, nit: 0 })}`).code).toBe(2);
    expect(readReviewMarkers(`${verdict('approve')}\n${findings({ blocking: true, major: 0, minor: 0, nit: 0 })}`).code).toBe(2);
  });

  test('markers are matched case-insensitively', () => {
    const r = readReviewMarkers(`<!-- ARBITER:VERDICT=APPROVE -->\n<!-- Arbiter:Findings={"blocking":0,"major":0,"minor":0,"nit":0} -->`);
    expect(r.code).toBe(0);
    expect(r.payload.verdict).toBe('approve');
  });
});
