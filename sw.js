/* My Ireland — service worker
 *
 * Two caches, deliberately separate:
 *   SHELL  the app itself plus its icons and the Leaflet/font CDN assets.
 *          Precached on install so the app opens with no network at all.
 *   TILES  map tiles, cached as you browse and capped in size, so areas
 *          you've already looked at still render offline.
 *
 * Your journal data is NOT here — it lives in localStorage, untouched by
 * this file. Bump VERSION after editing index.html to push an update.
 */
const VERSION = 'v11';
const SHELL = `ireland-shell-${VERSION}`;
const TILES = `ireland-tiles-${VERSION}`;
const TILE_LIMIT = 600;

const SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  './robots.txt',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600&display=swap'
];

// Cache entries individually rather than via addAll, so one unreachable CDN
// asset can't abort the whole install and leave the app without a shell.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(SHELL_URLS.map(async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && (res.ok || res.type === 'opaque')) await cache.put(url, res);
      } catch (e) { /* offline or blocked at install time — fetched later */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k !== SHELL && k !== TILES)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isTile(url) {
  return /basemaps\.cartocdn\.com|tile\.openstreetmap\.org|\.png(\?|$)/i.test(url)
      && /\/\d+\/\d+\/\d+/.test(url);
}

// Keep the tile cache from growing without bound: trim oldest entries first.
async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map(k => cache.delete(k)));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = req.url;

  // Navigations: serve the cached app immediately, fall back to network.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html');
      if (cached) return cached;
      try { return await fetch(req); }
      catch (e) { return new Response('Offline and no cached copy available.', { status: 503 }); }
    })());
    return;
  }

  // Map tiles: cache-first, then network, storing what comes back.
  if (isTile(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) {
          await cache.put(req, res.clone());
          trimTiles();
        }
        return res;
      } catch (e) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // Everything else (app shell, CDN scripts, fonts): cache-first, and
  // refresh the stored copy in the background when the network allows.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req);
    if (hit) {
      fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res);
      }).catch(() => {});
      return hit;
    }
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) await cache.put(req, res.clone());
      return res;
    } catch (e) {
      return new Response('', { status: 504 });
    }
  })());
});
