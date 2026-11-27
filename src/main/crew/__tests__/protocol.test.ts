import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ERROR_REASONS,
  HUB_FRAME_TYPES,
  LINK_ERRORS,
  MACHINE_FRAME_TYPES,
  MAX_FRAME_BYTES,
  MAX_TEXT,
  PROTOCOL_VERSION,
  REFUSED_REASONS,
  authMessage,
  linkMessage,
  type MachineFrame,
} from '../protocol';
import { assertSendable, cutText, isUuidV4, parseHubFrame } from '../protocol-parse';
import { HIRE, MACHINE, PERSON, uuid } from './crew-db';

describe('the copied protocol', () => {
  test('pins the auth message the Hub verifies', () => {
    expect(authMessage('crew.bodhi.software', MACHINE, 'n0nce')).toBe(
      `bodhi-crew-hub-auth-v1:crew.bodhi.software:${MACHINE}:n0nce`,
    );
  });

  test('pins the link message, newline separated, issuedAt as an integer', () => {
    expect(linkMessage('crew.bodhi.software', 'ED', 'X', 1700000000000, 'Mac mini')).toBe(
      'bodhi-crew-link-v1\ncrew.bodhi.software\nED\nX\n1700000000000\nMac mini',
    );
  });

  test('the value sets match the published contract exactly', () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(MAX_TEXT).toBe(28_000);
    expect(MAX_FRAME_BYTES).toBe(262_144);
    expect([...MACHINE_FRAME_TYPES]).toEqual([
      'auth', 'ack', 'heartbeat', 'reply', 'typing', 'lease_revoked', 'file', 'card_raise', 'usage_record',
      'usage_read', 'sync_pull', 'edit', 'note_write', 'routine_fired', 'token_request', 'audit', 'unlink',
      'artifact_request',
    ]);
    expect([...HUB_FRAME_TYPES]).toEqual([
      'challenge', 'welcome', 'deliver', 'ack', 'renew', 'refused', 'lease_revoke', 'error', 'change',
      'sync_page', 'edit_result', 'card_decision', 'usage', 'token', 'artifact',
    ]);
    expect([...REFUSED_REASONS]).toEqual(['stale-epoch', 'not-home', 'unknown', 'wrong-hire', 'closed', 'scope', 'paused', 'malformed']);
    expect([...ERROR_REASONS]).toEqual(['protocol-version', 'bad-auth', 'pending', 'unlinked', 'auth-timeout', 'replaced']);
    expect([...LINK_ERRORS]).toEqual(['bad-request', 'bad-signature', 'clock-skew', 'replayed', 'already-linked']);
  });

  test('the machine has no execute and no decide frame', () => {
    const types = MACHINE_FRAME_TYPES as readonly string[];
    expect(types).not.toContain('execute');
    expect(types).not.toContain('card_decision');
    expect(() => assertSendable({ type: 'execute' } as unknown as MachineFrame)).toThrow();
    expect(() => assertSendable({ type: 'card_decision', id: uuid(1) } as unknown as MachineFrame)).toThrow();
  });

  test('a frame over MAX_FRAME_BYTES is never sent', () => {
    const frame = { type: 'reply', id: uuid(1), hireId: HIRE, epoch: 1, text: '中'.repeat(90_000) } as MachineFrame;
    expect(() => assertSendable(frame)).toThrow(/MAX_FRAME_BYTES/);
  });

  test('a frame the Hub could not store is never sent', () => {
    const nul = { type: 'reply', id: uuid(1), hireId: HIRE, epoch: 1, text: 'a\0b' } as MachineFrame;
    const lone = { type: 'reply', id: uuid(2), hireId: HIRE, epoch: 1, text: 'a\uD800b' } as MachineFrame;
    expect(() => assertSendable(nul)).toThrow(/malformed/);
    expect(() => assertSendable(lone)).toThrow(/malformed/);
  });

  test('no crew code clears the relay identity it shares', () => {
    const dir = path.join(import.meta.dir, '..');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(p);
        } else if (p.endsWith('.ts') && fs.readFileSync(p, 'utf8').includes('clearIdentity')) {
          offenders.push(p);
        }
      }
    };
    walk(dir);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).length).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});

const deliver = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'deliver', id: uuid(1), hireId: HIRE, epoch: 3, scope: 'owner', requestedBy: PERSON, text: 'hi', from: 'B', ...over });

describe('parseHubFrame', () => {
  test('reads a well-formed deliver', () => {
    const parsed = parseHubFrame(deliver());
    expect(parsed.ok).toBe(true);
  });

  test('refuses, never coerces, a deliver with a bad field', () => {
    for (const over of [
      { scope: 'everyone' },
      { scope: undefined },
      { requestedBy: 'not-a-uuid' },
      { id: uuid(1).toUpperCase() },
      { epoch: 1.5 },
      { epoch: '3' },
      { text: 'x'.repeat(MAX_TEXT + 1) },
      { from: undefined },
    ]) {
      const parsed = parseHubFrame(deliver(over));
      expect(parsed).toEqual({ ok: false, problem: 'bad-shape', type: 'deliver' });
    }
  });

  test('drops bad JSON, unknown types and oversize frames', () => {
    expect(parseHubFrame('{nope')).toEqual({ ok: false, problem: 'not-json' });
    expect(parseHubFrame(JSON.stringify({ type: 'execute' }))).toEqual({ ok: false, problem: 'unknown-type', type: 'execute' });
    expect(parseHubFrame(JSON.stringify([1]))).toEqual({ ok: false, problem: 'bad-shape' });
    expect(parseHubFrame('"x"'.padEnd(MAX_FRAME_BYTES + 1, ' '))).toEqual({ ok: false, problem: 'too-large' });
  });

  test('card_decision, token and usage parse only in their shapes', () => {
    const decision = { type: 'card_decision', id: uuid(1), hireId: HIRE, epoch: 2, raiseId: uuid(2), decision: 'approved', decidedBy: 'p' };
    expect(parseHubFrame(JSON.stringify(decision)).ok).toBe(true);
    expect(parseHubFrame(JSON.stringify({ ...decision, decision: 'maybe' }))).toEqual({ ok: false, problem: 'bad-shape', type: 'card_decision' });
    expect(parseHubFrame(JSON.stringify({ type: 'token', id: uuid(1), token: 't', expiresAt: 5, repos: ['o/r'] })).ok).toBe(true);
    expect(parseHubFrame(JSON.stringify({ type: 'token', id: uuid(1), token: '', expiresAt: 5, repos: [] })).ok).toBe(false);
    const usage = { type: 'usage', id: uuid(1), hireId: HIRE, since: 1, inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, records: 1 };
    expect(parseHubFrame(JSON.stringify(usage)).ok).toBe(true);
    expect(parseHubFrame(JSON.stringify({ ...usage, inputTokens: -1 })).ok).toBe(false);
  });

  test('renew needs integer epoch-ms hubTime and well-formed leases', () => {
    expect(parseHubFrame(JSON.stringify({ type: 'renew', seq: 1, hubTime: 5, leases: [{ hireId: HIRE, epoch: 2 }] })).ok).toBe(true);
    expect(parseHubFrame(JSON.stringify({ type: 'renew', seq: 1, leases: [] })).ok).toBe(false);
    expect(parseHubFrame(JSON.stringify({ type: 'renew', seq: 1, hubTime: 5, leases: [{ hireId: 'x', epoch: 2 }] })).ok).toBe(false);
  });

  test('change needs an integer seq', () => {
    expect(parseHubFrame(JSON.stringify({ type: 'change', seq: 7 })).ok).toBe(true);
    expect(parseHubFrame(JSON.stringify({ type: 'change', seq: -1 })).ok).toBe(false);
    expect(parseHubFrame(JSON.stringify({ type: 'change' })).ok).toBe(false);
  });

  const obj = (over: Record<string, unknown> = {}) => ({
    kind: 'role', objectId: 'po', rev: 2, seq: 9, hash: 'h', deleted: false, body: { role: 'po' }, ...over,
  });
  const page = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'sync_page', id: uuid(5), changes: [obj()], next: 9, more: false, ...over });

  test('sync_page reads well-formed objects, a header without its body included', () => {
    expect(parseHubFrame(page()).ok).toBe(true);
    expect(parseHubFrame(page({ changes: [obj({ kind: 'note', body: undefined })] })).ok).toBe(true);
  });

  test('sync_page refuses a bad page or any bad object in it', () => {
    for (const over of [
      { id: 'x' },
      { changes: {} },
      { next: 1.5 },
      { more: 'no' },
      { changes: [obj({ kind: 'settings' })] },
      { changes: [obj({ objectId: '' })] },
      { changes: [obj({ rev: '2' })] },
      { changes: [obj({ seq: undefined })] },
      { changes: [obj({ hash: '' })] },
      { changes: [obj({ deleted: 0 })] },
      { changes: [obj({ body: [1] })] },
      { changes: [obj(), 'x'] },
    ]) {
      expect(parseHubFrame(page(over))).toEqual({ ok: false, problem: 'bad-shape', type: 'sync_page' });
    }
  });

  test('edit_result reads each result, and refuses a bad field', () => {
    const result = (over: Record<string, unknown> = {}) => JSON.stringify({ type: 'edit_result', id: uuid(6), result: 'applied', ...over });
    expect(parseHubFrame(result()).ok).toBe(true);
    expect(parseHubFrame(result({ result: 'conflict', objectId: 'po', rev: 3, why: 'stale', current: obj() })).ok).toBe(true);
    for (const over of [{ id: 'x' }, { result: 'ok' }, { objectId: '' }, { rev: -1 }, { why: 3 }, { current: obj({ rev: 'x' }) }]) {
      expect(parseHubFrame(result(over))).toEqual({ ok: false, problem: 'bad-shape', type: 'edit_result' });
    }
  });

  test('challenge needs a nonce and an integer hubTime', () => {
    expect(parseHubFrame(JSON.stringify({ type: 'challenge', version: 2, nonce: 'n', hubTime: 1 })).ok).toBe(true);
    expect(parseHubFrame(JSON.stringify({ type: 'challenge', version: 2, nonce: '', hubTime: 1 })).ok).toBe(false);
    expect(parseHubFrame(JSON.stringify({ type: 'challenge', version: 2, nonce: 'n', hubTime: 1.2 })).ok).toBe(false);
  });

  test('an unknown refused reason still parses, so its id can be resolved', () => {
    expect(parseHubFrame(JSON.stringify({ type: 'refused', id: uuid(2), reason: 'brand-new' })).ok).toBe(true);
  });

  test('isUuidV4 takes lowercase v4 only', () => {
    expect(isUuidV4(HIRE)).toBe(true);
    expect(isUuidV4(uuid(0xabc))).toBe(true);
    expect(isUuidV4(uuid(0xabc).toUpperCase())).toBe(false);
    expect(isUuidV4('11111111-1111-1111-8111-111111111111')).toBe(false);
  });
});

describe('cutText', () => {
  test('leaves text at the limit alone', () => {
    const text = 'a'.repeat(MAX_TEXT);
    expect(cutText(text)).toBe(text);
  });

  test('cuts with the notice inside the limit', () => {
    const cut = cutText('a'.repeat(MAX_TEXT + 500));
    expect(cut.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(cut.endsWith('(cut at 28,000 characters)')).toBe(true);
  });

  test('never ends the kept part on a lone high surrogate', () => {
    for (const [pad, emoji] of [[0, '\u{1F600}'], [1, '\u{1F600}'], [0, '\u{10000}'], [1, '\u{10000}'], [0, '\u{10FFFF}'], [1, '\u{10FFFF}']] as const) {
      const cut = cutText('a'.repeat(pad) + emoji.repeat(MAX_TEXT));
      const kept = cut.slice(0, cut.indexOf('\n… (cut'));
      const lastCode = kept.charCodeAt(kept.length - 1);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      expect(cut.length).toBeLessThanOrEqual(MAX_TEXT);
    }
  });
});
