/**
 * Flicker.TV — Service Worker
 * Strategy: Cache-First for static assets, Network-First for API/stream URLs.
 *
 * Cache tiers:
 *   SHELL_CACHE   — App shell (HTML, JS, CSS, fonts, icons). Long-lived.
 *   POSTER_CACHE  — Film poster images. Stale-while-revalidate, 200-item LRU.
 *   RUNTIME_CACHE — API responses. Network-first with 10s timeout, 50-item LRU.
 *
 * Video streams (archive.org) are intentionally NOT cached in SW — the
 * VideoCacheManager in the main thread handles blob memory for those.
 */

const SW_VERSION = 'flicker-tv-v1.0.0';

const SHELL_CACHE   = `${SW_VERSION}-shell`;
const POSTER_CACHE  = `${SW_VERSION}-posters`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/apple-touch-icon.png',
];

const POSTER_ORIGINS = [
  'image.tmdb.org',
  'upload.wikimedia.org',
];

const STREAM_ORIGINS = [
  'archive.org',
  'ia800100.us.archive.org',
  'ia600100.us.archive.org',
  'ia400100.us.archive.org',
];

const MAX_POSTER_ENTRIES  = 200;
const MAX_RUNTIME_ENTRIES = 50;
const NETWORK_TIMEOUT_MS  = 10_000;

// ---------------------------------------------------------------------------
// Install — pre-cache shell assets
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) =>
        console.warn('[Flicker SW] Shell pre-cache failed:', err)
      )
  );
});

// ---------------------------------------------------------------------------
// Activate — prune stale caches from previous SW versions
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter(
              (name) =>
                name !== SHELL_CACHE &&
                name !== POSTER_CACHE &&
                name !== RUNTIME_CACHE
            )
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch — routing logic
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Never intercept non-GET requests.
  if (request.method !== 'GET') return;

  // 2. Never intercept video stream origins — let VideoCacheManager handle blobs.
  if (STREAM_ORIGINS.some((origin) => url.hostname.includes(origin))) {
    return; // fall through to browser default fetch
  }

  // 3. Poster images — stale-while-revalidate.
  if (POSTER_ORIGINS.some((origin) => url.hostname === origin)) {
    event.respondWith(staleWhileRevalidate(request, POSTER_CACHE, MAX_POSTER_ENTRIES));
    return;
  }

  // 4. App shell assets — cache-first.
  if (
    url.origin === self.location.origin &&
    (SHELL_ASSETS.includes(url.pathname) ||
      url.pathname.startsWith('/_next/static/') ||
      url.pathname.startsWith('/icons/') ||
      url.pathname.endsWith('.webmanifest'))
  ) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // 5. API calls (if any) — network-first with timeout fallback.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE, MAX_RUNTIME_ENTRIES));
    return;
  }

  // 6. Default: network-first for all other same-origin requests.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE, MAX_RUNTIME_ENTRIES));
  }
});

// ---------------------------------------------------------------------------
// Strategy: Cache-First
// ---------------------------------------------------------------------------

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

// ---------------------------------------------------------------------------
// Strategy: Stale-While-Revalidate with LRU eviction
// ---------------------------------------------------------------------------

async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(request, response.clone());
        await trimCache(cache, maxEntries);
      }
      return response;
    })
    .catch(() => null);

  return cached ?? (await networkFetch) ?? new Response('Offline', { status: 503 });
}

// ---------------------------------------------------------------------------
// Strategy: Network-First with timeout
// ---------------------------------------------------------------------------

async function networkFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Network timeout')), NETWORK_TIMEOUT_MS)
  );

  try {
    const response = await Promise.race([fetch(request), timeoutPromise]);
    if (response.ok) {
      await cache.put(request, response.clone());
      await trimCache(cache, maxEntries);
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'Offline', message: 'No cached response available.' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

// ---------------------------------------------------------------------------
// LRU eviction helper — trims cache to maxEntries by removing oldest first
// ---------------------------------------------------------------------------

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    const toDelete = keys.slice(0, keys.length - maxEntries);
    await Promise.all(toDelete.map((key) => cache.delete(key)));
  }
}