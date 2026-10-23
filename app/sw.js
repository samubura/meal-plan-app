// App shell network-first (new deploys show up, cache when offline); CDN files (tesseract.js, its wasm core, fonts) stale-while-revalidate.
// Tesseract keeps the language data in IndexedDB itself, so after one scan it works offline.
const SHELL = 'shell-v19', CDN = 'cdn-v1';
const FILES = ['./', 'index.html', 'lib.js', 'ocr.js', 'gcal.js', 'gemini.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const MODELS = 'models-v1'; // models/ is cache-first: 8 MB, changes only with a new file name or MODELS bump

self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, CDN, MODELS].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.includes('/models/')) {
    e.respondWith(caches.open(MODELS).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; })));
  } else if (url.origin === location.origin) {
    // no-cache: ask the server every time (a cheap 304 when unchanged); Pages' 10-minute HTTP cache
    // would otherwise keep an old file after an update.
    e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  } else if (/^(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) {
    e.respondWith(caches.open(CDN).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch((err) => { if (hit) return hit; throw err; });
      return hit || net;
    }));
  }
});
