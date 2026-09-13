/**
 * Verdict-reading tests (CO-722).
 *
 * One rule: a missing or malformed verdict is inconclusive, never a pass.
 * Every case here is a way a verdict can be absent while looking present, and
 * the control for all of them is that an honest pass still passes — a reader
 * that answered `inconclusive` for everything would satisfy every assertion
 * below and stop every run.
 *
 * Run with: bun test src/main/run-engine
 */
import { describe, expect, test } from 'bun:test';
import { GATE_VERDICT_SCHEMA, readGateVerdict } from '../gate-verdict';

describe('an answer that was actually given', () => {
  test('a clean pass reads as a pass', () => {
    // THE control. Without it, refusing everything would satisfy this whole
    // file and no gate could ever succeed.
    const reading = readGateVerdict({ verdict: 'pass', summary: 'Nothing blocking.' });
    expect(reading.verdict).toBe('pass');
    expect(reading.summary).toBe('Nothing blocking.');
  });

  test('a fail with findings reads as a fail, and keeps them', () => {
    const reading = readGateVerdict({
      verdict: 'fail',
      summary: 'Two problems.',
      blocking: [{ what: 'no test covers the branch', where: 'src/a.ts:12' }],
    });
    expect(reading.verdict).toBe('fail');
    expect(reading.blocking).toEqual([{ what: 'no test covers the branch', where: 'src/a.ts:12' }]);
  });

  test("the agent's own inconclusive is honoured", () => {
    // The enum exists so a gate that could not establish something has a way
    // to say so that is not "fail" — otherwise its only honest answer sends
    // an owner back to fix working code.
    expect(readGateVerdict({ verdict: 'inconclusive', summary: 'No diff to read.' }).verdict)
      .toBe('inconclusive');
  });

  test('a verdict is read whatever case it arrives in', () => {
    expect(readGateVerdict({ verdict: 'PASS', summary: '' }).verdict).toBe('pass');
    expect(readGateVerdict({ verdict: ' Fail ', summary: '' }).verdict).toBe('fail');
  });
});

describe('a verdict that is absent while looking present', () => {
  test('no object at all is inconclusive', () => {
    for (const output of [null, undefined, 'pass', 42, ['pass']]) {
      expect(readGateVerdict(output).verdict).toBe('inconclusive');
    }
  });

  test('an object with no verdict field is inconclusive', () => {
    const reading = readGateVerdict({ summary: 'looks fine to me' });
    expect(reading.verdict).toBe('inconclusive');
    expect(reading.reason).toContain('no verdict field');
  });

  test('a word outside the enum is not coerced', () => {
    // `approved` and `changes_requested` are the words a model reaches for
    // everywhere else. Mapping them here would accept a verdict the schema
    // rejected, and the schema's whole job is making this case impossible —
    // its presence means something upstream did not hold.
    for (const word of ['approved', 'changes_requested', 'lgtm', 'yes']) {
      const reading = readGateVerdict({ verdict: word, summary: '' });
      expect(reading.verdict).toBe('inconclusive');
      expect(reading.reason).toContain(word);
    }
  });

  test('a pass carrying blocking findings contradicts itself', () => {
    // Two answers that disagree. Reading the verdict advances past findings
    // the gate itself called blocking; reading the findings calls it a
    // failure the gate did not declare. Neither half is the honest one.
    const reading = readGateVerdict({
      verdict: 'pass',
      summary: 'fine',
      blocking: [{ what: 'this is broken' }],
    });
    expect(reading.verdict).toBe('inconclusive');
    expect(reading.reason).toContain('contradicted itself');
    expect(reading.blocking).toHaveLength(1);
  });

  test('a pass with an empty findings list is still a pass', () => {
    // CONTROL for the case above: the array being present is not the problem.
    expect(readGateVerdict({ verdict: 'pass', summary: 'fine', blocking: [] }).verdict).toBe('pass');
  });
});

describe('a fail with no detail stays a fail', () => {
  test('it is recorded, not upgraded to inconclusive', () => {
    // The gate said the work does not meet the bar, which IS an answer. What
    // is missing is the detail, and turning that into "nobody knows" would
    // discard a judgment somebody's tokens paid for.
    const reading = readGateVerdict({ verdict: 'fail', summary: 'Not ready.' });
    expect(reading.verdict).toBe('fail');
    expect(reading.reason).toContain('without listing a blocking finding');
  });
});

describe('findings that cannot be read', () => {
  test('entries with no `what` are dropped rather than carried empty', () => {
    const reading = readGateVerdict({
      verdict: 'fail',
      summary: '',
      blocking: [{ what: 'real' }, { where: 'src/a.ts' }, 'a string', null],
    });
    expect(reading.blocking).toEqual([{ what: 'real' }]);
  });

  test('a findings list that is not a list is no findings', () => {
    // And therefore does not turn a pass into a contradiction: a malformed
    // container is not evidence that anything was found.
    expect(readGateVerdict({ verdict: 'pass', summary: '', blocking: 'two' }).verdict).toBe('pass');
  });
});

describe('the schema the gate is given', () => {
  test('inconclusive is sayable', () => {
    expect(GATE_VERDICT_SCHEMA.properties.verdict.enum).toContain('inconclusive');
  });

  test('a verdict and a summary are both required', () => {
    // A verdict with no summary is a decision nobody can act on without
    // opening the transcript.
    expect(GATE_VERDICT_SCHEMA.required).toEqual(['verdict', 'summary']);
  });

  test('nothing else is accepted', () => {
    // additionalProperties false, so a gate inventing a field is caught by
    // the CLI rather than ignored here.
    expect(GATE_VERDICT_SCHEMA.additionalProperties).toBe(false);
  });

  test('every enum value is one this reader accepts', () => {
    // The schema and the reader must not drift: a value the schema allows and
    // the reader rejects is a gate that answers correctly and reads as broken.
    for (const value of GATE_VERDICT_SCHEMA.properties.verdict.enum) {
      expect(readGateVerdict({ verdict: value, summary: 'x' }).verdict).toBe(value);
    }
  });
});
