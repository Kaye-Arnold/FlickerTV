/**
 * Flicker.TV — Global Feed Store (Zustand)
 *
 * Manages:
 *   - The active cinema reel and pagination state
 *   - currentIndex: the Swiper.js active slide index
 *   - activeCard: the CinemaCard at currentIndex
 *   - Player UI state (muted, turbo mode, waiting room phase)
 *   - Bookmarks (persisted to localStorage)
 *   - Catalog sync metadata (source, stale status)
 */

import { create } from 'zustand';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import type { CinemaCard } from '@/components/Feed/SwiperFeed';
import type { WaitingRoomPhase } from '@/components/VideoPlayer/WaitingRoom';
import type { CatalogSource } from '@/lib/sync/CatalogSync';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface FeedState {
  // ── Reel ──────────────────────────────────────────────────────────────────
  reel:              CinemaCard[];
  /** Active Swiper.js slide index. Kept in sync with onSlideChange. */
  currentIndex:      number;
  activeCard:        CinemaCard | null;
  isLoadingNextPage: boolean;
  currentPage:       number;
  hasMorePages:      boolean;

  // ── Catalog sync metadata ─────────────────────────────────────────────────
  catalogSource:          CatalogSource | null;
  catalogGeneratedAt:     string | null;
  catalogStreamBreakdown: { hls: number; mp4: number } | null;
  catalogIsStale:         boolean;

  // ── Player UI ─────────────────────────────────────────────────────────────
  isMuted:              boolean;
  isFullscreen:         boolean;
  waitingRoomPhase:     WaitingRoomPhase;
  isWaitingRoomVisible: boolean;

  // ── Turbo Mode ────────────────────────────────────────────────────────────
  isTurboMode: boolean;

  // ── Bookmarks (persisted) ─────────────────────────────────────────────────
  bookmarkedIds: Set<string>;

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * Replace the entire reel. Resets currentIndex to 0.
   * Called by useCatalog on initial load or full refresh.
   */
  setReel: (reel: CinemaCard[]) => void;

  /**
   * Append new cards, deduplicating by tmdbId.
   * Called by useCatalog on infinite-scroll pagination.
   */
  appendToReel: (cards: CinemaCard[]) => void;

  /**
   * Update currentIndex AND activeCard atomically.
   * Called by SwiperFeed's onSlideChange handler.
   */
  setCurrentIndex: (index: number) => void;

  setIsLoadingNextPage: (loading: boolean) => void;
  setCurrentPage:       (page: number)    => void;
  setHasMorePages:      (has: boolean)    => void;

  /**
   * Hydrate catalog sync metadata from CatalogSyncResult.
   * Called after every fetchCatalog() resolution.
   */
  setCatalogMeta: (meta: {
    source:          CatalogSource;
    generatedAt:     string;
    streamBreakdown: { hls: number; mp4: number };
    isStale:         boolean;
  }) => void;

  setMuted:             (muted: boolean)         => void;
  toggleMuted:          ()                       => void;
  setFullscreen:        (fullscreen: boolean)    => void;
  setWaitingRoomPhase:  (phase: WaitingRoomPhase) => void;
  showWaitingRoom:      ()                       => void;
  hideWaitingRoom:      ()                       => void;

  setTurboMode: (turbo: boolean) => void;

  bookmarkCard:    (tmdbId: string) => void;
  unbookmarkCard:  (tmdbId: string) => void;
  toggleBookmark:  (tmdbId: string) => void;
  isBookmarked:    (tmdbId: string) => boolean;
  getBookmarkedCards: ()            => CinemaCard[];

  reset: () => void;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const INITIAL_STATE = {
  reel:                  [] as CinemaCard[],
  currentIndex:          0,
  activeCard:            null,
  isLoadingNextPage:     false,
  currentPage:           1,
  hasMorePages:          true,
  catalogSource:         null,
  catalogGeneratedAt:    null,
  catalogStreamBreakdown: null,
  catalogIsStale:        false,
  isMuted:               true,
  isFullscreen:          false,
  waitingRoomPhase:      'skeleton' as WaitingRoomPhase,
  isWaitingRoomVisible:  true,
  isTurboMode:           false,
  bookmarkedIds:         new Set<string>(),
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useFeedStore = create<FeedState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        ...INITIAL_STATE,

        // ── Reel actions ───────────────────────────────────────────────────

        setReel: (reel) =>
          set({
            reel,
            currentIndex: 0,
            activeCard:   reel[0] ?? null,
            currentPage:  1,
            hasMorePages: true,
            // Reset waiting room for the new first card.
            isWaitingRoomVisible: true,
            waitingRoomPhase:     'skeleton',
          }),

        appendToReel: (cards) =>
          set((state) => {
            const existingIds = new Set(state.reel.map((c) => c.tmdbId));
            const unique      = cards.filter((c) => !existingIds.has(c.tmdbId));
            if (unique.length === 0) return {};
            return { reel: [...state.reel, ...unique] };
          }),

        /**
         * setCurrentIndex — atomic update of both the index and the derived
         * activeCard. SwiperFeed's onSlideChange must call this instead of
         * updating index and card separately to prevent torn reads.
         */
        setCurrentIndex: (index) =>
          set((state) => ({
            currentIndex: index,
            activeCard:   state.reel[index] ?? null,
            // Reset waiting room for each new slide.
            isWaitingRoomVisible: true,
            waitingRoomPhase:     'skeleton',
          })),

        setIsLoadingNextPage: (loading) => set({ isLoadingNextPage: loading }),
        setCurrentPage:       (page)    => set({ currentPage: page }),
        setHasMorePages:      (has)     => set({ hasMorePages: has }),

        setCatalogMeta: (meta) =>
          set({
            catalogSource:          meta.source,
            catalogGeneratedAt:     meta.generatedAt,
            catalogStreamBreakdown: meta.streamBreakdown,
            catalogIsStale:         meta.isStale,
          }),

        // ── Player UI actions ──────────────────────────────────────────────

        setMuted:    (muted)      => set({ isMuted: muted }),
        toggleMuted: ()           => set((s) => ({ isMuted: !s.isMuted })),
        setFullscreen: (fs)       => set({ isFullscreen: fs }),
        setWaitingRoomPhase: (p)  => set({ waitingRoomPhase: p }),
        showWaitingRoom: ()       => set({ isWaitingRoomVisible: true, waitingRoomPhase: 'skeleton' }),
        hideWaitingRoom: ()       => set({ isWaitingRoomVisible: false }),

        // ── Turbo Mode ─────────────────────────────────────────────────────

        setTurboMode: (turbo) => set({ isTurboMode: turbo }),

        // ── Bookmark actions ───────────────────────────────────────────────

        bookmarkCard: (tmdbId) =>
          set((s) => ({ bookmarkedIds: new Set([...s.bookmarkedIds, tmdbId]) })),

        unbookmarkCard: (tmdbId) =>
          set((s) => {
            const next = new Set(s.bookmarkedIds);
            next.delete(tmdbId);
            return { bookmarkedIds: next };
          }),

        toggleBookmark: (tmdbId) => {
          const { bookmarkedIds } = get();
          if (bookmarkedIds.has(tmdbId)) get().unbookmarkCard(tmdbId);
          else                           get().bookmarkCard(tmdbId);
        },

        isBookmarked:    (tmdbId) => get().bookmarkedIds.has(tmdbId),
        getBookmarkedCards: ()    => {
          const { reel, bookmarkedIds } = get();
          return reel.filter((c) => bookmarkedIds.has(c.tmdbId));
        },

        // ── Reset ──────────────────────────────────────────────────────────

        reset: () =>
          set({
            ...INITIAL_STATE,
            bookmarkedIds: get().bookmarkedIds, // Preserve bookmarks across reset.
          }),
      }),
      {
        name: 'flicker-tv-feed-store-v2',
        partialize: (state) => ({
          bookmarkedIds: Array.from(state.bookmarkedIds),
          isMuted:       state.isMuted,
          isTurboMode:   state.isTurboMode,
        }),
        onRehydrateStorage: () => (state) => {
          if (
            state &&
            Array.isArray(
              (state as unknown as { bookmarkedIds: string[] }).bookmarkedIds
            )
          ) {
            state.bookmarkedIds = new Set(
              (state as unknown as { bookmarkedIds: string[] }).bookmarkedIds
            );
          }
        },
      }
    )
  )
);

// ---------------------------------------------------------------------------
// Selector hooks — stable slices to minimise re-renders
// ---------------------------------------------------------------------------

export const useActiveCard         = () => useFeedStore((s) => s.activeCard);
export const useCurrentIndex       = () => useFeedStore((s) => s.currentIndex);
export const useIsTurboMode        = () => useFeedStore((s) => s.isTurboMode);
export const useIsMuted            = () => useFeedStore((s) => s.isMuted);
export const useWaitingRoomVisible = () => useFeedStore((s) => s.isWaitingRoomVisible);
export const useBookmarkedIds      = () => useFeedStore((s) => s.bookmarkedIds);
export const useCatalogMeta        = () =>
  useFeedStore((s) => ({
    source:          s.catalogSource,
    generatedAt:     s.catalogGeneratedAt,
    streamBreakdown: s.catalogStreamBreakdown,
    isStale:         s.catalogIsStale,
  }));