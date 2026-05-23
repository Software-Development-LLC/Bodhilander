/**
 * push_subscriptions repository (BDHLNDR-49).
 *
 * Web Push subscriptions persisted per paired device. The table itself is
 * declared in `database.ts:initializeTables`. This module is the only
 * supported interface for reading / writing it — the routes layer and the
 * state-monitor push hook both go through these helpers.
 *
 * Endpoint is the natural key (a browser-issued URL that's globally unique
 * per subscription), enforced by a UNIQUE index. createSubscription() does
 * an INSERT OR REPLACE so a re-subscribe from the same browser doesn't
 * accumulate stale rows.
 */

import { randomUUID } from 'crypto';
import { getDatabase } from '../database';

export interface PushSubscription {
  id: string;
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
}

interface PushSubscriptionRow {
  id: string;
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: number;
}

function rowToSub(row: PushSubscriptionRow): PushSubscription {
  return {
    id: row.id,
    deviceId: row.device_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at,
  };
}

/**
 * Insert (or replace by endpoint) a subscription owned by `deviceId`.
 * Returns the persisted row.
 *
 * Replace-by-endpoint behaviour: a single browser can only have one active
 * subscription per service-worker scope, so re-subscribing emits the same
 * endpoint and we want to overwrite rather than accumulate.
 */
export function createSubscription(
  deviceId: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): PushSubscription {
  const db = getDatabase();
  const id = randomUUID();
  const createdAt = Date.now();

  // INSERT OR REPLACE on UNIQUE(endpoint) — if the endpoint already exists
  // we keep the new id + device_id (re-pair on a different device could in
  // theory hand off the same browser, though unlikely in practice).
  db.prepare(
    `INSERT INTO push_subscriptions (id, device_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       id = excluded.id,
       device_id = excluded.device_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       created_at = excluded.created_at`,
  ).run(id, deviceId, endpoint, p256dh, auth, createdAt);

  // Read back so we return the post-conflict row state.
  const row = db
    .prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?')
    .get(endpoint) as PushSubscriptionRow;
  return rowToSub(row);
}

/**
 * All push subscriptions for a single paired device. Used by the per-device
 * unpair-cleanup path (BDHLNDR-67 follow-on) if/when wired in.
 */
export function getSubscriptionsForDevice(deviceId: string): PushSubscription[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM push_subscriptions WHERE device_id = ? ORDER BY created_at DESC')
    .all(deviceId) as PushSubscriptionRow[];
  return rows.map(rowToSub);
}

/**
 * Every subscription across every paired device. Used by the state-monitor
 * push fan-out — when a session needs attention we notify *all* registered
 * subscriptions, not just the device currently looking at the session.
 */
export function getAllSubscriptions(): PushSubscription[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM push_subscriptions ORDER BY created_at DESC')
    .all() as PushSubscriptionRow[];
  return rows.map(rowToSub);
}

/**
 * Remove a subscription by its endpoint URL. Called both:
 *   - explicitly from `DELETE /api/v1/web-push/subscribe` (user unsubscribed)
 *   - implicitly from the state-monitor push loop when web-push returns 410
 *     Gone (the browser garbage-collected the subscription)
 *
 * Returns true if a row was actually deleted, false if no match.
 */
export function deleteSubscriptionByEndpoint(endpoint: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
    .run(endpoint);
  return result.changes > 0;
}

/**
 * Drop every subscription owned by a device. Returns the count of removed
 * rows. Intended for unpair cleanup so a stale token can't be revived to
 * keep receiving pushes.
 */
export function deleteSubscriptionsForDevice(deviceId: string): number {
  const db = getDatabase();
  const result = db
    .prepare('DELETE FROM push_subscriptions WHERE device_id = ?')
    .run(deviceId);
  return result.changes;
}
