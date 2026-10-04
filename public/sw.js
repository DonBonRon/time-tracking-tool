// Service Worker: App-Shell offline verfügbar machen.
// Der Platzhalter für VERSION wird vom Server durch einen Hash über alle Dateien ersetzt,
// dadurch wird nach jedem Update automatisch neu gecacht.
const VERSION = '__VERSION__';
const CACHE = `tt-${VERSION}`;
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'store.js', 'shared/core.js',
  'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req.mode === 'navigate' ? 'index.html' : req, { ignoreSearch: true });
    if (cached) return cached;
    return fetch(req);
  })());
});
