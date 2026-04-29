/* ============================================================
   SERVICE WORKER — Driver Tracker PWA
   ============================================================
   Responsibilities:
     1. Cache the app shell on install (offline support)
     2. Serve cached assets on fetch (cache-first for shell,
        network-first for API/webhook calls)
     3. Update cache when a new version is deployed
     4. Claim all clients immediately on activation

   NOTE: The GPS watchPosition and location POSTs run in the
   main page context, NOT here. The service worker does NOT
   have access to navigator.geolocation. Its role is purely
   to make the app installable and available offline.
   ============================================================ */

const CACHE_NAME    = 'driver-tracker-v5';
const SHELL_ASSETS  = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icons/icon.svg',
];

/* ---- INSTALL: pre-cache the app shell ---- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => {
        console.log('[SW] App shell cached');
        // Activate immediately without waiting for old SW to be released
        return self.skipWaiting();
      })
  );
});

/* ---- ACTIVATE: delete old caches ---- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => self.clients.claim()) // Take control of all open tabs
  );
});

/* ---- FETCH: serve from cache or network ---- */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always go network for:
  //  - POST requests (webhook location pings)
  //  - Cross-origin requests (n8n API)
  //  - Anything not GET
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first: always try the network so updates land immediately.
  // Fall back to cache only when offline.
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
