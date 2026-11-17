// Service worker: makes the app installable, lets the shell open instantly,
// and shows push notifications. Game data is never cached here; /api and /ws
// always go to the network.
const VERSION = 'tavern-v2';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page tells us which build files it loaded before we took control.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'cache' || !Array.isArray(data.urls)) return;
  const urls = data.urls.filter((u) => typeof u === 'string' && u.startsWith('/assets/')).slice(0, 40);
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) =>
        Promise.all(
          urls.map((u) => cache.match(u).then((hit) => hit || cache.add(u).catch(() => undefined))),
        ),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/') || url.pathname === '/healthz')
    return;

  // Fingerprinted build output never changes: serve from cache, fill on first use.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((cache) => cache.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Pages: network first so a new deploy shows up, cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error())),
    );
    return;
  }

  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});

// ---------- push notifications ----------

/** The app badge counts what is waiting: one per campaign with news, since a campaign's notifications replace each other. */
async function updateBadge() {
  if (!self.navigator.setAppBadge) return;
  const shown = await self.registration.getNotifications();
  await (shown.length ? self.navigator.setAppBadge(shown.length) : self.navigator.clearAppBadge()).catch(
    () => undefined,
  );
}

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  // Every push must show something: Safari stops delivering to apps that stay quiet.
  event.waitUntil(
    self.registration
      .showNotification(data.title || 'Tavern Master', {
        body: data.body || '',
        tag: data.tag || 'tavern',
        // A replacement for a campaign's earlier notification still alerts.
        renotify: !!data.tag,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        timestamp: Date.now(),
        data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
      })
      .then(updateBadge),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        // The app routes itself, so the open page keeps its state instead of reloading.
        win.postMessage({ type: 'open', url: path });
        await win.focus().catch(() => undefined);
      } else {
        await self.clients.openWindow(path);
      }
      await updateBadge();
    })(),
  );
});

self.addEventListener('notificationclose', (event) => {
  event.waitUntil(updateBadge());
});

// Chrome and Firefox may swap a subscription for a new one; hand it to the
// server straight away. (Safari does not fire this; the app re-checks on launch.)
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const keyRes = await fetch('/api/notifications/key', { credentials: 'same-origin' });
      if (!keyRes.ok) return;
      const { publicKey } = await keyRes.json();
      const pad = '='.repeat((4 - (publicKey.length % 4)) % 4);
      const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
      const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      const meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const me = meRes.ok ? await meRes.json() : null;
      if (!me || !me.user) return;
      await fetch('/api/notifications/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.user.csrfToken },
        body: JSON.stringify(sub.toJSON()),
      });
    })().catch(() => undefined),
  );
});
