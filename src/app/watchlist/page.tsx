'use client';

import React, { useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { useFeedStore } from '@/lib/store/feedStore';
import type { CinemaCard } from '@/components/Feed/SwiperFeed';

// ---------------------------------------------------------------------------
// Film card in the watchlist grid
// ---------------------------------------------------------------------------

const WatchlistCard: React.FC<{
  card: CinemaCard;
  index: number;
  onRemove: (tmdbId: string) => void;
  onWatch: (card: CinemaCard) => void;
}> = ({ card, index, onRemove, onWatch }) => (
  <motion.div
    className="wl-card"
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, scale: 0.92 }}
    transition={{ delay: index * 0.04, duration: 0.3 }}
    layout
  >
    {/* Poster */}
    <div className="wl-card__poster-wrap">
      <img
        src={card.posterWebpUrl}
        alt={`${card.movieTitle} poster`}
        className="wl-card__poster"
        loading="lazy"
        decoding="async"
      />

      {/* Remove button */}
      <button
        className="wl-card__remove"
        onClick={() => onRemove(card.tmdbId)}
        aria-label={`Remove ${card.movieTitle} from watchlist`}
      >
        ✕
      </button>

      {/* Rating badge */}
      {card.rating !== undefined && (
        <div className="wl-card__rating">
          ★ {card.rating.toFixed(1)}
        </div>
      )}
    </div>

    {/* Meta */}
    <div className="wl-card__meta">
      <p className="wl-card__title">
        {card.movieTitle}{' '}
        <span className="wl-card__year">({card.releaseYear})</span>
      </p>
      <p className="wl-card__director">Dir. {card.directorName}</p>
      <div className="wl-card__genres">
        {card.genres.slice(0, 2).map((g) => (
          <span key={g} className="wl-card__genre">{g}</span>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onWatch(card)}
        className="wl-card__watch-btn"
      >
        Watch Free
      </button>
    </div>
  </motion.div>
);

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

const EmptyWatchlist: React.FC = () => (
  <motion.div
    className="wl-empty"
    initial={{ opacity: 0, y: 16 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.4 }}
  >
    <div className="wl-empty__icon">🎞</div>
    <p className="wl-empty__title">Your watchlist is empty</p>
    <p className="wl-empty__subtitle">
      Swipe through the discovery feed and bookmark films you want to watch.
    </p>
  </motion.div>
);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WatchlistPage() {
  const router = useRouter();
  const { reel, bookmarkedIds, unbookmarkCard } = useFeedStore();

  const bookmarkedCards = useMemo<CinemaCard[]>(() => {
    return reel.filter((card) => bookmarkedIds.has(card.tmdbId));
  }, [reel, bookmarkedIds]);

  const handleWatch = useCallback(
    (card: CinemaCard) => {
      router.push(`/watch/${encodeURIComponent(card.tmdbId)}`);
    },
    [router]
  );

  return (
    <>
      <style>{WATCHLIST_STYLES}</style>

      <div className="wl-root">
        {/* Header */}
        <header className="wl-header">
          <h1 className="wl-header__title">
            My <span>Watchlist</span>
          </h1>
          {bookmarkedCards.length > 0 && (
            <span className="wl-header__count">
              {bookmarkedCards.length} film{bookmarkedCards.length !== 1 ? 's' : ''}
            </span>
          )}
        </header>

        {/* Grid / empty */}
        <main className="wl-main">
          <AnimatePresence mode="popLayout">
            {bookmarkedCards.length === 0 ? (
              <EmptyWatchlist key="empty" />
            ) : (
              <div className="wl-grid" key="grid">
                <AnimatePresence mode="popLayout">
                  {bookmarkedCards.map((card, i) => (
                    <WatchlistCard
                      key={card.tmdbId}
                      card={card}
                      index={i}
                      onRemove={unbookmarkCard}
                      onWatch={handleWatch}
                    />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const WATCHLIST_STYLES = `
  .wl-root {
    min-height: 100dvh;
    background: #0a0a0f;
    color: #fff;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex;
    flex-direction: column;
    padding-bottom: calc(80px + env(safe-area-inset-bottom, 0px));
  }

  /* ── Header ── */
  .wl-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: calc(16px + env(safe-area-inset-top, 0px)) 20px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
  }

  .wl-header__title {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  .wl-header__title span {
    color: #c8a96e;
  }

  .wl-header__count {
    font-size: 13px;
    color: rgba(255,255,255,0.4);
    letter-spacing: 0.03em;
  }

  /* ── Main ── */
  .wl-main {
    flex: 1;
    padding: 20px 16px;
  }

  /* ── Grid ── */
  .wl-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 16px;
  }

  @media (min-width: 480px) {
    .wl-grid {
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    }
  }

  /* ── Card ── */
  .wl-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .wl-card__poster-wrap {
    position: relative;
    border-radius: 12px;
    overflow: hidden;
    aspect-ratio: 2/3;
    background: #17171f;
  }

  .wl-card__poster {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center top;
    display: block;
  }

  .wl-card__remove {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: rgba(0,0,0,0.65);
    border: 1px solid rgba(255,255,255,0.2);
    color: rgba(255,255,255,0.7);
    font-size: 11px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }

  .wl-card__remove:hover {
    background: rgba(200,50,50,0.7);
    color: #fff;
  }

  .wl-card__rating {
    position: absolute;
    bottom: 8px;
    left: 8px;
    padding: 3px 8px;
    border-radius: 100px;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    font-size: 11px;
    font-weight: 700;
    color: #c8a96e;
    letter-spacing: 0.04em;
  }

  /* ── Card meta ── */
  .wl-card__meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .wl-card__title {
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
    margin: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .wl-card__year {
    font-weight: 400;
    color: rgba(255,255,255,0.45);
    font-size: 0.9em;
  }

  .wl-card__director {
    font-size: 11px;
    color: #c8a96e;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .wl-card__genres {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .wl-card__genre {
    padding: 2px 7px;
    border-radius: 100px;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: rgba(200,169,110,0.1);
    border: 1px solid rgba(200,169,110,0.2);
    color: rgba(200,169,110,0.85);
  }

  .wl-card__watch-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
    padding: 6px 12px;
    border-radius: 100px;
    background: linear-gradient(135deg, #c8a96e, #e8c98a);
    color: #0a0a0f;
    font-size: 11px;
    font-weight: 700;
    text-decoration: none;
    border: none;
    font-family: inherit;
    cursor: pointer;
    letter-spacing: 0.03em;
    transition: opacity 0.15s ease;
    width: fit-content;
  }

  .wl-card__watch-btn:hover {
    opacity: 0.88;
  }

  /* ── Empty ── */
  .wl-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 55vh;
    gap: 12px;
    text-align: center;
    padding: 0 32px;
  }

  .wl-empty__icon {
    font-size: 52px;
    opacity: 0.5;
    margin-bottom: 4px;
  }

  .wl-empty__title {
    font-size: 18px;
    font-weight: 700;
    margin: 0;
    color: rgba(255,255,255,0.75);
  }

  .wl-empty__subtitle {
    font-size: 14px;
    color: rgba(255,255,255,0.38);
    line-height: 1.55;
    max-width: 280px;
    margin: 0;
  }
`;
