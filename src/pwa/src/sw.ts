/// <reference lib="webworker" />
/**
 * Bodhilander mobile-companion service worker (BDHLNDR-49).
 *
 * Owns:
 *   - workbox precache + runtime caching previously expressed inline in
 *     `vite.config.ts` under `strategies: 'generateSW'`. We switched to
 *     `injectManifest` so we can add the push handlers below; the workbox
 *     cache config is re-expressed here in TS.
 *   - `push` and `notificationclick` listeners for Web Push (the whole
 *     reason this file exists). Payload contract is set by the desktop
 *     dispatcher in `src/main/api/web-push/dispatcher.ts` — keep in sync.
 *
 * Loaded at /m/sw.js with scope /m/ (see vite.config.ts header for the
 * routing contract).
 */

import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// ---------------------------------------------------------------------------
// Precache (app shell) — populated by vite-plugin-pwa from injectManifest's
// globPatterns. This is the equivalent of the previous generateSW behaviour.
// ---------------------------------------------------------------------------
precacheAndRoute(self.__WB_MANIFEST);

// Client-side routing fallback: serve the SPA shell for unmatched /m/
// navigations so deep links + hard refreshes work offline once cached.
registerRoute(
  new NavigationRoute(
    async () => {
      const cache = await caches.match('/m/index.html');
      return cache ?? fetch('/m/index.html');
    },
    {
      denylist: [/^\/api\//],
    },
  ),
);

// REST API — NetworkFirst with a short timeout so the PWA stays responsive
// on flaky links. 24h expiration is a loose upper bound.
registerRoute(
  /\/api\/.*/i,
  new NetworkFirst({
    cacheName: 'bodhilander-api',
    networkTimeoutSeconds: 5,
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 }),
    ],
  }),
);

// Hashed bundle assets — CacheFirst is safe (content-hashed filenames).
registerRoute(
  /\/m\/assets\/.*/i,
  new CacheFirst({
    cacheName: 'bodhilander-assets',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 }),
    ],
  }),
);

// ---------------------------------------------------------------------------
// Web Push (BDHLNDR-49)
// ---------------------------------------------------------------------------

/**
 * Payload contract from the desktop dispatcher. Keep in sync with
 * `src/main/api/web-push/dispatcher.ts:buildPayload`. All fields optional
 * here so a malformed push doesn't crash the handler.
 */
interface PushPayload {
  title?: string;
  body?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: {
    sessionId?: string;
    url?: string;
  };
}

self.addEventListener('push', (event: PushEvent) => {
  // Empty pushes (some browsers send wake-up pushes with no payload) — fall
  // back to a generic notice so the SW still surfaces *something* visible.
  // Browsers that enforce `userVisibleOnly: true` will display a default
  // notification anyway if we don't, so we'd rather control the wording.
  let data: PushPayload = {};
  try {
    data = (event.data?.json() as PushPayload) ?? {};
  } catch {
    data = { title: 'Bodhilander', body: 'Update available' };
  }

  const title = data.title || 'Bodhilander';
  const options: NotificationOptions = {
    body: data.body ?? '',
    icon: data.icon ?? '/m/icons/icon-192.png',
    badge: data.badge ?? '/m/icons/icon-192.png',
    tag: data.tag,
    data: data.data ?? {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();

  const data = (event.notification.data ?? {}) as PushPayload['data'];
  const url = data?.url ?? '/m/sessions';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // If a window is already on the target route (or its container),
      // focus it instead of opening a new one.
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.pathname.startsWith(url) && 'focus' in client) {
            return client.focus();
          }
        } catch {
          // Non-URL clients (rare) — fall through to openWindow.
        }
      }
      // Otherwise fall back to focusing any open client at /m/, navigating
      // it in-place, before resorting to a fresh window.
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.pathname.startsWith('/m/') && 'navigate' in client) {
            await client.navigate(url);
            return client.focus();
          }
        } catch {
          // ignore
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
      return undefined;
    })(),
  );
});

// BDHLNDR-74: take over open clients as soon as a new SW activates, so
// users don't have to close + reopen the PWA to pick up a bug fix. Without
// these two hooks, `registerType: 'autoUpdate'` only swaps the SW after the
// last client tab unloads — which most users never do. Symptom we hit:
// BDHLNDR-70 send fix (CR instead of LF) shipped, but PWAs installed on a
// prior build kept running cached old JS that used LF.
self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Manual SKIP_WAITING channel kept for completeness (vite-plugin-pwa's
// register snippet can call it when prompting users to refresh).
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});
