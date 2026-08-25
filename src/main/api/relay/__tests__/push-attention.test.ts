/**
 * The agent-side push trigger: when a state change becomes a notification, and
 * what that notification says.
 *
 * `planAttentionPush` is the whole decision, deliberately, so these tests need
 * no Electron app, no socket and no PTY — the guards, the debounce and the
 * fan-out are exercised directly rather than inferred from a mocked one.
 */
import { describe, expect, test } from 'bun:test';
import { createDecipheriv, createECDH, hkdfSync } from 'crypto';
import {
  ATTENTION_DEBOUNCE_MS,
  MAX_DEBOUNCE_ENTRIES,
  MAX_NAME_LENGTH,
  buildAttentionPayload,
  createAttentionGate,
  planAttentionPush,
  type AttentionGate,
} from '../push-attention';
import type { RelayPushSubscription } from '../push-seal';

/** A subscription we hold the private half of, so a push can be opened again. */
function makeSubscription(id: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, id.charCodeAt(0));
  return {
    sub: { id, p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    open(bodyB64: string): Record<string, unknown> {
      const body = Buffer.from(bodyB64, 'base64');
      const salt = body.subarray(0, 16);
      const senderPublic = body.subarray(21, 21 + body.readUInt8(20));
      const ciphertext = body.subarray(21 + body.readUInt8(20));
      const shared = ecdh.computeSecret(senderPublic);
      const keyInfo = Buffer.concat([
        Buffer.from('WebPush: info\0', 'utf8'),
        ecdh.getPublicKey(),
        senderPublic,
      ]);
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const padded = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
        decipher.final(),
      ]);
      return JSON.parse(padded.subarray(0, padded.length - 1).toString('utf8')) as Record<string, unknown>;
    },
  };
}

const EVENT = { sessionId: 's-1', sessionName: 'relay-web', state: 'waiting' as const };

function plan(over: Partial<Parameters<typeof planAttentionPush>[0]> = {}) {
  const device = makeSubscription('d1');
  return planAttentionPush({
    connected: true,
    machineId: 'machine-1',
    subs: [device.sub],
    gate: createAttentionGate(),
    event: EVENT,
    ...over,
  });
}

describe('planAttentionPush — the guards', () => {
  test('sends nothing while the relay socket is down', () => {
    expect(plan({ connected: false })).toBeNull();
  });

  test('sends nothing before the machine has been linked', () => {
    expect(plan({ machineId: null })).toBeNull();
  });

  test('sends nothing when no browser has subscribed', () => {
    expect(plan({ subs: [] })).toBeNull();
  });

  test('sends when the socket is up, the machine is linked and a device is subscribed', () => {
    const message = plan();
    expect(message?.type).toBe('push:send');
    expect(message?.items.length).toBe(1);
  });
});

describe('planAttentionPush — the message', () => {
  test('seals one payload per subscribed device, each readable only by that device', () => {
    const phone = makeSubscription('phone');
    const tablet = makeSubscription('tabletx');
    const message = plan({ subs: [phone.sub, tablet.sub] });

    expect(message!.items.map((i) => i.id)).toEqual(['phone', 'tabletx']);
    // Each body is a separate sealing, not one blob copied twice.
    expect(message!.items[0]!.body).not.toBe(message!.items[1]!.body);
    expect(phone.open(message!.items[0]!.body).title).toBe('relay-web');
    expect(tablet.open(message!.items[1]!.body).title).toBe('relay-web');
    // And the wrong device cannot read the other's copy.
    expect(() => phone.open(message!.items[1]!.body)).toThrow();
  });

  test('carries the session name, which is why the agent seals this at all', () => {
    const device = makeSubscription('d1');
    const message = plan({
      subs: [device.sub],
      event: { sessionId: 's-9', sessionName: 'deploy-prod', state: 'waiting' },
    });
    expect(device.open(message!.items[0]!.body)).toEqual({
      title: 'deploy-prod',
      body: 'Waiting for your input',
      tag: 's-9',
      machineId: 'machine-1',
      sessionId: 's-9',
    });
  });

  test('the relay only ever sees an opaque id and base64 ciphertext', () => {
    const device = makeSubscription('d1');
    const message = plan({
      subs: [device.sub],
      event: { sessionId: 's-9', sessionName: 'top-secret-project', state: 'waiting' },
    });
    // The entire message as it goes on the wire. If the name appears anywhere
    // in here, the zero-knowledge property this design rests on is broken.
    expect(JSON.stringify(message)).not.toContain('top-secret-project');
  });

  test('an error reads differently from a prompt', () => {
    const device = makeSubscription('d1');
    const message = plan({
      subs: [device.sub],
      event: { sessionId: 's-2', sessionName: 'api', state: 'error' },
    });
    expect(device.open(message!.items[0]!.body).body).toBe('Hit an error and is waiting');
  });

  test('one unsealable subscription does not silence the rest', () => {
    const good = makeSubscription('good');
    const broken: RelayPushSubscription = { id: 'broken', p256dh: 'not-a-point', auth: 'nope' };
    const errors: unknown[] = [];
    const message = plan({ subs: [broken, good.sub], onSealError: (err) => errors.push(err) });

    expect(message!.items.map((i) => i.id)).toEqual(['good']);
    expect(errors.length).toBe(1);
  });

  test('sends nothing at all when no subscription could be sealed', () => {
    const broken: RelayPushSubscription = { id: 'broken', p256dh: 'not-a-point', auth: 'nope' };
    expect(plan({ subs: [broken], onSealError: () => {} })).toBeNull();
  });
});

describe('the debounce', () => {
  let clock = 1_000_000;
  const gateAt = (): AttentionGate => createAttentionGate(() => clock);

  test('suppresses a repeat inside the window and allows one after it', () => {
    clock = 1_000_000;
    const gate = gateAt();
    expect(gate.allow('s-1', 'waiting')).toBe(true);
    clock += ATTENTION_DEBOUNCE_MS - 1;
    expect(gate.allow('s-1', 'waiting')).toBe(false);
    clock += 2;
    expect(gate.allow('s-1', 'waiting')).toBe(true);
  });

  test('a session flapping in and out of waiting buzzes once', () => {
    clock = 1_000_000;
    const gate = gateAt();
    let sent = 0;
    for (let i = 0; i < 20; i++) {
      if (plan({ gate })) sent += 1;
      clock += 500; // twenty transitions across ten seconds
    }
    expect(sent).toBe(1);
  });

  test('different sessions and different states are separate windows', () => {
    clock = 1_000_000;
    const gate = gateAt();
    expect(gate.allow('s-1', 'waiting')).toBe(true);
    expect(gate.allow('s-2', 'waiting')).toBe(true);
    // A session that goes from waiting to error has genuinely changed, and the
    // person should hear about it.
    expect(gate.allow('s-1', 'error')).toBe(true);
    expect(gate.allow('s-1', 'waiting')).toBe(false);
  });

  test('is bounded, so a long-running desktop cannot grow it forever', () => {
    clock = 1_000_000;
    const gate = gateAt();
    for (let i = 0; i < MAX_DEBOUNCE_ENTRIES + 50; i++) gate.allow(`s-${i}`, 'waiting');
    // The oldest entries were evicted, so the earliest session is allowed
    // through again even though no time has passed.
    expect(gate.allow('s-0', 'waiting')).toBe(true);
    // The most recent one is still suppressed.
    expect(gate.allow(`s-${MAX_DEBOUNCE_ENTRIES + 49}`, 'waiting')).toBe(false);
  });

  test('clear() forgets every window', () => {
    clock = 1_000_000;
    const gate = gateAt();
    expect(gate.allow('s-1', 'waiting')).toBe(true);
    expect(gate.allow('s-1', 'waiting')).toBe(false);
    gate.clear();
    expect(gate.allow('s-1', 'waiting')).toBe(true);
  });
});

describe('buildAttentionPayload', () => {
  test('falls back to a neutral title rather than an empty notification', () => {
    const payload = JSON.parse(
      buildAttentionPayload({ sessionId: 's', sessionName: '   ', state: 'waiting', machineId: 'm' }),
    ) as { title: string };
    expect(payload.title).toBe('A session');
  });

  test('truncates a very long name so the sealed record stays in budget', () => {
    const payload = JSON.parse(
      buildAttentionPayload({ sessionId: 's', sessionName: 'n'.repeat(500), state: 'waiting', machineId: 'm' }),
    ) as { title: string };
    expect(payload.title.length).toBe(MAX_NAME_LENGTH);
  });

  test('a name full of emoji seals inside one record, with no half-characters', () => {
    const device = makeSubscription('d1');
    const message = plan({
      subs: [device.sub],
      event: { sessionId: 's', sessionName: '🛰️'.repeat(200), state: 'waiting' },
    });
    expect(Buffer.from(message!.items[0]!.body, 'base64').length).toBeLessThanOrEqual(4096);
    // Truncating mid-surrogate would leave an UNPAIRED half here, which renders
    // as a replacement glyph on a lock screen. Matched pairs are fine — that is
    // simply what an emoji is.
    const title = device.open(message!.items[0]!.body).title as string;
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(title)).toBe(false);
    expect(title).toBe([...'🛰️'.repeat(200)].slice(0, MAX_NAME_LENGTH).join(''));
  });
});
