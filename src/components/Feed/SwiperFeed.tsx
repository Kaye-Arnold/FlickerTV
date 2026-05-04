'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import type SwiperClass from 'swiper';
import { useFeedStore } from '@/lib/store/feedStore';
import type { CinemaCard } from '@/types/schema';

export interface SwiperFeedProps {
  cinemaReel: CinemaCard[];
  onReachEnd: () => Promise<void>;
}

export const SwiperFeed: React.FC<SwiperFeedProps> = ({
  cinemaReel,
  onReachEnd,
}) => {
  const { setCurrentIndex } = useFeedStore();
  const swiperRef = useRef<SwiperClass | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  const handleSlideChange = useCallback(
    (swiper: SwiperClass) => {
      const newIndex = swiper.activeIndex;
      setCurrentIndex(newIndex);

      // Trigger pagination if within 3 slides of the end
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
    <Swiper
      ref={swiperRef}
      direction="vertical"
      loop={false}
      virtual={{ slides: cinemaReel }}
      onSlideChange={handleSlideChange}
      className="swiper-feed"
      style={{ width: '100%', height: '100dvh' }}
    >
      {cinemaReel.map((card, idx) => (
        <SwiperSlide key={card.tmdbId} virtualIndex={idx}>
          <div className="swiper-slide-inner" style={{
            width: '100%',
            height: '100%',
            background: '#000',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          }}>
            {/* Poster placeholder */}
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
            {/* Title overlay */}
            <div style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              background: 'linear-gradient(to top, rgba(0,0,0,0.8), transparent)',
              color: '#fff',
              padding: '32px 24px 24px',
              zIndex: 2,
            }}>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>
                {card.movieTitle}
              </h2>
              <p style={{ margin: '4px 0 0', fontSize: '13px', opacity: 0.8 }}>
                {card.releaseYear} · Dir. {card.directorName}
              </p>
            </div>
          </div>
        </SwiperSlide>
      ))}
    </Swiper>
  );
};