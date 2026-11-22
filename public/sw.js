/*
 * Zeiterfassung – Service Worker
 * Hält die App-Dateien vor, damit die App auch ohne Netz startet.
 * Daten (/api/...) gehen immer direkt an den Server.
 */
'use strict';
const CACHE = 'zeiterfassung-v3';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/logic.js',
  'js/api.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Zuerst das Netz (damit Updates sofort ankommen), nach 4 Sekunden oder ohne Netz der Zwischenspeicher
self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  ev.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch (_) { /* offline */ }
    const cached = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('index.html'));
    return cached || network;
  })());
});

// Mitteilungen vom Server (Erinnerung ans Ausstempeln, Warnungen zur Baustelle)
self.addEventListener('push', (ev) => {
  let data = {};
  try {
    data = ev.data ? ev.data.json() : {};
  } catch (_) {
    data = { body: ev.data ? ev.data.text() : '' };
  }
  ev.waitUntil(self.registration.showNotification(data.title || 'Zeiterfassung', {
    body: data.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || './#heute' },
  }));
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const url = new URL((ev.notification.data && ev.notification.data.url) || './', self.registration.scope).href;
  ev.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        try { await w.navigate(url); } catch (_) { /* fremde Seite */ }
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
