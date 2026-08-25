/* Root-scoped worker: exists so the client installs as an app, shows a
 * branded page when the relay is unreachable, and receives web push.
 * The terminal is live data — nothing under /api, /auth or /ws is ever
 * cached or answered from here. */

/* Bumped whenever this file changes. The cache NAME is the only thing keeping
 * one worker's entries out of another's — `activate` deletes every key that is
 * not this one — so a change here without a bump leaves the previous worker's
 * shell in place. */
const CACHE = 'bodhi-shell-v2';
const SHELL = ['/', '/app/main.js', '/app/main.css', '/offline.html'];

/* No skipWaiting() and no clients.claim(): an open page may be driving a
 * live terminal session, and swapping its controlling worker mid-use is the
 * one thing an update must never do. A new worker waits until every tab has
 * closed and takes over on the next launch. */

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
});

/* Network-first, and only for navigations and the precached shell — every
 * other request falls through to the network untouched. */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          /* Only cache a real answer. Writing unconditionally meant a transient
           * 502 from a proxy, or a 404 during a deploy, could be stored and
           * then served back as the app shell long after the relay recovered. */
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
          }
          return res;
        })
        .catch(() => caches.match(url.pathname)),
    );
  }
});

/* --- web push ---
 * The payload arrives encrypted end-to-end from the agent, so the session name
 * below was never visible to the relay. Shape comes from `buildAttentionPayload`
 * in `src/main/api/relay/push-attention.ts` — keep the two in step. */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = (event.data && event.data.json()) || {};
  } catch (err) {
    /* A push we cannot parse still has to show something: the platform kills a
     * worker that takes a `push` event and shows no notification, and repeated
     * offences cost the site its permission. */
    data = {};
  }

  const title = typeof data.title === 'string' && data.title ? data.title : 'A session needs you';
  const body = typeof data.body === 'string' && data.body ? data.body : 'Open Bodhilander to take a look.';
  const machineId = typeof data.machineId === 'string' ? data.machineId : null;
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      /* Tagged per session so a newer alert REPLACES the older one for the same
       * terminal instead of stacking; renotify so the replacement still buzzes,
       * which is the whole point of being told twice. */
      tag: typeof data.tag === 'string' && data.tag ? data.tag : 'bodhi-attention',
      renotify: true,
      data: { machineId: machineId, sessionId: sessionId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.machineId ? '/?m=' + encodeURIComponent(data.machineId) : '/';
  event.waitUntil(openClient(url));
});

/* Focus a window that is already open rather than piling up tabs, and steer it
 * at the right machine. `navigate` is not everywhere, and can reject on a
 * client this worker does not control, so every failure falls through to
 * opening a fresh window — which always works. */
function openClient(url) {
  return clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((windows) => {
      const open = windows.filter((w) => w.url && new URL(w.url).origin === self.location.origin)[0];
      if (!open) return clients.openWindow(url);
      return Promise.resolve(open.focus())
        .then((focused) => {
          const target = focused || open;
          return target.navigate ? target.navigate(url) : null;
        })
        .catch(() => clients.openWindow(url));
    })
    .catch(() => clients.openWindow(url));
}
