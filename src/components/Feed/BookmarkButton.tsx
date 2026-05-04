'use client';

import React, { useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useBookmark } from '@/hooks/useBookmark';
import { useToast } from '@/components/UI/Toast';
import type { CinemaCard } from '@/components/Feed/SwiperFeed';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BookmarkButtonProps {
  card: CinemaCard;
  /** Visual variant for the button. */
  variant?: 'overlay' | 'inline';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const BookmarkButton: React.FC<BookmarkButtonProps> = ({
  card,
  variant = 'overlay',
}) => {
  const { isBookmarked, bookmark, unbookmark } = useBookmark();
  const { show } = useToast();

  const bookmarked = isBookmarked(card.tmdbId);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();

      if (bookmarked) {
        unbookmark(card.tmdbId);
        show(`Removed from Watchlist`, 'info', { icon: '🎞' });
      } else {
        bookmark(card);
        show(`${card.movieTitle} added to Watchlist`, 'success', {
          icon: '🔖',
        });
      }
    },
    [bookmarked, card, bookmark, unbookmark, show]
  );

  return (
    <button
      className={`bookmark-btn bookmark-btn--${variant} ${
        bookmarked ? 'bookmark-btn--active' : ''
      }`}
      onClick={handleToggle}
      aria-label={
        bookmarked
          ? `Remove ${card.movieTitle} from watchlist`
          : `Add ${card.movieTitle} to watchlist`
      }
      aria-pressed={bookmarked}
    >
      <AnimatePresence mode="wait" initial={false}>
        {bookmarked ? (
          <motion.span
            key="bookmarked"
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1,   opacity: 1 }}
            exit={{    scale: 0.6, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
            style={{ display: 'flex' }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
            </svg>
          </motion.span>
        ) : (
          <motion.span
            key="unbookmarked"
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: 1,   opacity: 1 }}
            exit={{    scale: 0.6, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
            style={{ display: 'flex' }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
            </svg>
          </motion.span>
        )}
      </AnimatePresence>

      <style>{BOOKMARK_BTN_STYLES}</style>
    </button>
  );
};

const BOOKMARK_BTN_STYLES = `
  .bookmark-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: none;
    transition: transform 0.12s ease, background 0.15s ease;
    -webkit-tap-highlight-color: transparent;
  }

  .bookmark-btn:active {
    transform: scale(0.88);
  }

  /* ── Overlay variant (floating over video/poster) ── */
  .bookmark-btn--overlay {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: rgba(0,0,0,0.5);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.15);
    color: rgba(255,255,255,0.7);
  }

  .bookmark-btn--overlay.bookmark-btn--active {
    background: rgba(200,169,110,0.2);
    border-color: rgba(200,169,110,0.45);
    color: #c8a96e;
  }

  .bookmark-btn--overlay:hover {
    background: rgba(255,255,255,0.12);
  }

  /* ── Inline variant (in card metadata) ── */
  .bookmark-btn--inline {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    background: transparent;
    color: rgba(255,255,255,0.4);
    padding: 0;
  }

  .bookmark-btn--inline.bookmark-btn--active {
    color: #c8a96e;
  }

  .bookmark-btn--inline:hover {
    color: rgba(255,255,255,0.75);
  }
`;

export default BookmarkButton;