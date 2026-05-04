'use client';

import { useCallback } from 'react';
import { useFeedStore } from '@/lib/store/feedStore';
import type { CinemaCard } from '@/components/Feed/SwiperFeed';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseBookmarkReturn {
  /** true if the given tmdbId is currently bookmarked. */
  isBookmarked: (tmdbId: string) => boolean;
  /** Toggle the bookmark state for a given tmdbId. */
  toggle: (tmdbId: string) => void;
  /** Bookmark a card and add it to the global reel if not already present. */
  bookmark: (card: CinemaCard) => void;
  /** Remove a bookmark by tmdbId. */
  unbookmark: (tmdbId: string) => void;
  /** All currently bookmarked CinemaCards from the current reel. */
  bookmarkedCards: CinemaCard[];
  /** Total number of bookmarks. */
  count: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useBookmark
 *
 * A convenience wrapper around the feedStore's bookmark state.
 * Provides stable callback references and computed derived values.
 */
export function useBookmark(): UseBookmarkReturn {
  const {
    reel,
    bookmarkedIds,
    bookmarkCard,
    unbookmarkCard,
    toggleBookmark,
    appendToReel,
  } = useFeedStore();

  const isBookmarked = useCallback(
    (tmdbId: string) => bookmarkedIds.has(tmdbId),
    [bookmarkedIds]
  );

  const bookmark = useCallback(
    (card: CinemaCard) => {
      // Ensure the card exists in the reel so watchlist can display it.
      const exists = reel.some((c) => c.tmdbId === card.tmdbId);
      if (!exists) {
        appendToReel([card]);
      }
      bookmarkCard(card.tmdbId);
    },
    [reel, appendToReel, bookmarkCard]
  );

  const unbookmark = useCallback(
    (tmdbId: string) => {
      unbookmarkCard(tmdbId);
    },
    [unbookmarkCard]
  );

  const toggle = useCallback(
    (tmdbId: string) => {
      toggleBookmark(tmdbId);
    },
    [toggleBookmark]
  );

  const bookmarkedCards = reel.filter((c) => bookmarkedIds.has(c.tmdbId));

  return {
    isBookmarked,
    toggle,
    bookmark,
    unbookmark,
    bookmarkedCards,
    count: bookmarkedIds.size,
  };
}