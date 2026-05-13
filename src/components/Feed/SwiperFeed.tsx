'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Swiper, SwiperSlide } from 'swiper/react';
import type SwiperClass from 'swiper';
import BookmarkButton from '@/components/Feed/BookmarkButton';
import { useFeedStore, useIsTurboMode } from '@/lib/store/feedStore';
import type { FeedCinemaCard } from '@/types/schema';

export type CinemaCard = FeedCinemaCard;

export interface SwiperFeedProps {
  cinemaReel: CinemaCard[];
  onReachEnd: () => Promise<void>;
}

export const SwiperFeed: React.FC<SwiperFeedProps> = ({
  cinemaReel,
  onReachEnd,
}) => {
  const { setCurrentIndex } = useFeedStore();
  const isTurboMode = useIsTurboMode();
  const router = useRouter();
  const [isInitialized, setIsInitialized] = useState(false);

  const openWatchPage = useCallback(
    (card: CinemaCard) => {
      router.push(`/watch/${encodeURIComponent(card.tmdbId)}`);
    },
    [router]
  );

  const handleSlideChange = useCallback(
    (swiper: SwiperClass) => {
      const newIndex = swiper.activeIndex;
      setCurrentIndex(newIndex);

      if (newIndex >= cinemaReel.length - 3) {
        onReachEnd().catch((err) =>
          console.error('[SwiperFeed] Pagination error:', err)
        );
      }
    },
    [cinemaReel.length, setCurrentIndex, onReachEnd]
  );

  useEffect(() => {
    setIsInitialized(true);
  }, []);

  if (!isInitialized || cinemaReel.length === 0) {
    return (
      <div className="swiper-feed-loading">
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          background: '#000',
          color: '#c8a96e',
          fontFamily: 'system-ui',
          fontSize: '14px',
        }}>
          Loading cinematic feed...
        </div>
      </div>
    );
  }

  return (
    <Swiper      direction="vertical"
      loop={false}
      virtual={{ slides: cinemaReel }}
      onSlideChange={handleSlideChange}
      className="swiper-feed"
      style={{ width: '100%', height: '100dvh' }}
    >
      {cinemaReel.map((card, idx) => (
        <SwiperSlide key={card.tmdbId} virtualIndex={idx}>
          <div
            className="swiper-slide-inner"
            style={{
              width: '100%',
              height: '100%',
              background: '#000',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }}
          >
            <img
              src={card.posterWebpUrl}
              alt={card.movieTitle}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                position: 'absolute',
                inset: 0,
              }}
            />

            {!isTurboMode && (
              <video
                src={card.trailerUrl}
                muted
                playsInline
                loop
                preload={idx === 0 ? 'metadata' : 'none'}
                aria-hidden="true"
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  position: 'absolute',
                  inset: 0,
                  opacity: 0.18,
                }}
              />
            )}

            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                background:
                  'linear-gradient(to top, rgba(0,0,0,0.82), rgba(0,0,0,0.35), transparent)',
                color: '#fff',
                padding: '32px 24px 92px',
                zIndex: 2,
              }}
            >
              <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 700 }}>
                {card.movieTitle}
              </h2>
              <p style={{ margin: '5px 0 0', fontSize: '13px', opacity: 0.82 }}>
                {card.releaseYear} · Dir. {card.directorName}
              </p>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginTop: 16,
                }}
              >
                <button
                  type="button"
                  onClick={() => openWatchPage(card)}
                  style={{
                    border: 0,
                    borderRadius: 999,
                    background: 'linear-gradient(135deg, #c8a96e, #e8c98a)',
                    color: '#0a0a0f',
                    cursor: 'pointer',
                    fontWeight: 800,
                    padding: '11px 22px',
                  }}
                >
                  Play
                </button>
                <BookmarkButton card={card} variant="overlay" />
              </div>
            </div>
          </div>
        </SwiperSlide>
      ))}
    </Swiper>
  );
};
