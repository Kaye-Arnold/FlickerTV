'use client';

import React, { useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useCatalog } from '@/hooks/useCatalog';
import { useFeedStore } from '@/lib/store/feedStore';
import TabBar from '@/components/Navigation/TabBar';

const SwiperFeed = dynamic(
  () => import('@/components/Feed/SwiperFeed').then((mod) => mod.SwiperFeed),
  {
    ssr: false,
    loading: () => (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        background: '#000',
        color: '#c8a96e',
        fontFamily: 'system-ui',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '32px', marginBottom: '16px' }}>🎬</div>
          <div>Initializing Flicker.TV...</div>
        </div>
      </div>
    ),
  }
);

const CatalogStatusBanner: React.FC<{
  source: string | null;
  error: string | null;
}> = ({ source, error }) => {
  if (!error && source !== 'seed') return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      background: source === 'seed' ? '#333' : '#8b0000',
      color: '#fff',
      padding: '12px 16px',
      fontSize: '12px',
      zIndex: 100,
      textAlign: 'center',
    }}>
      {error
        ? `⚠️ ${error} — Using offline catalog`
        : `ℹ️ Using local seed reel (Gist unavailable)`}
    </div>
  );
};

export default function Home() {
  const { reel } = useFeedStore();
  const { isLoading, error, catalogMeta, loadNextPage } = useCatalog();

  const handleReachEnd = useCallback(async () => {
    try {
      await loadNextPage();
    } catch (err) {
      console.error('[Home] Pagination error:', err);
    }
  }, [loadNextPage]);

  // ── Show loading until catalog is ready ──────────────────────────────────
  if (isLoading) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        background: '#000',
        color: '#c8a96e',
        fontFamily: 'system-ui',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '32px', marginBottom: '16px' }}>🎬</div>
          <div>Loading catalog...</div>
        </div>
      </div>
    );
  }

  return (
    <main style={{ backgroundColor: '#000', minHeight: '100vh' }}>
      <CatalogStatusBanner
        source={catalogMeta?.source || null}
        error={error}
      />

      {reel.length > 0 && (
        <SwiperFeed cinemaReel={reel} onReachEnd={handleReachEnd} />
      )}

      {reel.length === 0 && !isLoading && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          background: '#000',
          color: '#c8a96e',
          textAlign: 'center',
          fontFamily: 'system-ui',
        }}>
          <div>No films available. Please check your connection.</div>
        </div>
      )}

      <TabBar />
    </main>
  );
}
