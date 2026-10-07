// Service Worker: App-Shell offline verfügbar machen.
// RELEASE bei jeder Änderung an der Web-App erhöhen (gleicher Wert wie APP_VERSION in app.js).
// Dadurch ändert sich diese Datei und alle Geräte laden die neue Version – auch wenn der
// Webserver die Dateien direkt ausliefert. Läuft die Auslieferung über Node, ersetzt der Server
// den Platzhalter BUILD zusätzlich durch einen Hash über alle Dateien.
const RELEASE = '1.1.0';
const BUILD = '__VERSION__';
const CACHE = `tt-${RELEASE}-${BUILD}`;
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
