'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useParams, useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import CinemaPlayer from '@/components/VideoPlayer/CinemaPlayer';
import { useFeedStore, useIsTurboMode } from '@/lib/store/feedStore';
import { useNetworkQuality } from '@/hooks/useNetworkQuality';
import { fetchCatalog } from '@/lib/api/catalogClient';
import { SEED_REEL } from '@/lib/data/seedReel';
import {
  saveProgress,
  getProgress,
  recordView,
  type WatchProgress,
} from '@/lib/idb/watchlistDB';
import { resolveFromArchiveUrl } from '@/lib/mesh/NodeResolver';
import { formatRuntime } from '@/lib/utils/formatters';
import type { CinemaCard } from '@/components/Feed/SwiperFeed';

// ---------------------------------------------------------------------------
// Node status badge
// ---------------------------------------------------------------------------

interface NodeStatusProps {
  nodeLabel: string;
  latencyMs: number;
  isResolving: boolean;
}

const NodeStatus: React.FC<NodeStatusProps> = ({
  nodeLabel,
  latencyMs,
  isResolving,
}) => (
  <motion.div
    className="watch-node-status"
    initial={{ opacity: 0, y: -8 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -8 }}
  >
    <span
      className={`watch-node-status__dot ${
        isResolving ? 'watch-node-status__dot--pulsing' : ''
      }`}
    />
    <span className="watch-node-status__label">
      {isResolving
        ? 'Resolving node…'
        : `${nodeLabel} · ${latencyMs}ms`}
    </span>
  </motion.div>
);

// ---------------------------------------------------------------------------
// Resume banner — shown when a film has saved progress
// ---------------------------------------------------------------------------

interface ResumeBannerProps {
  progress: WatchProgress;
  onResume: () => void;
  onStartOver: () => void;
}

const ResumeBanner: React.FC<ResumeBannerProps> = ({
  progress,
  onResume,
  onStartOver,
}) => {
  const minutes = Math.floor(progress.currentSeconds / 60);
  const seconds = Math.floor(progress.currentSeconds % 60);

  return (
    <motion.div
      className="watch-resume-banner"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ type: 'spring', stiffness: 400, damping: 34 }}
    >
      <div className="watch-resume-banner__text">
        <span className="watch-resume-banner__label">Resume watching?</span>
        <span className="watch-resume-banner__time">
          {minutes}m {String(seconds).padStart(2, '0')}s ·{' '}
          {progress.percentComplete}% watched
        </span>
      </div>
      <div className="watch-resume-banner__actions">
        <button
          className="watch-resume-banner__btn watch-resume-banner__btn--resume"
          onClick={onResume}
        >
          Resume
        </button>
        <button
          className="watch-resume-banner__btn watch-resume-banner__btn--start"
          onClick={onStartOver}
        >
          Start Over
        </button>
      </div>
    </motion.div>
  );
};

// ---------------------------------------------------------------------------
// Sidebar — film metadata panel (desktop)
// ---------------------------------------------------------------------------

const FilmMetaSidebar: React.FC<{ card: CinemaCard }> = ({ card }) => (
  <aside className="watch-sidebar">
    <img
      src={card.posterWebpUrl}
      alt={card.movieTitle}
      className="watch-sidebar__poster"
      draggable={false}
    />

    <div className="watch-sidebar__meta">
      <h1 className="watch-sidebar__title">{card.movieTitle}</h1>
      <p className="watch-sidebar__year-runtime">
        {card.releaseYear} · {formatRuntime(card.runtimeMinutes)}
      </p>
      <p className="watch-sidebar__director">
        Directed by <strong>{card.directorName}</strong>
      </p>

      <div className="watch-sidebar__genres">
        {card.genres.map((g) => (
          <span key={g} className="watch-sidebar__genre">
            {g}
          </span>
        ))}
      </div>

      {card.rating !== undefined && (
        <div className="watch-sidebar__rating">
          <span className="watch-sidebar__rating-star">★</span>
          <span className="watch-sidebar__rating-value">
            {card.rating.toFixed(1)}
          </span>
          <span className="watch-sidebar__rating-max">/10</span>
        </div>
      )}

      <p className="watch-sidebar__synopsis">{card.synopsis}</p>

      {card.archiveOrgUrl && (
        <a
          href={card.archiveOrgUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="watch-sidebar__archive-link"
        >
          View on archive.org ↗
        </a>
      )}
    </div>
  </aside>
);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function decodeWatchId(value: string | string[] | undefined): string {
  const rawValue = Array.isArray(value) ? value[0] ?? '' : value ?? '';
  try {
    return decodeURIComponent(rawValue);
  } catch (error: unknown) {
    console.warn('[WatchPage] Invalid encoded film id:', error);
    return rawValue;
  }
}

export default function WatchPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { reel } = useFeedStore();
  const userTurboMode = useIsTurboMode();
  const network = useNetworkQuality();
  const isTurboMode = userTurboMode || network.isTurboMode;

  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(true);
  const [nodeLabel, setNodeLabel] = useState('');
  const [nodeLatency, setNodeLatency] = useState(0);
  const [savedProgress, setSavedProgress] = useState<WatchProgress | null>(null);
  const [showResume, setShowResume] = useState(false);
  const [resumeSeconds, setResumeSeconds] = useState(0);
  const [catalogCards, setCatalogCards] = useState<CinemaCard[]>([]);
  const [catalogLookupState, setCatalogLookupState] = useState<
    'idle' | 'loading' | 'loaded' | 'error'
  >('idle');
  const [catalogLookupError, setCatalogLookupError] = useState<string | null>(null);

  const progressSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentSecondsRef = useRef(0);
  const durationSecondsRef = useRef(0);
  const resolverAbortRef = useRef<AbortController | null>(null);
  const resolverGenerationRef = useRef(0);
  const progressGenerationRef = useRef(0);

  const watchId = useMemo(() => decodeWatchId(params.id), [params.id]);
  const hasLocalCard = useMemo(
    () =>
      reel.some((item) => item.tmdbId === watchId) ||
      SEED_REEL.some((item) => item.tmdbId === watchId),
    [reel, watchId]
  );

  // Static-exported watch pages can be opened directly, without the home feed
  // having hydrated first. Resolve the build-time catalog in that case.
  useEffect(() => {
    if (!watchId || hasLocalCard) {
      setCatalogCards([]);
      setCatalogLookupState('loaded');
      setCatalogLookupError(null);
      return;
    }

    const controller = new AbortController();
    setCatalogLookupState('loading');
    setCatalogLookupError(null);

    void fetchCatalog({ signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setCatalogCards(result.cards);
        setCatalogLookupState('loaded');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error('[WatchPage] Catalog lookup failed:', error);
        setCatalogLookupError(
          'The catalog could not be loaded. Check your connection and try again.'
        );
        setCatalogLookupState('error');
      });

    return () => controller.abort();
  }, [hasLocalCard, watchId]);

  // ── Locate the card in the reel, seed data, or direct catalog lookup ──────

  const card = useMemo<CinemaCard | null>(
    () =>
      reel.find((item) => item.tmdbId === watchId) ??
      SEED_REEL.find((item) => item.tmdbId === watchId) ??
      catalogCards.find((item) => item.tmdbId === watchId) ??
      null,
    [catalogCards, reel, watchId]
  );

  // ── Resolve stream node ───────────────────────────────────────────────────

  const watchCardId = card?.tmdbId;
  const watchSourceUrl = card?.trailerUrl;

  useEffect(() => {
    const generation = ++resolverGenerationRef.current;

    if (!watchCardId || !watchSourceUrl) {
      resolverAbortRef.current?.abort();
      setResolvedUrl(null);
      setNodeLabel('');
      setNodeLatency(0);
      setIsResolving(false);
      return;
    }

    resolverAbortRef.current?.abort();
    const controller = new AbortController();
    resolverAbortRef.current = controller;

    setResolvedUrl(null);
    setNodeLabel('');
    setNodeLatency(0);
    setIsResolving(true);

    void resolveFromArchiveUrl(watchSourceUrl, {
      signal: controller.signal,
      probeTimeoutMs: 5000,
      onProbeAttempt: (candidate) => {
        if (
          !controller.signal.aborted &&
          generation === resolverGenerationRef.current
        ) {
          setNodeLabel(candidate.nodeLabel);
        }
      },
    })
      .then((result) => {
        if (
          controller.signal.aborted ||
          generation !== resolverGenerationRef.current
        ) {
          return;
        }
        setResolvedUrl(result.url);
        setNodeLabel(result.nodeLabel);
        setNodeLatency(result.latencyMs);
        setIsResolving(false);
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          generation !== resolverGenerationRef.current
        ) {
          return;
        }
        console.error('[WatchPage] Stream resolution failed:', error);
        setResolvedUrl(watchSourceUrl);
        setNodeLabel('direct fallback');
        setNodeLatency(0);
        setIsResolving(false);
      });

    return () => {
      controller.abort();
    };
  }, [watchCardId, watchSourceUrl]);

  // ── Load saved progress ───────────────────────────────────────────────────

  useEffect(() => {
    const generation = ++progressGenerationRef.current;
    const cardId = card?.tmdbId;
    const movieTitle = card?.movieTitle;

    setSavedProgress(null);
    setShowResume(false);
    if (!cardId || !movieTitle) return;

    void getProgress(cardId)
      .then((progress) => {
        if (generation !== progressGenerationRef.current || !progress) {
          return;
        }
        if (progress.percentComplete > 2 && progress.percentComplete < 95) {
          setSavedProgress(progress);
          setShowResume(true);
        }
      })
      .catch((error: unknown) => {
        if (generation !== progressGenerationRef.current) return;
        console.error('[WatchPage] Could not load saved progress:', error);
      });

    void recordView(cardId, movieTitle).catch((error: unknown) => {
      if (generation !== progressGenerationRef.current) return;
      console.error('[WatchPage] Could not record view:', error);
    });
  }, [card?.movieTitle, card?.tmdbId]);

  // ── Auto-save progress every 10s ─────────────────────────────────────────

  useEffect(() => {
    const cardId = card?.tmdbId;
    if (!cardId) return;

    currentSecondsRef.current = 0;
    durationSecondsRef.current = 0;
    progressSaveTimerRef.current = setInterval(() => {
      if (currentSecondsRef.current > 0) {
        void saveProgress(
          cardId,
          currentSecondsRef.current,
          durationSecondsRef.current
        ).catch((error: unknown) => {
          console.error('[WatchPage] Could not save progress:', error);
        });
      }
    }, 10_000);

    return () => {
      if (progressSaveTimerRef.current) {
        clearInterval(progressSaveTimerRef.current);
        progressSaveTimerRef.current = null;
      }
    };
  }, [card?.tmdbId]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleProgress = useCallback(
    (
      _tmdbId: string,
      progress: { currentSeconds: number; durationSeconds: number; percent: number }
    ) => {
      currentSecondsRef.current = progress.currentSeconds;
      durationSecondsRef.current = progress.durationSeconds;
    },
    []
  );

  const handleResume = useCallback(() => {
    if (savedProgress) {
      setResumeSeconds(savedProgress.currentSeconds);
    }
    setShowResume(false);
  }, [savedProgress]);

  const handleStartOver = useCallback(() => {
    setResumeSeconds(0);
    setShowResume(false);
  }, []);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  // ── Catalog lookup states ─────────────────────────────────────────────────

  if (
    !card &&
    (catalogLookupState === 'idle' || catalogLookupState === 'loading')
  ) {
    return (
      <>
        <style>{WATCH_PAGE_STYLES}</style>
        <div className="watch-not-found" role="status" aria-live="polite">
          <span className="watch-not-found__icon">🎞</span>
          <p className="watch-not-found__title">Loading film…</p>
          <p className="watch-not-found__desc">
            Looking up this film in the current catalog.
          </p>
        </div>
      </>
    );
  }

  if (!card) {
    return (
      <>
        <style>{WATCH_PAGE_STYLES}</style>
        <div className="watch-not-found" role="alert">
          <span className="watch-not-found__icon">📽</span>
          <p className="watch-not-found__title">Film Not Found</p>
          <p className="watch-not-found__desc">
            {catalogLookupError ??
              'This film is not included in the current catalog. Return to the feed to discover more.'}
          </p>
          <button className="watch-not-found__btn" onClick={handleBack}>
            ← Back to Feed
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <style>{WATCH_PAGE_STYLES}</style>

      <div className="watch-root">
        {/* ── Back button ── */}
        <button
          className="watch-back-btn"
          onClick={handleBack}
          aria-label="Back to feed"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        {/* ── Node status ── */}
        <div className="watch-node-status-wrapper">
          <AnimatePresence>
            {(isResolving || nodeLabel) && (
              <NodeStatus
                key="node-status"
                nodeLabel={nodeLabel}
                latencyMs={nodeLatency}
                isResolving={isResolving}
              />
            )}
          </AnimatePresence>
        </div>

        {/* ── Layout: player + optional sidebar ── */}
        <div className="watch-layout">
          {/* Player */}
          <div className="watch-player-wrap">
            {card && (
              <CinemaPlayer
                card={
                  resolvedUrl
                    ? { ...card, trailerUrl: resolvedUrl }
                    : card
                }
                autoPlay={!isTurboMode}
                initiallyMuted={isTurboMode}
                turboMode={isTurboMode}
                startAtSeconds={resumeSeconds}
                onProgress={handleProgress}
                onEnded={(id) => {
                  void saveProgress(id, 0, durationSecondsRef.current).catch(
                    (error: unknown) => {
                      console.error('[WatchPage] Could not save completed progress:', error);
                    }
                  );
                }}
              />
            )}
          </div>

          {/* Desktop sidebar */}
          {card && (
            <div className="watch-sidebar-wrap">
              <FilmMetaSidebar card={card} />
            </div>
          )}
        </div>

        {/* ── Resume banner ── */}
        <div className="watch-resume-wrapper">
          <AnimatePresence>
            {showResume && savedProgress && (
              <ResumeBanner
                key="resume"
                progress={savedProgress}
                onResume={handleResume}
                onStartOver={handleStartOver}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const WATCH_PAGE_STYLES = `
  .watch-root {
    position: relative;
    min-height: 100dvh;
    background: #000;
    color: #fff;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex;
    flex-direction: column;
  }

  /* ── Back button ── */
  .watch-back-btn {
    position: fixed;
    top: calc(16px + env(safe-area-inset-top, 0px));
    left: 16px;
    z-index: 200;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.18);
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease;
  }

  .watch-back-btn:hover {
    background: rgba(255,255,255,0.12);
  }

  /* ── Node status ── */
  .watch-node-status-wrapper {
    position: fixed;
    top: calc(16px + env(safe-area-inset-top, 0px));
    right: 16px;
    z-index: 200;
  }

  .watch-node-status {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 12px;
    border-radius: 100px;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,0.1);
    font-size: 11px;
    color: rgba(255,255,255,0.6);
    letter-spacing: 0.03em;
  }

  .watch-node-status__dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #4ade80;
    flex-shrink: 0;
  }

  .watch-node-status__dot--pulsing {
    background: #c8a96e;
    animation: nodePulse 1s ease-in-out infinite;
  }

  @keyframes nodePulse {
    0%, 100% { opacity: 0.4; transform: scale(0.8); }
    50%       { opacity: 1;   transform: scale(1.15); }
  }

  /* ── Layout ── */
  .watch-layout {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
  }

  @media (min-width: 1024px) {
    .watch-layout {
      flex-direction: row;
      align-items: stretch;
    }
  }

  .watch-player-wrap {
    position: relative;
    width: 100%;
    flex-shrink: 0;
  }

  @media (min-width: 1024px) {
    .watch-player-wrap {
      flex: 1;
      min-height: 100dvh;
    }
  }

  /* ── Sidebar ── */
  .watch-sidebar-wrap {
    display: none;
  }

  @media (min-width: 1024px) {
    .watch-sidebar-wrap {
      display: flex;
      width: 340px;
      flex-shrink: 0;
      border-left: 1px solid rgba(255,255,255,0.07);
      overflow-y: auto;
    }
  }

  .watch-sidebar {
    width: 100%;
    padding: 80px 24px 32px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    background: #0a0a0f;
  }

  .watch-sidebar__poster {
    width: 100%;
    aspect-ratio: 2/3;
    object-fit: cover;
    object-position: center top;
    border-radius: 14px;
    margin-bottom: 4px;
  }

  .watch-sidebar__meta {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .watch-sidebar__title {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: -0.01em;
    line-height: 1.2;
    margin: 0;
  }

  .watch-sidebar__year-runtime {
    font-size: 13px;
    color: rgba(255,255,255,0.45);
    margin: 0;
    letter-spacing: 0.03em;
  }

  .watch-sidebar__director {
    font-size: 13px;
    color: rgba(255,255,255,0.65);
    margin: 0;
  }

  .watch-sidebar__director strong {
    color: #c8a96e;
  }

  .watch-sidebar__genres {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .watch-sidebar__genre {
    padding: 3px 10px;
    border-radius: 100px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: rgba(200,169,110,0.1);
    border: 1px solid rgba(200,169,110,0.2);
    color: rgba(200,169,110,0.85);
  }

  .watch-sidebar__rating {
    display: flex;
    align-items: baseline;
    gap: 5px;
  }

  .watch-sidebar__rating-star {
    color: #c8a96e;
    font-size: 16px;
  }

  .watch-sidebar__rating-value {
    font-size: 22px;
    font-weight: 800;
    color: #fff;
    letter-spacing: -0.02em;
  }

  .watch-sidebar__rating-max {
    font-size: 13px;
    color: rgba(255,255,255,0.35);
  }

  .watch-sidebar__synopsis {
    font-size: 13px;
    line-height: 1.65;
    color: rgba(255,255,255,0.55);
    margin: 0;
  }

  .watch-sidebar__archive-link {
    font-size: 12px;
    color: #c8a96e;
    text-decoration: none;
    letter-spacing: 0.03em;
    transition: opacity 0.15s ease;
  }

  .watch-sidebar__archive-link:hover {
    opacity: 0.75;
  }

  /* ── Resume banner ── */
  .watch-resume-wrapper {
    position: fixed;
    bottom: calc(24px + env(safe-area-inset-bottom, 0px));
    left: 50%;
    transform: translateX(-50%);
    z-index: 300;
    width: min(420px, calc(100vw - 32px));
  }

  .watch-resume-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 14px 18px;
    background: rgba(10,10,22,0.92);
    border: 1px solid rgba(200,169,110,0.25);
    backdrop-filter: blur(16px) saturate(1.5);
    -webkit-backdrop-filter: blur(16px) saturate(1.5);
    border-radius: 16px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.6);
  }

  .watch-resume-banner__text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .watch-resume-banner__label {
    font-size: 13px;
    font-weight: 700;
    color: #fff;
  }

  .watch-resume-banner__time {
    font-size: 11px;
    color: rgba(255,255,255,0.45);
    letter-spacing: 0.03em;
  }

  .watch-resume-banner__actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  .watch-resume-banner__btn {
    padding: 8px 16px;
    border-radius: 100px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    border: none;
    font-family: inherit;
    transition: opacity 0.15s ease;
    letter-spacing: 0.02em;
  }

  .watch-resume-banner__btn--resume {
    background: linear-gradient(135deg, #c8a96e, #e8c98a);
    color: #0a0a0f;
  }

  .watch-resume-banner__btn--start {
    background: rgba(255,255,255,0.1);
    color: rgba(255,255,255,0.65);
  }

  .watch-resume-banner__btn:hover {
    opacity: 0.85;
  }

  /* ── Not found ── */
  .watch-not-found {
    min-height: 100dvh;
    background: #0a0a0f;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    text-align: center;
    padding: 32px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #fff;
  }

  .watch-not-found__icon {
    font-size: 52px;
    opacity: 0.5;
    margin-bottom: 4px;
  }

  .watch-not-found__title {
    font-size: 22px;
    font-weight: 800;
    margin: 0;
  }

  .watch-not-found__desc {
    font-size: 14px;
    color: rgba(255,255,255,0.45);
    line-height: 1.55;
    max-width: 300px;
    margin: 0;
  }

  .watch-not-found__btn {
    margin-top: 8px;
    padding: 12px 28px;
    border-radius: 100px;
    background: linear-gradient(135deg, #c8a96e, #e8c98a);
    color: #0a0a0f;
    font-size: 14px;
    font-weight: 700;
    border: none;
    cursor: pointer;
    font-family: inherit;
    letter-spacing: 0.02em;
    transition: opacity 0.15s ease;
  }

  .watch-not-found__btn:hover {
    opacity: 0.88;
  }
`;
