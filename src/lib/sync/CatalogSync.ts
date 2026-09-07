/**
 * Flicker.TV — Catalog Sync (Consumption Layer)
 *
 * Singleton fetcher that pulls the compiled CinemaCard catalog from the
 * GitHub Gist oracle produced by scripts/ingest.ts and caches it locally
 * with a 1-hour TTL to prevent redundant network requests on every app boot.
 *
 * Cache architecture:
 *   L1 — In-memory (process lifetime, fastest):
 *        Served for all requests within the same browser session.
 *        Invalidated on explicit refresh() call or TTL expiry.
 *
 *   L2 — localStorage (survives page reload, survives iOS Safari ITP within
 *        the 7-day window):
 *        Stores { catalog: CatalogGist, cachedAt: number }.
 *        Read on cold start before any network request.
 *        Written after every successful Gist fetch.
 *        TTL: 1 hour. Stale entries trigger a background revalidation.
 *
 *   L3 — Service Worker runtime cache (network-first, 10s timeout):
 *        Defined in public/sw.js. Handles offline and degraded network.
 *        Operates transparently below this module.
 *
 * Environment variable:
 *   NEXT_PUBLIC_GIST_CATALOG_URL
 *     Full raw URL of the catalog.min.json Gist file, e.g.:
 *     https://gist.githubusercontent.com/{user}/{id}/raw/catalog.min.json
 *     If absent, CatalogSync returns the local seed reel as a fallback.
 */

import type { CinemaCard, CatalogGist } from '@/types/schema';
import type { CinemaCard as FeedCard }  from '@/components/Feed/SwiperFeed';
import { SEED_REEL }                    from '@/lib/data/seedReel';
import { validateCatalogPayload }       from '@/lib/catalog/validateCatalog';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIST_URL         = process.env['NEXT_PUBLIC_GIST_CATALOG_URL'] ?? '';
const CACHE_KEY        = 'flicker:catalog:v1';
const TTL_MS           = 60 * 60 * 1000;   // 1 hour
const FETCH_TIMEOUT_MS = 15_000;
const SCHEMA_VERSION   = '1.0.0';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CatalogSource = 'gist' | 'localStorage' | 'memory' | 'seed';

export interface CatalogSyncResult {
  cards:           FeedCard[];
  rawCatalog:      CatalogGist | null;
  source:          CatalogSource;
  cachedAt:        number | null;
  totalItems:      number;
  isStale:         boolean;
  streamBreakdown: { hls: number; mp4: number };
}

// ---------------------------------------------------------------------------
// localStorage cache shape
// ---------------------------------------------------------------------------

interface StoredCache {
  catalog:  CatalogGist;
  cachedAt: number;
}

// ---------------------------------------------------------------------------
// In-memory L1 cache
// ---------------------------------------------------------------------------

interface MemoryCache {
  catalog:  CatalogGist;
  cachedAt: number;
}

let _memoryCache: MemoryCache | null = null;

// ---------------------------------------------------------------------------
// localStorage helpers (graceful — never throws)
// ---------------------------------------------------------------------------

function readLocalStorageCache(): StoredCache | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as {
      catalog?: unknown;
      cachedAt?: unknown;
    };
    if (
      typeof parsed.cachedAt !== 'number' ||
      !Number.isFinite(parsed.cachedAt) ||
      parsed.cachedAt < 0
    ) {
      throw new Error('[CatalogSync] Stored cache timestamp is invalid.');
    }

    return {
      catalog: validateCatalogPayload(parsed.catalog),
      cachedAt: parsed.cachedAt,
    };
  } catch (error: unknown) {
    console.warn('[CatalogSync] Discarding invalid local catalog cache:', error);
    clearLocalStorageCache();
    return null;
  }
}

function writeLocalStorageCache(catalog: CatalogGist): void {
  if (typeof window === 'undefined') return;
  try {
    const entry: StoredCache = { catalog, cachedAt: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch (error: unknown) {
    // Storage quota exceeded or private browsing — network data remains usable.
    console.warn('[CatalogSync] Could not persist catalog cache:', error);
  }
}

function clearLocalStorageCache(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch (error: unknown) {
    console.warn('[CatalogSync] Could not clear the local catalog cache:', error);
  }
}

// ---------------------------------------------------------------------------
// Schema version guard
// ---------------------------------------------------------------------------

function isCatalogValid(catalog: CatalogGist): boolean {
  return (
    catalog.schemaVersion === SCHEMA_VERSION &&
    Array.isArray(catalog.catalog) &&
    catalog.catalog.length > 0
  );
}

// ---------------------------------------------------------------------------
// Schema conversion: ingestion CinemaCard → feed CinemaCard
// ---------------------------------------------------------------------------

/**
 * Converts the ingestion schema (src/types/schema.ts) to the feed component
 * schema (src/components/Feed/SwiperFeed.tsx).
 *
 * The streamType discriminator is preserved as a tag on the trailerUrl
 * so the player layer can detect it:
 *   .m3u8 suffix → CinemaPlayer activates HLS path
 *   .mp4  suffix → CinemaPlayer uses HTTP Range fetch path
 */
function toFeedCard(card: CinemaCard): FeedCard {
  return {
    tmdbId:         card.id,
    movieTitle:     card.title,
    releaseYear:    parseYear(card.metadata.year),
    directorName:   card.metadata.director ?? 'Unknown',
    synopsis:       card.description || card.title,
    trailerUrl:     card.streamUrl,
    streamType:     card.streamType,
    posterWebpUrl:  card.posterUrl,
    backdropUrl:    card.posterUrl,
    runtimeMinutes: card.duration ? Math.round(card.duration / 60) : 60,
    genres:         inferGenres(card),
    archiveOrgUrl:  `https://archive.org/details/${encodeURIComponent(card.id)}`,
    rating:         undefined,
  };
}

function parseYear(year: string | undefined): number {
  if (!year) return 1920;
  const n = parseInt(year, 10);
  return isNaN(n) ? 1920 : n;
}

function inferGenres(card: CinemaCard): string[] {
  const text   = `${card.id} ${card.title}`.toLowerCase();
  const genres: string[] = [];

  const matchers: Array<[RegExp, string]> = [
    [/horror|nosferatu|dracula|frankenstein|phantom|vampire|mummy|ghost|haunted/i, 'Horror'],
    [/scifi|sci[-_]fi|science.fiction|metropolis|robot|space|alien|fantasy/i,     'Sci-Fi'],
    [/comedy|chaplin|keaton|lloyd|laurel|hardy|slapstick|funny|laugh/i,           'Comedy'],
    [/western|cowboy|outlaw|sheriff|saloon|frontier/i,                            'Western'],
    [/documentary|newsreel|historical|archive|prelinger/i,                        'Documentary'],
    [/cartoon|animation|animated|felix|fleischer/i,                               'Animation'],
    [/romance|melodrama/i,                                                         'Drama'],
    [/adventure|serial|detective|mystery|crime/i,                                 'Adventure'],
    [/war|military|battle|soldier/i,                                              'War'],
  ];

  for (const [pattern, genre] of matchers) {
    if (pattern.test(text) && !genres.includes(genre)) genres.push(genre);
    if (genres.length >= 3) break;
  }

  if (genres.length < 2) genres.push('Classic');

  if (parseYear(card.metadata.year) < 1930 && !genres.includes('Silent')) {
    if (genres.length < 3) genres.push('Silent');
  }

  return genres.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Stream breakdown counter
// ---------------------------------------------------------------------------

function countStreams(catalog: CatalogGist): { hls: number; mp4: number } {
  let hls = 0;
  let mp4 = 0;
  for (const c of catalog.catalog) {
    if (c.streamType === 'hls') hls++;
    else                        mp4++;
  }
  return { hls, mp4 };
}

// ---------------------------------------------------------------------------
// Gist fetcher
// ---------------------------------------------------------------------------

async function fetchGist(signal?: AbortSignal): Promise<CatalogGist> {
  if (!GIST_URL) {
    throw new Error('[CatalogSync] NEXT_PUBLIC_GIST_CATALOG_URL is not configured.');
  }

  const response = await fetch(GIST_URL, {
    cache:  'no-cache',
    signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'Accept':     'application/json',
      'User-Agent': 'Flicker.TV-Client/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(
      `[CatalogSync] Gist fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json() as unknown;
  const catalog = validateCatalogPayload(data);

  if (!isCatalogValid(catalog)) {
    throw new Error(
      `[CatalogSync] Schema version mismatch: expected ${SCHEMA_VERSION}, ` +
        `got ${catalog.schemaVersion}. Update the client.`
    );
  }

  return catalog;
}

// ---------------------------------------------------------------------------
// Background revalidation
// ---------------------------------------------------------------------------

let _revalidating = false;

function revalidateInBackground(): void {
  if (_revalidating || !GIST_URL) return;
  _revalidating = true;

  fetchGist()
    .then((catalog) => {
      _memoryCache = { catalog, cachedAt: Date.now() };
      writeLocalStorageCache(catalog);
    })
    .catch(() => {
      // Background failure is silent — stale cache continues serving.
    })
    .finally(() => {
      _revalidating = false;
    });
}

// ---------------------------------------------------------------------------
// Public API: fetch catalog
// ---------------------------------------------------------------------------

/**
 * Fetch the compiled catalog and return it as feed-ready CinemaCards.
 *
 * Resolution order:
 *   1. L1 memory cache — if present and within TTL.
 *   2. L2 localStorage cache — if present and within TTL; triggers background
 *      revalidation if stale but still serves the stale data immediately.
 *   3. Gist network fetch — on cache miss or forceRefresh.
 *   4. Seed reel — if GIST_URL is not configured or all fetches fail.
 */
export async function fetchCatalog(options: {
  forceRefresh?: boolean;
  limit?:        number;
  signal?:       AbortSignal;
} = {}): Promise<CatalogSyncResult> {
  const { forceRefresh = false, limit, signal } = options;

  if (!GIST_URL) {
    return buildSeedResult();
  }

  // ── L1: Memory cache ──────────────────────────────────────────────────────
  if (!forceRefresh && _memoryCache) {
    const ageMs  = Date.now() - _memoryCache.cachedAt;
    const isStale = ageMs >= TTL_MS;

    if (!isStale) {
      return buildResult(_memoryCache.catalog, _memoryCache.cachedAt, 'memory', limit);
    }

    // Stale: serve immediately, revalidate in background.
    revalidateInBackground();
    return buildResult(_memoryCache.catalog, _memoryCache.cachedAt, 'memory', limit, true);
  }

  // ── L2: localStorage cache ────────────────────────────────────────────────
  if (!forceRefresh) {
    const stored = readLocalStorageCache();
    if (stored) {
      const ageMs  = Date.now() - stored.cachedAt;
      const isStale = ageMs >= TTL_MS;

      // Populate L1 from L2.
      _memoryCache = { catalog: stored.catalog, cachedAt: stored.cachedAt };

      if (!isStale) {
        return buildResult(stored.catalog, stored.cachedAt, 'localStorage', limit);
      }

      // Stale: serve immediately, revalidate in background.
      revalidateInBackground();
      return buildResult(stored.catalog, stored.cachedAt, 'localStorage', limit, true);
    }
  }

  // ── L3: Network fetch ─────────────────────────────────────────────────────
  try {
    const catalog = await fetchGist(signal);
    const now     = Date.now();

    _memoryCache  = { catalog, cachedAt: now };
    writeLocalStorageCache(catalog);

    return buildResult(catalog, now, 'gist', limit);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error('[CatalogSync] Network fetch failed:', err);

    // Serve whatever we have — stale cache or seed reel.
    if (_memoryCache) {
      return buildResult(_memoryCache.catalog, _memoryCache.cachedAt, 'memory', limit, true);
    }

    const stored = readLocalStorageCache();
    if (stored) {
      _memoryCache = { catalog: stored.catalog, cachedAt: stored.cachedAt };
      return buildResult(stored.catalog, stored.cachedAt, 'localStorage', limit, true);
    }

    return buildSeedResult();
  }
}

function buildResult(
  catalog:  CatalogGist,
  cachedAt: number,
  source:   CatalogSource,
  limit?:   number,
  isStale   = false
): CatalogSyncResult {
  const allCards = catalog.catalog
    .filter((c) => Boolean(c.id) && Boolean(c.streamUrl))
    .map(toFeedCard);

  const cards = limit ? allCards.slice(0, limit) : allCards;

  return {
    cards,
    rawCatalog:      catalog,
    source,
    cachedAt,
    totalItems:      catalog.totalItems,
    isStale,
    streamBreakdown: countStreams(catalog),
  };
}

function buildSeedResult(): CatalogSyncResult {
  return {
    cards:           SEED_REEL,
    rawCatalog:      null,
    source:          'seed',
    cachedAt:        null,
    totalItems:      SEED_REEL.length,
    isStale:         false,
    streamBreakdown: { hls: 0, mp4: SEED_REEL.length },
  };
}

// ---------------------------------------------------------------------------
// Public API: pagination
// ---------------------------------------------------------------------------

export async function fetchCatalogPage(
  page:     number = 1,
  pageSize: number = 10
): Promise<{ cards: FeedCard[]; hasMore: boolean; totalItems: number }> {
  const result = await fetchCatalog();
  const start  = (page - 1) * pageSize;
  const slice  = result.cards.slice(start, start + pageSize);

  return {
    cards:      slice,
    hasMore:    start + pageSize < result.cards.length,
    totalItems: result.cards.length,
  };
}

// ---------------------------------------------------------------------------
// Public API: cache management
// ---------------------------------------------------------------------------

/** Force-invalidate both L1 and L2 caches. */
export function invalidateCatalogCache(): void {
  _memoryCache = null;
  clearLocalStorageCache();
}

/** Returns current cache diagnostics without triggering a fetch. */
export function getCatalogCacheInfo(): {
  isCached:   boolean;
  source:     'memory' | 'localStorage' | 'none';
  ageMs:      number | null;
  isStale:    boolean;
  totalItems: number | null;
} {
  if (_memoryCache) {
    const ageMs = Date.now() - _memoryCache.cachedAt;
    return {
      isCached:   true,
      source:     'memory',
      ageMs,
      isStale:    ageMs >= TTL_MS,
      totalItems: _memoryCache.catalog.totalItems,
    };
  }

  const stored = readLocalStorageCache();
  if (stored) {
    const ageMs = Date.now() - stored.cachedAt;
    return {
      isCached:   true,
      source:     'localStorage',
      ageMs,
      isStale:    ageMs >= TTL_MS,
      totalItems: stored.catalog.totalItems,
    };
  }

  return { isCached: false, source: 'none', ageMs: null, isStale: false, totalItems: null };
}