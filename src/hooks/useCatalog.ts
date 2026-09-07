'use client';

/**
 * Flicker.TV — useCatalog Hook
 *
 * React hook that manages the full lifecycle of catalog consumption:
 *   1. Fetches the compiled catalog from the GitHub Gist oracle on mount.
 *   2. Injects the first page into the Zustand feed store.
 *   3. Provides a stable `loadNextPage` callback for infinite-scroll pagination.
 *   4. Exposes catalog metadata (source, stream breakdown, stale status).
 *   5. Handles AbortController cleanup on unmount to prevent state updates
 *      on unmounted components.
 *
 * Usage:
 *   const { isLoading, error, loadNextPage, catalogMeta } = useCatalog();
 *
 * The hook writes directly to feedStore via `setReel` and `appendToReel`,
 * so no additional prop-drilling is required. Any component that reads
 * from feedStore will automatically see the catalog data.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  fetchCatalog,
  fetchCatalogPage,
  getCatalogCacheInfo,
  type CatalogFetchResult,
} from '@/lib/api/catalogClient';
import { useFeedStore } from '@/lib/store/feedStore';
import { SEED_REEL } from '@/lib/data/seedReel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogMeta {
  generatedAt:     string | null;
  totalItems:      number;
  source:          'gist' | 'seed' | 'cache' | null;
  streamBreakdown: { hls: number; mp4: number } | null;
  isStale:         boolean;
  cacheAgeMs:      number | null;
}

export interface UseCatalogReturn {
  /** True during the initial catalog fetch. */
  isLoading:    boolean;
  /** True when loading an additional page (not the initial load). */
  isPaginating: boolean;
  /** Non-null if the fetch failed and the seed reel is being used. */
  error:        string | null;
  /** Catalog metadata — null until the first fetch resolves. */
  catalogMeta:  CatalogMeta;
  /**
   * Load the next page of catalog items and append them to the feed store.
   * Safe to call multiple times — concurrent calls are deduplicated.
   */
  loadNextPage: () => Promise<void>;
  /**
   * Force a full catalog refresh, bypassing the in-memory cache.
   * Intended for the Settings page pull-to-refresh or manual reload.
   */
  refresh:      () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_PAGE_SIZE      = 10;
const SUBSEQUENT_PAGE_SIZE   = 10;
const FETCH_TIMEOUT_MS = 15_000; // 15 second timeout

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCatalog(): UseCatalogReturn {
  const [isLoading,    setIsLoading   ] = useState(true);
  const [isPaginating, setIsPaginating] = useState(false);
  const [error,        setError       ] = useState<string | null>(null);
  const [catalogMeta,  setCatalogMeta ] = useState<CatalogMeta>({
    generatedAt:     null,
    totalItems:      0,
    source:          null,
    streamBreakdown: null,
    isStale:         false,
    cacheAgeMs:      null,
  });

  const { setReel, appendToReel, setIsLoadingNextPage } = useFeedStore();

  const currentPageRef   = useRef(1);
  const hasMoreRef       = useRef(true);
  const isPaginatingRef = useRef(false);
  const isInitializedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const paginationGenerationRef = useRef(0);

  // ---------------------------------------------------------------------------
  // Initial catalog load
  // ---------------------------------------------------------------------------

  const loadInitial = useCallback(
    async (forceRefresh: boolean = false) => {
      if (isInitializedRef.current && !forceRefresh) return;

      const generation = ++requestGenerationRef.current;
      paginationGenerationRef.current += 1;
      isPaginatingRef.current = false;
      setIsPaginating(false);
      setIsLoadingNextPage(false);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      setIsLoading(true);
      setError(null);
      currentPageRef.current = 1;
      hasMoreRef.current = true;

      try {
        const result: CatalogFetchResult = await fetchCatalog({
          forceRefresh,
          limit: INITIAL_PAGE_SIZE,
          signal: controller.signal,
        });

        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current
        ) {
          return;
        }

        setReel(result.cards);
        const cacheInfo = getCatalogCacheInfo();

        setCatalogMeta({
          generatedAt: result.generatedAt,
          totalItems: result.totalItems,
          source: result.source,
          streamBreakdown: result.streamBreakdown,
          isStale: cacheInfo.isStale,
          cacheAgeMs: cacheInfo.ageMs,
        });

        hasMoreRef.current = result.cards.length < result.totalItems;
        currentPageRef.current = 1;
        isInitializedRef.current = true;
      } catch (error: unknown) {
        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current
        ) {
          return;
        }

        const errorName =
          error instanceof DOMException || error instanceof Error
            ? error.name
            : '';
        const message =
          errorName === 'AbortError'
            ? 'Catalog fetch timed out after 15s'
            : `Failed to load catalog: ${
                error instanceof Error ? error.message : 'unknown error'
              }`;
        console.error('[useCatalog] loadInitial failed:', error);
        setError(message);
        setReel(SEED_REEL);
        isInitializedRef.current = true;
      } finally {
        clearTimeout(timeoutId);
        if (generation === requestGenerationRef.current) {
          setIsLoading(false);
          if (abortRef.current === controller) abortRef.current = null;
        }
      }
    },
    [setIsLoadingNextPage, setReel]
  );

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  const loadNextPage = useCallback(async () => {
    if (isPaginatingRef.current || !hasMoreRef.current) return;
    if (!isInitializedRef.current) return;

    const generation = requestGenerationRef.current;
    const paginationGeneration = ++paginationGenerationRef.current;
    isPaginatingRef.current = true;
    setIsPaginating(true);
    setIsLoadingNextPage(true);

    try {
      const nextPage = currentPageRef.current + 1;
      const { cards, hasMore, totalItems } = await fetchCatalogPage(
        nextPage,
        SUBSEQUENT_PAGE_SIZE
      );

      if (
        generation !== requestGenerationRef.current ||
        paginationGeneration !== paginationGenerationRef.current
      ) {
        return;
      }

      appendToReel(cards);
      currentPageRef.current = nextPage;
      hasMoreRef.current = hasMore;
      setCatalogMeta((prev) => ({ ...prev, totalItems }));
    } catch (error: unknown) {
      if (
        generation !== requestGenerationRef.current ||
        paginationGeneration !== paginationGenerationRef.current
      ) {
        return;
      }
      console.error('[useCatalog] Pagination failed:', error);
    } finally {
      if (
        generation === requestGenerationRef.current &&
        paginationGeneration === paginationGenerationRef.current
      ) {
        isPaginatingRef.current = false;
        setIsPaginating(false);
        setIsLoadingNextPage(false);
      }
    }
  }, [appendToReel, setIsLoadingNextPage]);

  // ---------------------------------------------------------------------------
  // Force refresh
  // ---------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    isInitializedRef.current = false;
    await loadInitial(true);
  }, [loadInitial]);

  // ---------------------------------------------------------------------------
  // Mount effect
  // ---------------------------------------------------------------------------

  useEffect(() => {
    loadInitial();

    return () => {
      requestGenerationRef.current += 1;
      paginationGenerationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      isPaginatingRef.current = false;
    };
  }, [loadInitial]);

  return {
    isLoading,
    isPaginating,
    error,
    catalogMeta,
    loadNextPage,
    refresh,
  };
}
