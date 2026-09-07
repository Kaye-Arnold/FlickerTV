/**
 * Flicker.TV — Service Worker
 *
 * Cache tiers:
 *   SHELL_CACHE   — the small offline application shell.
 *   POSTER_CACHE  — film artwork, stale-while-revalidate, bounded by LRU.
 *   RUNTIME_CACHE — pages, catalog data, and API responses, network-first.
 *
 * Video streams are deliberately excluded. Native media playback and
 * VideoCacheManager own stream buffering and blob lifetime respectively.
 */

const SW_VERSION = 'flicker-tv-v1.1.0';

const SHELL_CACHE = `${SW_VERSION}-shell`;
const POSTER_CACHE = `${SW_VERSION}-posters`;
const RUNTIME_CACHE = `${SW_VERSION}-runtime`;

// Only list files that are present in /public. Hashed Next assets are cached
// on first use by the shell route below, so the install cannot fail because a
// generated filename changed.
const SHELL_ASSETS = ['/', '/manifest.webmanifest'];

const POSTER_HOSTS = new Set([
  'image.tmdb.org',
  'upload.wikimedia.org',
]);

const CATALOG_HOSTS = new Set([
  'gist.githubusercontent.com',
  'raw.githubusercontent.com',
]);

const MAX_POSTER_ENTRIES = 200;
const MAX_RUNTIME_ENTRIES = 50;
const NETWORK_TIMEOUT_MS = 10_000;

function isArchiveMediaRequest(request, url) {
  const archiveHost =
    url.hostname === 'archive.org' ||
    url.hostname.endsWith('.archive.org') ||
    url.hostname === 'web.archive.org' ||
    url.hostname.endsWith('.web.archive.org');

  if (!archiveHost) return false;
  if (request.destination === 'video' || request.destination === 'audio') {
    return true;
  }

  return (
    url.pathname.includes('/download/') &&
    /\.(?:mp4|m3u8|m4s|ts|webm|ogv|mpeg)(?:$|[?#])/i.test(url.pathname + url.search)
  );
}

function isCatalogRequest(url) {
  return CATALOG_HOSTS.has(url.hostname);
}

// ---------------------------------------------------------------------------
// Install — pre-cache only the verified shell
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch((error) => {
        console.error('[Flicker SW] Shell pre-cache failed; install aborted:', error);
        throw error;
      })
  );
});

// ---------------------------------------------------------------------------
// Activate — prune stale caches from previous versions
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
// Fetch — route only requests this worker can improve
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // The media element and VideoCacheManager need the original stream response.
  if (isArchiveMediaRequest(request, url)) return;

  if (isCatalogRequest(url)) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE, MAX_RUNTIME_ENTRIES));
    return;
  }

  if (
    POSTER_HOSTS.has(url.hostname) ||
    (request.destination === 'image' && url.hostname.endsWith('.archive.org'))
  ) {
    event.respondWith(
      staleWhileRevalidate(request, POSTER_CACHE, MAX_POSTER_ENTRIES)
    );
    return;
  }

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

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE, MAX_RUNTIME_ENTRIES));
  }
});

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    await touch(cache, request, cached);
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) await store(cache, request, response);
    return response;
  } catch (error) {
    console.warn('[Flicker SW] Cache-first request failed:', error);
    return new Response('Offline', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}

async function staleWhileRevalidate(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        await store(cache, request, response);
        await trimCache(cache, maxEntries);
      }
      return response;
    })
    .catch((error) => {
      console.warn('[Flicker SW] Poster revalidation failed:', error);
      return null;
    });

  if (cached) {
    await touch(cache, request, cached);
    return cached;
  }

  return (
    (await networkFetch) ??
    new Response('Offline', { status: 503, statusText: 'Service Unavailable' })
  );
}

async function networkFirst(request, cacheName, maxEntries) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetchWithTimeout(request);
    if (response.ok) {
      await store(cache, request, response);
      await trimCache(cache, maxEntries);
    }
    return response;
  } catch (error) {
    console.warn('[Flicker SW] Network-first request failed:', error);
    const cached = await cache.match(request);
    if (cached) {
      await touch(cache, request, cached);
      return cached;
    }
    return new Response(
      JSON.stringify({
        error: 'Offline',
        message: 'No cached response available.',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

  return fetch(request, { signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

async function store(cache, request, response) {
  try {
    await cache.put(request, response.clone());
  } catch (error) {
    // A browser may reject an opaque or quota-limited response. Playback or
    // the network response remains usable; the cache simply stays unchanged.
    console.warn('[Flicker SW] Cache write skipped:', error);
  }
}

async function touch(cache, request, response) {
  // Cache API does not expose access timestamps. Delete/reinsert makes the
  // key order an access order for trimCache in browsers that preserve it.
  try {
    await cache.delete(request);
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn('[Flicker SW] Cache touch skipped:', error);
  }
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;

  const toDelete = keys.slice(0, keys.length - maxEntries);
  await Promise.all(
    toDelete.map((key) =>
      cache.delete(key).catch((error) => {
        console.warn('[Flicker SW] Cache eviction failed:', error);
        return false;
      })
    )
  );
}
