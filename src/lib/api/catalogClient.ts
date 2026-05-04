/**
 * Flicker.TV — Gist Catalog Client
 *
 * Fetches the compiled CinemaCard catalog from the GitHub Gist oracle
 * produced by the Phase 3 ingestion pipeline (scripts/ingest.ts).
 *
 * Integration contract:
 *   - The Gist contains two files: `catalog.json` (pretty) and
 *     `catalog.min.json` (minified). This client fetches the minified
 *     version for production use to reduce parse time.
 *   - The catalog schema is defined in src/types/schema.ts.
 *   - Results are converted from the ingestion CinemaCard schema to the
 *     feed CinemaCard schema (src/components/Feed/SwiperFeed.tsx) so the
 *     existing Swiper feed, VideoCacheManager, and P2P layer require
 *     zero modification.
 *
 * Caching strategy:
 *   - In-memory LRU: one catalog per session, keyed to `gistId`.
 *   - Browser: uses the Fetch API's built-in HTTP cache (ETag / Last-Modified).
 *   - Service Worker: catalog.min.json is handled by the runtime-first SW
 *     cache (50-item LRU, 10s timeout) defined in public/sw.js.
 *   - Stale threshold: 6 hours. After that, a background revalidation is
 *     triggered even if the in-memory cache has a hit.
 *
 * Environment variable (Next.js public):
 *   NEXT_PUBLIC_GIST_CATALOG_URL
 *     Full raw URL of the catalog.min.json Gist file.
 *     e.g. https://gist.githubusercontent.com/{user}/{gist_id}/raw/catalog.min.json
 *     If absent, falls back to the seed reel from src/lib/data/seedReel.ts.
 */

import type {
  CinemaCard as IngestCinemaCard,
  CatalogGist,
  StreamType,
} from '@/types/schema';
import type { CinemaCard as FeedCinemaCard } from '@/components/Feed/SwiperFeed';
import { SEED_REEL } from '@/lib/data/seedReel';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIST_CATALOG_URL =
  process.env['NEXT_PUBLIC_GIST_CATALOG_URL'] ?? '';

const CACHE_STALE_MS  = 6 * 60 * 60 * 1000;   // 6 hours
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// In-memory session cache
// ---------------------------------------------------------------------------

interface CatalogCacheEntry {
  catalog:    CatalogGist;
  fetchedAt:  number;
  url:        string;
}

let _sessionCache: CatalogCacheEntry | null = null;

// ---------------------------------------------------------------------------
// Schema conversion: ingestion CinemaCard → feed CinemaCard
// ---------------------------------------------------------------------------

/**
 * Convert the ingestion pipeline's CinemaCard (src/types/schema.ts) into
 * the feed component's CinemaCard (src/components/Feed/SwiperFeed.tsx).
 *
 * The two schemas are intentionally kept separate so the ingestion pipeline
 * has no dependency on React component types, and the feed component has no
 * dependency on the ingestion schema.
 */
function convertToFeedCard(card: IngestCinemaCard): FeedCinemaCard {
  // Build a synthetic trailerUrl that respects the streamType.
  // For HLS streams the feed's VideoSlide component will detect the .m3u8
  // extension and use an HLS-capable player or MSE-based fallback.
  const trailerUrl = card.streamUrl;

  // Extract genres from the archive.org identifier using heuristic detection.
  // The ingestion schema does not carry genre tags; we infer from metadata
  // and the collection the item was discovered in.
  const genres = inferGenres(card);

  // Synthesise a rating-like score from download count — not a real rating,
  // but useful for feed sorting. We normalise to 0–10 scale using log10.
  // Absence of rating signals to the UI to omit the star display.
  const rating: number | undefined = undefined;

  return {
    tmdbId:         card.id,
    movieTitle:     card.title,
    releaseYear:    parseYearToNumber(card.metadata.year),
    directorName:   card.metadata.director ?? 'Unknown',
    synopsis:       card.description || card.title,
    trailerUrl,
    posterWebpUrl:  card.posterUrl,
    backdropUrl:    card.posterUrl,
    runtimeMinutes: card.duration ? Math.round(card.duration / 60) : 60,
    genres,
    archiveOrgUrl:  `https://archive.org/details/${encodeURIComponent(card.id)}`,
    rating,
  };
}

function parseYearToNumber(year: string | undefined): number {
  if (!year) return 1920;
  const n = parseInt(year, 10);
  return isNaN(n) ? 1920 : n;
}

/**
 * Heuristic genre inference from the archive.org identifier and title.
 * Produces 1–3 genre tags suitable for the feed's genre pill display.
 */
function inferGenres(card: IngestCinemaCard): string[] {
  const id    = card.id.toLowerCase();
  const title = card.title.toLowerCase();
  const text  = `${id} ${title}`;
  const genres: string[] = [];

  const matchers: Array<[RegExp, string]> = [
    [/horror|nosferatu|dracula|frankenstein|mummy|vampire|zombie|ghost|haunted|phantom/i, 'Horror'],
    [/scifi|sci[-_]fi|science.fiction|metropolis|robot|space|rocket|alien|fantasi/i,      'Sci-Fi'],
    [/comedy|chaplin|keaton|lloyd|laurel|hardy|buster|slapstick|funny|laugh/i,            'Comedy'],
    [/western|cowboy|outlaw|sheriff|saloon|frontier|gunfight/i,                           'Western'],
    [/documentary|newsreel|news|public.affair|archive|historical|history/i,               'Documentary'],
    [/silent|1910|1911|1912|1913|1914|1915|1916|1917|1918|1919|1920|1921|1922|1923|1924|1925|1926|1927|1928|1929/i, 'Silent'],
    [/romance|love|drama|melodrama/i,                                                     'Drama'],
    [/adventure|action|serial|detective|mystery|crime/i,                                  'Adventure'],
    [/cartoon|animation|animated|felix|mickey|fleischer/i,                                'Animation'],
    [/war|military|battle|soldier|army|navy/i,                                            'War'],
  ];

  for (const [pattern, genre] of matchers) {
    if (pattern.test(text) && !genres.includes(genre)) {
      genres.push(genre);
    }
    if (genres.length >= 3) break;
  }

  // Always include "Classic" if we have fewer than 2 genres.
  if (genres.length < 2 && !genres.includes('Classic')) {
    genres.push('Classic');
  }

  // Ensure "Silent" appears for pre-1930 films without it already.
  const year = parseYearToNumber(card.metadata.year);
  if (year > 0 && year < 1930 && !genres.includes('Silent')) {
    if (genres.length < 3) genres.push('Silent');
  }

  return genres.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Fetch with timeout
// ---------------------------------------------------------------------------

async function fetchCatalogJson(url: string): Promise<CatalogGist> {
  const response = await fetch(url, {
    cache:   'no-cache',       // Let the SW / HTTP cache handle caching.
    signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `[CatalogClient] Gist fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json() as unknown;

  // Validate top-level structure before trusting the payload.
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as Record<string, unknown>)['catalog'])
  ) {
    throw new Error(
      '[CatalogClient] Gist response does not match CatalogGist schema.'
    );
  }

  return data as CatalogGist;
}

// ---------------------------------------------------------------------------
// Public API: fetch catalog as feed-ready CinemaCards
// ---------------------------------------------------------------------------

export interface CatalogFetchResult {
  cards:        FeedCinemaCard[];
  generatedAt:  string;
  totalItems:   number;
  source:       'gist' | 'seed' | 'cache';
  streamBreakdown: {
    hls: number;
    mp4: number;
  };
}

/**
 * Fetch the compiled catalog from the GitHub Gist and convert it to the
 * feed-ready CinemaCard format.
 *
 * Falls back to the seed reel if:
 *   - NEXT_PUBLIC_GIST_CATALOG_URL is not configured.
 *   - The Gist fetch fails (network error, timeout, bad schema).
 *   - The catalog is empty after conversion.
 *
 * Uses an in-memory session cache with a 6-hour stale threshold.
 */
export async function fetchCatalog(options: {
  forceRefresh?: boolean;
  limit?:        number;
  signal?:       AbortSignal;
} = {}): Promise<CatalogFetchResult> {
  const { forceRefresh = false, limit, signal } = options;

  // ── No Gist URL configured — use seed reel immediately ────────────────────
  if (!GIST_CATALOG_URL) {
    return buildSeedResult();
  }

  // ── In-memory cache hit ────────────────────────────────────────────────────
  if (!forceRefresh && _sessionCache) {
    const ageMs = Date.now() - _sessionCache.fetchedAt;

    if (ageMs < CACHE_STALE_MS) {
      return convertCatalog(_sessionCache.catalog, limit, 'cache');
    }

    // Cache is stale — trigger background revalidation and serve stale data.
    refreshCacheInBackground();
    return convertCatalog(_sessionCache.catalog, limit, 'cache');
  }

  // ── Fresh fetch ────────────────────────────────────────────────────────────
  try {
    const catalog = await fetchCatalogJson(GIST_CATALOG_URL);

    _sessionCache = {
      catalog,
      fetchedAt: Date.now(),
      url:       GIST_CATALOG_URL,
    };

    return convertCatalog(catalog, limit, 'gist');
  } catch (err) {
    console.error('[CatalogClient] Gist fetch failed, falling back to seed reel:', err);

    // Serve the in-memory cache if we have one, even if stale.
    if (_sessionCache) {
      return convertCatalog(_sessionCache.catalog, limit, 'cache');
    }

    return buildSeedResult();
  }
}

function convertCatalog(
  catalog: CatalogGist,
  limit:   number | undefined,
  source:  'gist' | 'seed' | 'cache'
): CatalogFetchResult {
  const allCards = catalog.catalog
    .filter((c) => Boolean(c.id) && Boolean(c.streamUrl))
    .map(convertToFeedCard);

  const cards = limit ? allCards.slice(0, limit) : allCards;

  const hlsCount = catalog.catalog
    .filter((c) => c.streamType === 'hls')
    .length;
  const mp4Count = catalog.catalog
    .filter((c) => c.streamType === 'mp4')
    .length;

  return {
    cards,
    generatedAt:  catalog.generatedAt,
    totalItems:   catalog.totalItems,
    source,
    streamBreakdown: { hls: hlsCount, mp4: mp4Count },
  };
}

function buildSeedResult(): CatalogFetchResult {
  return {
    cards:        SEED_REEL,
    generatedAt:  new Date().toISOString(),
    totalItems:   SEED_REEL.length,
    source:       'seed',
    streamBreakdown: { hls: 0, mp4: SEED_REEL.length },
  };
}

function refreshCacheInBackground(): void {
  if (!GIST_CATALOG_URL) return;

  fetchCatalogJson(GIST_CATALOG_URL)
    .then((catalog) => {
      _sessionCache = {
        catalog,
        fetchedAt: Date.now(),
        url:       GIST_CATALOG_URL,
      };
    })
    .catch(() => {
      // Background revalidation failure is silent — stale cache continues serving.
    });
}

// ---------------------------------------------------------------------------
// Public API: paginate a cached catalog
// ---------------------------------------------------------------------------

/**
 * Fetch a single page of the catalog without re-downloading the full Gist.
 * Uses the in-memory session cache; triggers a fetch if the cache is empty.
 *
 * @param page     1-indexed page number.
 * @param pageSize Number of items per page. Default: 10.
 */
export async function fetchCatalogPage(
  page:     number = 1,
  pageSize: number = 10
): Promise<{ cards: FeedCinemaCard[]; hasMore: boolean; totalItems: number }> {
  const result = await fetchCatalog();
  const allCards = result.cards;

  const start = (page - 1) * pageSize;
  const end   = start + pageSize;
  const slice = allCards.slice(start, end);

  return {
    cards:      slice,
    hasMore:    end < allCards.length,
    totalItems: allCards.length,
  };
}

/**
 * Returns cards from the catalog that match a given stream type.
 * Useful for the feed to route HLS and MP4 streams to different player configs.
 */
export async function fetchCatalogByStreamType(
  streamType: StreamType
): Promise<FeedCinemaCard[]> {
  const result = await fetchCatalog();

  // Re-fetch the raw catalog to access streamType (which is lost in conversion).
  if (!_sessionCache) return result.cards;

  const filteredIds = new Set(
    _sessionCache.catalog.catalog
      .filter((c) => c.streamType === streamType)
      .map((c) => c.id)
  );

  return result.cards.filter((c) => filteredIds.has(c.tmdbId));
}

/**
 * Force-invalidate the in-memory session cache.
 * Call this from the Settings page "Clear Film Cache" handler.
 */
export function invalidateCatalogCache(): void {
  _sessionCache = null;
}

/**
 * Returns the current cache state without triggering a fetch.
 * Used by the MemoryOverlay debug panel.
 */
export function getCatalogCacheInfo(): {
  isCached:   boolean;
  ageMs:      number | null;
  isStale:    boolean;
  totalItems: number | null;
} {
  if (!_sessionCache) {
    return { isCached: false, ageMs: null, isStale: false, totalItems: null };
  }

  const ageMs = Date.now() - _sessionCache.fetchedAt;
  return {
    isCached:   true,
    ageMs,
    isStale:    ageMs >= CACHE_STALE_MS,
    totalItems: _sessionCache.catalog.totalItems,
  };
}