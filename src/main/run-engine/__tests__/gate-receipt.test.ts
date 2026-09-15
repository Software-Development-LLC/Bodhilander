import { describe, expect, test } from 'bun:test';
import { readReceipt, receiptPathFor } from '../gate-receipt';

/** A receipt as gate-receipt.sh writes one, minus what a case changes. */
const receipt = (over: Record<string, unknown>): string =>
  JSON.stringify({
    schema_version: 1,
    initiative: 'BDH-239-handoff-delete-rate-limit',
    gate: 4,
    agent: 'verifier',
    verdict: 'pass',
    blocking_findings: [],
    not_verified: [],
    written_at: '2026-09-15T00:27:53Z',
    harness: 'C:\\work\\repos\\claude-team-workflow',
    ...over,
  });

describe('where a receipt lives', () => {
  test('is the harness’s path, keyed by gate and agent', () => {
    // Gate 4 is two agents and each writes its own, so the gate number alone
    // would have the scribe's receipt overwrite the verifier's.
    expect(receiptPathFor('C:/init/BDH-239', 4, 'verifier')).toBe('C:/init/BDH-239/gates/4-verifier.json');
    expect(receiptPathFor('C:/init/BDH-239', 4, 'scribe')).toBe('C:/init/BDH-239/gates/4-scribe.json');
  });
});

describe('no receipt is not a bad receipt', () => {
  test('a gate that has not written one yet is null, not a verdict', () => {
    // The caller decides what silence means. This module must not decide it
    // for them by inventing a verdict for a file that is not there.
    expect(readReceipt(null)).toBeNull();
  });

  test('a file that exists and cannot be read is a gate that tried to answer and failed', () => {
    expect(readReceipt('not json')).toEqual({
      verdict: 'inconclusive', blocking: [], reason: 'the gate receipt is not JSON',
    });
    expect(readReceipt('[]')?.reason).toBe('the gate receipt is not an object');
    expect(readReceipt('null')?.reason).toBe('the gate receipt is not an object');
  });
});

describe('the receipt vocabulary, mapped and never coerced', () => {
  test('pass and fail are what they say', () => {
    expect(readReceipt(receipt({ verdict: 'pass' }))).toEqual({ verdict: 'pass', blocking: [] });
    expect(readReceipt(receipt({ verdict: 'fail', blocking_findings: [{ summary: 'the test is not load-bearing' }] })))
      .toEqual({ verdict: 'fail', blocking: ['the test is not load-bearing'] });
  });

  test('undriveable is inconclusive, and the note says the gate could not run', () => {
    // Exit 2 in the plugin's vocabulary. Not a fail -- sending an owner back
    // to fix a branch because the gate could not run is a red for something
    // the branch did not do.
    const read = readReceipt(receipt({ verdict: 'undriveable' }));
    expect(read?.verdict).toBe('inconclusive');
    expect(read?.reason).toContain('could not be driven');
  });

  test('skip is inconclusive, and the note says nothing was owed', () => {
    const read = readReceipt(receipt({ verdict: 'skip' }));
    expect(read?.verdict).toBe('inconclusive');
    expect(read?.reason).toContain('nothing was owed');
  });

  test.each([['approved'], ['PASSED'], ['ok'], ['green']])('%p is not coerced into a pass', (word) => {
    // `approved` is a word a model reaches for naturally. The schema's job is
    // to make this impossible; its presence means something upstream did not
    // hold, and mapping it to pass here would accept what the schema rejected.
    const read = readReceipt(receipt({ verdict: word }));
    expect(read?.verdict).toBe('inconclusive');
    expect(read?.reason).toContain(`"${word.toLowerCase()}"`);
  });

  test('a missing verdict and a non-string one are told apart', () => {
    // One is a gate not answering, the other a gate answering wrongly. The
    // same note for both sends the reader to the wrong place.
    expect(readReceipt(receipt({ verdict: undefined }))?.reason).toBe('the receipt carries no verdict');
    expect(readReceipt(receipt({ verdict: 1 }))?.reason).toBe("the receipt's verdict was number, not a word");
  });

  test('case and whitespace do not change a real verdict', () => {
    expect(readReceipt(receipt({ verdict: ' Pass ' }))?.verdict).toBe('pass');
  });
});

describe('two answers that disagree', () => {
  test('a pass carrying blocking findings is inconclusive, with both halves kept', () => {
    // Reading the verdict alone advances past findings the gate itself called
    // blocking; reading the findings alone calls it a failure the gate did
    // not declare. Neither half can be trusted to be the honest one.
    const read = readReceipt(receipt({ verdict: 'pass', blocking_findings: [{ summary: 'a' }, { summary: 'b' }] }));
    expect(read?.verdict).toBe('inconclusive');
    expect(read?.blocking).toEqual(['a', 'b']);
    expect(read?.reason).toContain('2 blocking finding(s)');
  });

  test('a fail without findings stays a fail, and says the list is missing', () => {
    // The gate said no. An absent list is a gap in the report, not a
    // reversal of the verdict.
    const read = readReceipt(receipt({ verdict: 'fail', blocking_findings: [] }));
    expect(read?.verdict).toBe('fail');
    expect(read?.reason).toBe('the gate failed without listing a blocking finding');
  });

  test('findings without a summary are not counted, and cannot poison a pass', () => {
    // The schema requires `summary`; a receipt that breaks that elsewhere
    // does not get to turn a pass into two answers with an empty string.
    const read = readReceipt(receipt({ verdict: 'pass', blocking_findings: [{ where: 'x' }, 'text', null] }));
    expect(read).toEqual({ verdict: 'pass', blocking: [] });
  });
});
