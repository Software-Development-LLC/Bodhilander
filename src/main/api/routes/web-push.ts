/**
 * Web Push REST routes (BDHLNDR-49).
 *
 * Three endpoints:
 *   GET    /api/v1/web-push/public-key  — no auth, hands the VAPID public key
 *                                         to the PWA so it can subscribe.
 *   POST   /api/v1/web-push/subscribe   — auth-required, persists the browser
 *                                         PushSubscription under req.device.id.
 *   DELETE /api/v1/web-push/subscribe   — auth-required, deletes by endpoint
 *                                         (single) or by req.device.id (all).
 *
 * Router shape is the same as `pairing.ts` (per-route auth middleware) so
 * the open public-key route can sit next to the protected subscribe routes
 * without leaking auth into the public endpoint.
 */

import { Router, Request, Response } from 'express';
import log from 'electron-log';
import { PairingManager } from '../pairing/pairing-manager';
import { authenticateDevice } from '../middleware/auth';
import { getVapidKeys } from '../web-push/vapid';
import {
  createSubscription,
  deleteSubscriptionByEndpoint,
  deleteSubscriptionsForDevice,
} from '../../repositories/push-subscriptions';

export function createWebPushRouter(pairingManager: PairingManager): Router {
  const router = Router();
  const requireAuth = authenticateDevice(pairingManager);

  /**
   * GET /web-push/public-key — public, no auth required.
   *
   * The PWA needs this to call `pushManager.subscribe({ applicationServerKey })`
   * before it can POST a subscription back to us. Treated the same as
   * /pairing/initiate (also unauthenticated): localNetworkOnly already
   * gates access at the IP layer.
   */
  router.get('/public-key', (_req: Request, res: Response) => {
    try {
      const keys = getVapidKeys();
      res.json({ publicKey: keys.publicKey });
    } catch (err) {
      log.error('[WebPushAPI] Failed to load VAPID keys:', err);
      res.status(500).json({ error: 'Failed to load VAPID keys' });
    }
  });

  /**
   * POST /web-push/subscribe — auth required.
   *
   * Body: a browser `PushSubscription.toJSON()` shape:
   *   { endpoint: string, keys: { p256dh: string, auth: string } }
   *
   * Persists under the authenticated device. Re-subscribing from the same
   * browser overwrites the existing row (endpoint UNIQUE).
   */
  router.post('/subscribe', requireAuth, (req: Request, res: Response) => {
    try {
      if (!req.device) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const body = req.body as
        | { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
        | undefined;
      const endpoint = body?.endpoint;
      const p256dh = body?.keys?.p256dh;
      const authKey = body?.keys?.auth;

      if (
        typeof endpoint !== 'string' || !endpoint ||
        typeof p256dh !== 'string' || !p256dh ||
        typeof authKey !== 'string' || !authKey
      ) {
        res.status(400).json({
          error: 'Invalid subscription. Expected { endpoint, keys: { p256dh, auth } }',
        });
        return;
      }

      const sub = createSubscription(req.device.id, endpoint, p256dh, authKey);
      log.info(`[WebPushAPI] Subscription stored for device ${req.device.id}`);
      res.json({ success: true, id: sub.id, createdAt: sub.createdAt });
    } catch (err) {
      log.error('[WebPushAPI] Failed to store subscription:', err);
      res.status(500).json({ error: 'Failed to store subscription' });
    }
  });

  /**
   * DELETE /web-push/subscribe — auth required.
   *
   * Body: `{ endpoint?: string }`. If endpoint is present, delete just that
   * subscription. If absent, delete every subscription owned by the
   * authenticated device (used for "clean unsubscribe" on logout/unpair).
   */
  router.delete('/subscribe', requireAuth, (req: Request, res: Response) => {
    try {
      if (!req.device) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const body = req.body as { endpoint?: unknown } | undefined;
      const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : null;

      if (endpoint) {
        const removed = deleteSubscriptionByEndpoint(endpoint);
        res.json({ success: true, deleted: removed ? 1 : 0 });
        return;
      }

      const count = deleteSubscriptionsForDevice(req.device.id);
      res.json({ success: true, deleted: count });
    } catch (err) {
      log.error('[WebPushAPI] Failed to delete subscription:', err);
      res.status(500).json({ error: 'Failed to delete subscription' });
    }
  });

  return router;
}
