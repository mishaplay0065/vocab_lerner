const CACHE_NAME = 'vocab-app-v12';
const APP_FILES = [
  './',
  './index.html',
  './style.css?v=12',
  './InterVariable.woff2',
  './storage.js',
  './csv.js',
  './srs.js?v=12',
  './exercises.js',
  './app.js?v=12',
  './manifest.webmanifest',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith('vocab-app-') && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    )),
    self.clients.claim()
  ]));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;

  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
      }
      return response;
    }).catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(request) ||
        (request.mode === 'navigate' ? await cache.match('./index.html') : Response.error());
    })
  );
});
