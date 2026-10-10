const CACHE = 'perkfection-v3';
const SHELL = ['./', './index.html', './ledger-math.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

// Only the app shell and the static libraries it loads are worth caching. Firestore's
// long-polling channel and auth endpoints are live streams, not assets — caching them
// would be wasteful at best and could serve a stale channel response at worst.
const CACHEABLE_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
function isCacheable(url) {
  return url.origin === self.location.origin || CACHEABLE_HOSTS.includes(url.hostname);
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first: always prefer the live version (this app talks to Firestore in real
// time); fall back to the last cached copy only when the network fails.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (!isCacheable(url)) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.status === 200 && res.type !== 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: url.origin === self.location.origin }).then((hit) => hit || Response.error()))
  );
});

// Push reminders, sent by scripts/send-reminders.mjs. The payload is JSON:
// { title, body, url, tag } — tag collapses repeat reminders into one notification.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'Credits expiring soon';
  const options = {
    body: data.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: data.tag || 'perkfection-expiring',
    renotify: true,
    data: { url: data.url || './' },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url ? e.notification.data.url : './', self.location.href).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const existing = wins.find((w) => w.url.startsWith(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(target);
    })
  );
});
