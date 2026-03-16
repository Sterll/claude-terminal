/**
 * Claude Terminal Remote — Service Worker
 * PWA with network-first strategy for automatic cache-busting on deploy.
 */

const CACHE_NAME = 'ct-remote-v10';
const STATIC_ASSETS = ['/', '/app.js', '/style.css', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Don't cache WebSocket upgrades or API requests
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api/')) return;

  // Network-first: always try fresh version, fall back to cache offline
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache the fresh response for offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
  );
});

// Listen for messages from the app to force-update
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// Handle notification click — bring app to foreground
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow('/');
    })
  );
});

// Future: handle push events from cloud relay
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'Claude Terminal', {
        body: data.body || '',
        tag: data.tag || 'ct-push',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: data.vibrate || [200, 100, 200],
      })
    );
  } catch (e) {}
});
