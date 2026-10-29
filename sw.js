const CACHE_NAME = 'vocab-app-v22';
const APP_FILES = [
  './',
  './index.html',
  './style.css?v=22',
  './interface.css?v=22',
  './InterVariable.woff2',
  './storage.js?v=22',
  './csv.js?v=22',
  './srs.js?v=22',
  './exercises.js?v=22',
  './app.js?v=22',
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

  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);
    const cached=await cache.match(request) || (request.mode==='navigate' ? await cache.match('./index.html') : null);
    // Versioned assets are immutable within this cache; don't wait on mobile networks.
    if(cached && request.mode!=='navigate') return cached;
    const network=fetch(request).then(async response=>{
      if(response.ok) await cache.put(request,response.clone());
      return response;
    }).catch(()=>cached || Response.error());
    event.waitUntil(network.then(()=>{}));
    if(!cached) return network;
    let timer;
    const response=await Promise.race([network,new Promise(resolve=>{timer=setTimeout(()=>resolve(cached),1800);})]);
    clearTimeout(timer);return response;
  })());
});
