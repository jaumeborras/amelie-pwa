// Bump this on every deploy so the browser detects a new service worker
// (it compares this file byte-for-byte) and refreshes the cached files.
const CACHE_NAME = 'amelie-pwa-v15';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './video.js',
  './vendor/mp4box.all.min.js',
  './vendor/mp4-muxer.mjs',
  './worker.js',
  './Amelie.cube',
  './logo.png',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

// Network-first: while online, always serve the latest file and refresh the
// cache with it. Only fall back to the cached copy when there's no
// connection, so the app still works offline.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
