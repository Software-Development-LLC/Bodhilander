/**
 * What a push notification says, and how often it is allowed to say it. Pure
 * like `push-seal.ts`, so the debounce runs on a fake clock, not a sleep.
 */

// The window mirrors the LAN dispatcher (`api/web-push/dispatcher.ts`): per
// session AND state, 30s, oldest-first eviction. Sessions really do flap
// between waiting and working mid-stream, and two paths disagreeing about
// that gets reported as "notifications are broken", not as a race.

import { sealWebPushPayload, type RelayPushSubscription } from './push-seal';

export type AttentionState = 'waiting' | 'error';

/** Matches the LAN dispatcher. See the module header before changing it. */
export const ATTENTION_DEBOUNCE_MS = 30_000;

/** Soft cap on the in-memory window map; eviction drops the oldest entry. */
export const MAX_DEBOUNCE_ENTRIES = 256;

/**
 * How much of a session name travels. Long enough for any name a person
 * actually types, short enough that the sealed record stays comfortably inside
 * the 4096-octet push limit whatever someone names a session.
 */
export const MAX_NAME_LENGTH = 80;

export interface AttentionGate {
  /** Whether this transition should produce a push right now. */
  allow(sessionId: string, state: AttentionState): boolean;
  /** Forget every window — used when the relay connection is torn down. */
  clear(): void;
}

export function createAttentionGate(now: () => number = Date.now): AttentionGate {
  /** `sessionId:state` → when it last got through. */
  const lastAt = new Map<string, number>();

  return {
    allow(sessionId, state) {
      const key = `${sessionId}:${state}`;
      const previous = lastAt.get(key);
      const ts = now();
      if (previous !== undefined && ts - previous < ATTENTION_DEBOUNCE_MS) return false;

      if (lastAt.size >= MAX_DEBOUNCE_ENTRIES) {
        // Map iteration is insertion order, so the first key is the oldest.
        const oldest = lastAt.keys().next().value;
        if (oldest !== undefined) lastAt.delete(oldest);
      }
      // Delete before set so the entry moves to the tail and the eviction
      // policy above stays a true oldest-first.
      lastAt.delete(key);
      lastAt.set(key, ts);
      return true;
    },

    clear() {
      lastAt.clear();
    },
  };
}

export interface AttentionPayloadInput {
  sessionId: string;
  sessionName: string;
  state: AttentionState;
  /** So a tap can open the client on the right machine. */
  machineId: string;
}

/**
 * The JSON the service worker reads out of a decrypted push. The session NAME
 * is in here, which is the entire reason the agent seals it rather than asking
 * the relay to compose it. Keep in step with the `push` handler in `sw.js`.
 */
export function buildAttentionPayload(input: AttentionPayloadInput): string {
  // Sliced by CODE POINT, not by UTF-16 unit: cutting an emoji in half leaves a
  // lone surrogate in the JSON and a replacement glyph on the lock screen.
  const name = [...input.sessionName.trim()].slice(0, MAX_NAME_LENGTH).join('') || 'A session';
  return JSON.stringify({
    title: name,
    body: input.state === 'error' ? 'Hit an error and is waiting' : 'Waiting for your input',
    // Tagged by session so a newer alert replaces an older one for the same
    // terminal rather than stacking up on the lock screen.
    tag: input.sessionId,
    machineId: input.machineId,
    sessionId: input.sessionId,
  });
}

export interface AttentionEvent {
  sessionId: string;
  sessionName: string;
  state: AttentionState;
}

export interface PushSendMessage {
  type: 'push:send';
  items: Array<{ id: string; body: string }>;
}

export interface PlanAttentionPushInput {
  /** Whether the relay socket is up. Nothing is queued while it is not. */
  connected: boolean;
  /** This machine's relay id; null before the machine has been linked. */
  machineId: string | null;
  subs: readonly RelayPushSubscription[];
  gate: AttentionGate;
  event: AttentionEvent;
  /** One unusable subscription is logged, never fatal. */
  onSealError?: (err: unknown) => void;
}

/**
 * Decide whether a state change becomes a push; null when it should not. The
 * whole trigger lives here rather than in `RelayClient`, so the parts that can
 * be wrong need no Electron app, socket or PTY to exercise.
 */
export function planAttentionPush(input: PlanAttentionPushInput): PushSendMessage | null {
  const { connected, machineId, subs, gate, event } = input;
  if (!connected || !machineId || subs.length === 0) return null;
  if (!gate.allow(event.sessionId, event.state)) return null;

  const payload = buildAttentionPayload({ ...event, machineId });
  const items: PushSendMessage['items'] = [];
  for (const sub of subs) {
    try {
      items.push({ id: sub.id, body: sealWebPushPayload(sub, payload).toString('base64') });
    } catch (err) {
      // A subscription we cannot seal to must not silence the others. The relay
      // reaps a genuinely dead one on its next 410; nothing here should try to.
      input.onSealError?.(err);
    }
  }
  return items.length > 0 ? { type: 'push:send', items } : null;
}
