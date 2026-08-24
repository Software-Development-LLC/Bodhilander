/* Root-scoped worker: exists so the client installs as an app, shows a
 * branded page when the relay is unreachable, and (later) receives push.
 * The terminal is live data — nothing under /api, /auth or /ws is ever
 * cached or answered from here. */

const CACHE = 'bodhi-shell-v1';
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
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(req, copy)));
          return res;
        })
        .catch(() => caches.match(url.pathname)),
    );
  }
});
