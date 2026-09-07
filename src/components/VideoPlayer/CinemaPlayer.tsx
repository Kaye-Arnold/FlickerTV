'use client';

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import WaitingRoom from './WaitingRoom';
import { getVideoCacheManager } from '@/lib/memory/VideoCacheManager';
import type Hls from 'hls.js';
import type { CinemaCard } from '@/components/Feed/SwiperFeed';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlayerState {
  isPlaying:            boolean;
  isMuted:              boolean;
  currentTimeSeconds:   number;
  durationSeconds:      number;
  bufferedPercent:      number;
  isBuffering:          boolean;
  hasError:             boolean;
  errorMessage:         string | null;
  notice:               string | null;
  isWaitingRoomVisible: boolean;
  showControls:         boolean;
  isFullscreen:         boolean;
}

export interface CinemaPlayerProps {
  card:            CinemaCard;
  autoPlay?:       boolean;
  initiallyMuted?: boolean;
  /** Reduce HLS buffering when the network hook has enabled Turbo Mode. */
  turboMode?:      boolean;
  startAtSeconds?: number;
  onEnded?:        (tmdbId: string) => void;
  onError?:        (tmdbId: string, err: string) => void;
  onProgress?:     (
    tmdbId: string,
    progress: {
      currentSeconds: number;
      durationSeconds: number;
      percent: number;
    }
  ) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h  = Math.floor(seconds / 3600);
  const m  = Math.floor((seconds % 3600) / 60);
  const s  = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

const CONTROLS_HIDE_DELAY_MS = 3500;

// Initial chunk sequence index — the first (and in a trailer context, only)
// chunk registered with the cache manager. consumeChunk() is called with
// this index when the video begins playing to trigger immediate ObjectURL
// revocation and free the backing ArrayBuffer reference.
const INITIAL_CHUNK_SEQUENCE_INDEX = 0;

function isHlsSource(card: CinemaCard): boolean {
  if (card.streamType === 'hls') return true;
  const sourceWithoutQuery = card.trailerUrl.split(/[?#]/, 1)[0] ?? card.trailerUrl;
  return sourceWithoutQuery.toLowerCase().endsWith('.m3u8');
}

// ---------------------------------------------------------------------------
// Seek Bar
// ---------------------------------------------------------------------------

const SeekBar: React.FC<{
  currentTimeSeconds: number;
  durationSeconds:    number;
  bufferedPercent:    number;
  onSeek:             (seconds: number) => void;
}> = ({ currentTimeSeconds, durationSeconds, bufferedPercent, onSeek }) => {
  const trackRef = useRef<HTMLDivElement>(null);

  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      if (!track || durationSeconds === 0) return;
      const rect  = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      onSeek(ratio * durationSeconds);
    },
    [durationSeconds, onSeek]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      if (!track || durationSeconds === 0) return;
      const touch = e.touches[0];
      if (!touch) return;
      const rect  = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
      onSeek(ratio * durationSeconds);
    },
    [durationSeconds, onSeek]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (durationSeconds <= 0) return;

      let nextSeconds: number | null = null;
      switch (e.key) {
        case 'ArrowLeft':
          nextSeconds = currentTimeSeconds - 5;
          break;
        case 'ArrowRight':
          nextSeconds = currentTimeSeconds + 5;
          break;
        case 'Home':
          nextSeconds = 0;
          break;
        case 'End':
          nextSeconds = durationSeconds;
          break;
        default:
          return;
      }

      e.preventDefault();
      onSeek(Math.max(0, Math.min(durationSeconds, nextSeconds)));
    },
    [currentTimeSeconds, durationSeconds, onSeek]
  );

  const progressPercent =
    durationSeconds > 0
      ? Math.max(0, Math.min(100, (currentTimeSeconds / durationSeconds) * 100))
      : 0;
  const safeBufferedPercent = Math.max(0, Math.min(100, bufferedPercent));

  return (
    <div
      ref={trackRef}
      className="cp-seek-track"
      onClick={handleTrackClick}
      onTouchMove={handleTouchMove}
      onKeyDown={handleKeyDown}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.floor(durationSeconds)}
      aria-valuenow={Math.floor(currentTimeSeconds)}
      aria-valuetext={`${formatTime(currentTimeSeconds)} of ${formatTime(durationSeconds)}`}
      tabIndex={0}
    >
      <div
        className="cp-seek-buffered"
        style={{ width: `${safeBufferedPercent}%` }}
      />
      <div
        className="cp-seek-progress"
        style={{ width: `${progressPercent}%` }}
      >
        <div className="cp-seek-thumb" />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Control Bar
// ---------------------------------------------------------------------------

const ControlBar: React.FC<{
  state:          PlayerState;
  card:           CinemaCard;
  onPlayPause:    () => void;
  onMuteToggle:   () => void;
  onSeek:         (seconds: number) => void;
  onFullscreen:   () => void;
  onArchiveLink:  () => void;
}> = ({
  state,
  card,
  onPlayPause,
  onMuteToggle,
  onSeek,
  onFullscreen,
  onArchiveLink,
}) => (
  <div className="cp-control-bar">
    <div className="cp-control-bar__header">
      <span className="cp-film-title">
        {card.movieTitle}
        <span className="cp-film-year"> ({card.releaseYear})</span>
      </span>
      <span className="cp-film-director">Dir. {card.directorName}</span>
    </div>

    <SeekBar
      currentTimeSeconds={state.currentTimeSeconds}
      durationSeconds={state.durationSeconds}
      bufferedPercent={state.bufferedPercent}
      onSeek={onSeek}
    />

    <div className="cp-time-row">
      <span className="cp-time">{formatTime(state.currentTimeSeconds)}</span>
      <span className="cp-time cp-time--duration">
        {formatTime(state.durationSeconds)}
      </span>
    </div>

    <div className="cp-btn-row">
      <button
        className="cp-btn cp-btn--play"
        onClick={onPlayPause}
        aria-label={state.isPlaying ? 'Pause' : 'Play'}
      >
        {state.isPlaying ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.14v14l11-7-11-7z" />
          </svg>
        )}
      </button>

      <button
        className="cp-btn"
        onClick={onMuteToggle}
        aria-label={state.isMuted ? 'Unmute' : 'Mute'}
      >
        {state.isMuted ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19l1.98 2L21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
          </svg>
        )}
      </button>

      {card.archiveOrgUrl && (
        <button
          className="cp-btn cp-btn--archive"
          onClick={onArchiveLink}
          aria-label="Watch full film on Internet Archive"
          title="Watch full film free on archive.org"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z" />
          </svg>
          <span>Full Film</span>
        </button>
      )}

      <button
        className="cp-btn cp-btn--fullscreen"
        onClick={onFullscreen}
        aria-label={state.isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      >
        {state.isFullscreen ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
          </svg>
        )}
      </button>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Main CinemaPlayer
// ---------------------------------------------------------------------------

const CinemaPlayer: React.FC<CinemaPlayerProps> = ({
  card,
  autoPlay       = true,
  initiallyMuted = true,
  turboMode      = false,
  startAtSeconds = 0,
  onEnded,
  onError,
  onProgress,
}) => {
  const videoRef        = useRef<HTMLVideoElement>(null);
  const containerRef    = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSeekRef = useRef(startAtSeconds);
  const hlsRef = useRef<Hls | null>(null);
  const sourceGenerationRef = useRef(0);
  const hlsRecoveryAttemptsRef = useRef(0);
  const waitingRoomDismissedRef = useRef(false);
  const sourceUrl = card.trailerUrl;
  const sourceIsHls = isHlsSource(card);
  // Tracks whether consumeChunk has fired for the current card to prevent
  // duplicate revocations if 'playing' fires more than once (e.g. after seek).
  const chunkConsumedRef = useRef(false);

  const [playerState, setPlayerState] = useState<PlayerState>({
    isPlaying:            false,
    isMuted:              initiallyMuted,
    currentTimeSeconds:   0,
    durationSeconds:      0,
    bufferedPercent:      0,
    isBuffering:          true,
    hasError:             false,
    errorMessage:         null,
    notice:               null,
    isWaitingRoomVisible: true,
    showControls:         true,
    isFullscreen:         false,
  });

  const setPlaybackError = useCallback(
    (message: string, error?: unknown) => {
      if (error !== undefined) {
        console.error(`[CinemaPlayer] ${message}`, error);
      } else {
        console.error(`[CinemaPlayer] ${message}`);
      }
      setPlayerState((prev) => ({
        ...prev,
        hasError: true,
        errorMessage: message,
        notice: null,
        isBuffering: false,
        isPlaying: false,
        isWaitingRoomVisible: false,
      }));
      onError?.(card.tmdbId, message);
    },
    [card.tmdbId, onError]
  );

  // ── C4 FIX: Register video element with VideoCacheManager ─────────────────
  // The cache manager is wired here at mount time. An event listener on the
  // 'playing' event fires consumeChunk() for INITIAL_CHUNK_SEQUENCE_INDEX
  // exactly once per card, triggering immediate URL.revokeObjectURL() and
  // releasing the backing ArrayBuffer — the OOM-prevention system now fires.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof window === 'undefined') return;

    const cacheManager = getVideoCacheManager();
    cacheManager.registerVideoElement(video);

    const handlePlaying = () => {
      // Guard: only consume once per card lifetime to prevent double-revocation
      // if 'playing' is re-fired after a seek or quality switch.
      if (chunkConsumedRef.current) return;
      chunkConsumedRef.current = true;
      cacheManager.consumeChunk(video, INITIAL_CHUNK_SEQUENCE_INDEX);
    };

    video.addEventListener('playing', handlePlaying);

    return () => {
      video.removeEventListener('playing', handlePlaying);
      cacheManager.releaseRegistry(video);
    };
  }, []);

  // Reset chunkConsumedRef when the card changes so the next card's initial
  // chunk can be consumed correctly.
  useEffect(() => {
    chunkConsumedRef.current = false;
    pendingSeekRef.current = startAtSeconds;
  }, [card.tmdbId, startAtSeconds]);

  // Sync the media element when the card changes. Native HLS is preferred on
  // Safari; hls.js provides Media Source Extensions playback elsewhere.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const generation = ++sourceGenerationRef.current;
    hlsRecoveryAttemptsRef.current = 0;
    waitingRoomDismissedRef.current = false;

    hlsRef.current?.destroy();
    hlsRef.current = null;
    video.pause();
    video.removeAttribute('src');
    video.load();

    setPlayerState((prev) => ({
      ...prev,
      isWaitingRoomVisible: true,
      isMuted: initiallyMuted,
      currentTimeSeconds: 0,
      durationSeconds: 0,
      bufferedPercent: 0,
      isBuffering: true,
      hasError: false,
      errorMessage: null,
      notice: null,
      isPlaying: false,
    }));

    const setDirectSource = () => {
      if (generation !== sourceGenerationRef.current) return;
      video.src = sourceUrl;
      video.load();
    };

    if (!sourceIsHls || video.canPlayType('application/vnd.apple.mpegurl') !== '') {
      setDirectSource();
    } else {
      void import('hls.js')
        .then(({ default: HlsConstructor }) => {
          if (generation !== sourceGenerationRef.current) return;

          if (!HlsConstructor.isSupported()) {
            setPlaybackError('This browser cannot play HLS streams.');
            return;
          }

          const hls = new HlsConstructor({
            enableWorker: true,
            lowLatencyMode: false,
            capLevelToPlayerSize: true,
            startLevel: turboMode ? 0 : -1,
            maxBufferLength: turboMode ? 12 : 30,
            maxMaxBufferLength: turboMode ? 20 : 60,
            backBufferLength: turboMode ? 10 : 30,
          });

          hlsRef.current = hls;
          hls.on(HlsConstructor.Events.ERROR, (_event, data) => {
            if (
              generation !== sourceGenerationRef.current ||
              !data.fatal
            ) {
              return;
            }

            if (
              data.type === HlsConstructor.ErrorTypes.NETWORK_ERROR &&
              hlsRecoveryAttemptsRef.current < 1
            ) {
              hlsRecoveryAttemptsRef.current += 1;
              hls.startLoad();
              return;
            }

            if (
              data.type === HlsConstructor.ErrorTypes.MEDIA_ERROR &&
              hlsRecoveryAttemptsRef.current < 2
            ) {
              hlsRecoveryAttemptsRef.current += 1;
              hls.recoverMediaError();
              return;
            }

            setPlaybackError(
              `HLS stream error: ${data.details}`,
              data.error
            );
          });

          hls.loadSource(sourceUrl);
          hls.attachMedia(video);
        })
        .catch((error: unknown) => {
          if (generation !== sourceGenerationRef.current) return;
          setPlaybackError('The HLS player could not be loaded.', error);
        });
    }

    return () => {
      sourceGenerationRef.current += 1;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [
    sourceIsHls,
    sourceUrl,
    initiallyMuted,
    setPlaybackError,
    turboMode,
  ]);

  // Auto-play once the waiting room signals ready.
  const handleWaitingRoomReady = useCallback(() => {
    if (waitingRoomDismissedRef.current) return;
    waitingRoomDismissedRef.current = true;

    setPlayerState((prev) => ({
      ...prev,
      isWaitingRoomVisible: false,
      isBuffering: false,
    }));
    const video = videoRef.current;
    if (!video || !autoPlay) return;

    const generation = sourceGenerationRef.current;
    video.muted = initiallyMuted;
    void video
      .play()
      .then(() => {
        if (generation !== sourceGenerationRef.current) return;
        setPlayerState((prev) => ({ ...prev, isPlaying: true }));
      })
      .catch((error: unknown) => {
        if (generation !== sourceGenerationRef.current) return;
        const name = error instanceof DOMException ? error.name : '';
        if (name === 'NotAllowedError') {
          // Autoplay policy requires an explicit user gesture. The controls
          // remain visible so the user can start playback manually.
          setPlayerState((prev) => ({
            ...prev,
            isPlaying: false,
            showControls: true,
            notice: 'Tap Play to start playback in this browser.',
          }));
          return;
        }
        setPlaybackError('Playback could not start.', error);
      });
  }, [autoPlay, initiallyMuted, setPlaybackError]);


  // ── Video event handlers ─────────────────────────────────────────────────

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    const buffered =
      video.buffered.length > 0 && video.duration > 0
        ? (video.buffered.end(video.buffered.length - 1) / video.duration) * 100
        : 0;

    const progressPercent =
      video.duration > 0 ? (video.currentTime / video.duration) * 100 : 0;

    setPlayerState((prev) => ({
      ...prev,
      currentTimeSeconds: video.currentTime,
      durationSeconds:    video.duration || 0,
      bufferedPercent:    buffered,
    }));

    onProgress?.(card.tmdbId, {
      currentSeconds: video.currentTime,
      durationSeconds: video.duration || 0,
      percent: progressPercent,
    });
  }, [card.tmdbId, onProgress]);

  const handleCanPlay = useCallback(() => {
    setPlayerState((prev) => ({ ...prev, isBuffering: false }));
    handleWaitingRoomReady();
  }, [handleWaitingRoomReady]);

  const handleWaiting = useCallback(() => {
    setPlayerState((prev) => ({ ...prev, isBuffering: true }));
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (pendingSeekRef.current > 0 && video.duration > pendingSeekRef.current) {
      video.currentTime = pendingSeekRef.current;
      pendingSeekRef.current = 0;
    }
    setPlayerState((prev) => ({
      ...prev,
      currentTimeSeconds: video.currentTime,
      durationSeconds: video.duration || 0,
    }));
  }, []);

  const handleEnded = useCallback(() => {
    setPlayerState((prev) => ({ ...prev, isPlaying: false }));
    onEnded?.(card.tmdbId);
  }, [card.tmdbId, onEnded]);

  const handleVideoError = useCallback(() => {
    const video = videoRef.current;
    const msg = video?.error?.message ?? 'Stream unavailable from this node.';
    setPlaybackError(msg, video?.error ?? undefined);
  }, [setPlaybackError]);

  // ── Control actions ──────────────────────────────────────────────────────

  const resetControlsTimer = useCallback(() => {
    setPlayerState((prev) => ({
      ...prev,
      showControls: true,
      notice: null,
    }));
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => {
      setPlayerState((prev) =>
        prev.isPlaying ? { ...prev, showControls: false } : prev
      );
    }, CONTROLS_HIDE_DELAY_MS);
  }, []);

  const handlePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      const generation = sourceGenerationRef.current;
      void video
        .play()
        .then(() => {
          if (generation !== sourceGenerationRef.current) return;
          setPlayerState((prev) => ({ ...prev, isPlaying: true }));
        })
        .catch((error: unknown) => {
          if (generation !== sourceGenerationRef.current) return;
          const name = error instanceof DOMException ? error.name : '';
          if (name === 'NotAllowedError') {
            setPlayerState((prev) => ({
              ...prev,
              isPlaying: false,
              showControls: true,
              notice: 'Tap Play to start playback in this browser.',
            }));
            return;
          }
          setPlaybackError('Playback could not start.', error);
        });
    } else {
      video.pause();
      setPlayerState((prev) => ({ ...prev, isPlaying: false }));
    }

    resetControlsTimer();
  }, [resetControlsTimer, setPlaybackError]);

  const handleMuteToggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setPlayerState((prev) => ({ ...prev, isMuted: video.muted }));
    resetControlsTimer();
  }, [resetControlsTimer]);

  const handleSeek = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, Math.min(seconds, video.duration || 0));
      resetControlsTimer();
    },
    [resetControlsTimer]
  );

  const handleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen();
        setPlayerState((prev) => ({ ...prev, isFullscreen: true }));
      } else {
        await document.exitFullscreen();
        setPlayerState((prev) => ({ ...prev, isFullscreen: false }));
      }
    } catch (error: unknown) {
      console.warn('[CinemaPlayer] Fullscreen request was rejected:', error);
      setPlayerState((prev) => ({
        ...prev,
        notice: 'Fullscreen is not available in this browser.',
      }));
    }
  }, []);

  const handleArchiveLink = useCallback(() => {
    if (card.archiveOrgUrl) {
      window.open(card.archiveOrgUrl, '_blank', 'noopener,noreferrer');
    }
  }, [card.archiveOrgUrl]);

  const handleInteraction = useCallback(() => {
    resetControlsTimer();
  }, [resetControlsTimer]);

  const handleTap = useCallback(() => {
    setPlayerState((prev) => {
      if (!prev.showControls) {
        resetControlsTimer();
        return { ...prev, showControls: true };
      }
      return prev;
    });
  }, [resetControlsTimer]);

  useEffect(() => {
    const handler = () => {
      setPlayerState((prev) => ({
        ...prev,
        isFullscreen: !!document.fullscreenElement,
      }));
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    };
  }, [resetControlsTimer]);

  return (
    <>
      <style>{CINEMA_PLAYER_STYLES}</style>

      <div
        ref={containerRef}
        className="cp-root"
        onMouseMove={handleInteraction}
        onTouchStart={handleTap}
        onClick={handleTap}
      >
        <AnimatePresence>
          {playerState.isWaitingRoomVisible && (
            <motion.div
              key="waiting-room"
              className="cp-waiting-room-layer"
              initial={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
            >
              <WaitingRoom
                posterUrl={card.backdropUrl}
                movieTitle={card.movieTitle}
                tmdbId={card.tmdbId}
                onReady={handleWaitingRoomReady}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <video
          ref={videoRef}
          className="cp-video"
          playsInline
          muted={initiallyMuted}
          preload={autoPlay ? 'metadata' : 'none'}
          poster={card.backdropUrl}
          onTimeUpdate={handleTimeUpdate}
          onCanPlay={handleCanPlay}
          onWaiting={handleWaiting}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleEnded}
          onError={handleVideoError}
          aria-label={`${card.movieTitle} — ${card.releaseYear}`}
        />

        <AnimatePresence>
          {playerState.isBuffering &&
            !playerState.isWaitingRoomVisible &&
            !playerState.hasError && (
              <motion.div
                key="spinner"
                className="cp-spinner-wrapper"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ delay: 0.3, duration: 0.25 }}
              >
                <div
                  className="cp-spinner"
                  aria-label="Buffering"
                  role="status"
                />
              </motion.div>
            )}
        </AnimatePresence>

        <AnimatePresence>
          {playerState.hasError && (
            <motion.div
              key="error"
              className="cp-error"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
            >
              <div className="cp-error__inner">
                <span className="cp-error__icon">📽</span>
                <p className="cp-error__title">Node Unreachable</p>
                <p className="cp-error__message">
                  {playerState.errorMessage ??
                    'Could not connect to this film node.'}
                </p>
                {card.archiveOrgUrl && (
                  <a
                    href={card.archiveOrgUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="cp-error__fallback"
                  >
                    ▶ Watch on archive.org
                  </a>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="cp-scrim" aria-hidden="true" />

        <AnimatePresence>
          {playerState.notice && !playerState.hasError && (
            <motion.div
              key={playerState.notice}
              className="cp-notice"
              role="status"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
            >
              {playerState.notice}
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {playerState.showControls &&
            !playerState.isWaitingRoomVisible &&
            !playerState.hasError && (
              <motion.div
                key="controls"
                className="cp-controls-layer"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22 }}
              >
                <ControlBar
                  state={playerState}
                  card={card}
                  onPlayPause={handlePlayPause}
                  onMuteToggle={handleMuteToggle}
                  onSeek={handleSeek}
                  onFullscreen={handleFullscreen}
                  onArchiveLink={handleArchiveLink}
                />
              </motion.div>
            )}
        </AnimatePresence>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const CINEMA_PLAYER_STYLES = `
  .cp-root {
    position: relative;
    width: 100%;
    height: 100dvh;
    background: #000;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #fff;
    cursor: pointer;
  }

  .cp-video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
    z-index: 1;
  }

  .cp-waiting-room-layer {
    position: absolute;
    inset: 0;
    z-index: 10;
  }

  .cp-scrim {
    position: absolute;
    inset: 0;
    z-index: 2;
    background: linear-gradient(
      to bottom,
      rgba(0,0,0,0.0) 0%,
      rgba(0,0,0,0.0) 50%,
      rgba(0,0,0,0.7) 100%
    );
    pointer-events: none;
  }

  .cp-controls-layer {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 5;
  }

  .cp-control-bar {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 20px 20px calc(20px + env(safe-area-inset-bottom, 0px));
    background: linear-gradient(to top, rgba(0,0,0,0.88) 0%, transparent 100%);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
  }

  .cp-control-bar__header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 4px;
  }

  .cp-film-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.01em;
    text-shadow: 0 1px 8px rgba(0,0,0,0.8);
  }

  .cp-film-year {
    font-weight: 400;
    color: rgba(255,255,255,0.55);
    font-size: 0.85em;
  }

  .cp-film-director {
    font-size: 12px;
    color: #c8a96e;
    letter-spacing: 0.02em;
  }

  .cp-seek-track {
    position: relative;
    width: 100%;
    height: 20px;
    display: flex;
    align-items: center;
    cursor: pointer;
    padding: 8px 0;
    touch-action: none;
  }

  .cp-seek-track::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    height: 3px;
    background: rgba(255,255,255,0.2);
    border-radius: 2px;
  }

  .cp-seek-buffered {
    position: absolute;
    top: 50%;
    left: 0;
    height: 3px;
    transform: translateY(-50%);
    background: rgba(255,255,255,0.35);
    border-radius: 2px;
    pointer-events: none;
    transition: width 0.3s linear;
  }

  .cp-seek-progress {
    position: absolute;
    top: 50%;
    left: 0;
    height: 3px;
    transform: translateY(-50%);
    background: linear-gradient(90deg, #c8a96e, #e8c98a);
    border-radius: 2px;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }

  .cp-seek-thumb {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: #e8c98a;
    box-shadow: 0 0 0 2px rgba(232,201,138,0.35);
    flex-shrink: 0;
    margin-right: -6px;
    pointer-events: none;
  }

  .cp-time-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: -2px;
  }

  .cp-time {
    font-size: 11px;
    color: rgba(255,255,255,0.55);
    letter-spacing: 0.06em;
    font-variant-numeric: tabular-nums;
  }

  .cp-btn-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }

  .cp-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(0,0,0,0.4);
    color: #fff;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.1s ease;
    flex-shrink: 0;
    padding: 0;
  }

  .cp-btn:hover  { background: rgba(255,255,255,0.12); }
  .cp-btn:active { transform: scale(0.92); }

  .cp-btn--play {
    width: 48px;
    height: 48px;
    background: rgba(200,169,110,0.2);
    border-color: rgba(200,169,110,0.4);
    color: #e8c98a;
  }

  .cp-btn--play:hover { background: rgba(200,169,110,0.35); }

  .cp-btn--archive {
    width: auto;
    border-radius: 100px;
    padding: 0 14px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.03em;
    background: linear-gradient(135deg, #c8a96e, #e8c98a);
    border: none;
    color: #0a0a0f;
    gap: 5px;
    height: 36px;
    margin-left: 4px;
  }

  .cp-btn--archive:hover {
    opacity: 0.88;
    background: linear-gradient(135deg, #c8a96e, #e8c98a);
  }

  .cp-btn--fullscreen { margin-left: auto; }

  .cp-spinner-wrapper {
    position: absolute;
    inset: 0;
    z-index: 4;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .cp-spinner {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    border: 3px solid rgba(200,169,110,0.2);
    border-top-color: #c8a96e;
    animation: cpSpin 0.85s linear infinite;
  }

  @keyframes cpSpin { to { transform: rotate(360deg); } }

  .cp-notice {
    position: absolute;
    left: 50%;
    bottom: 112px;
    z-index: 7;
    transform: translateX(-50%);
    max-width: min(420px, calc(100% - 32px));
    padding: 9px 14px;
    border: 1px solid rgba(200,169,110,0.35);
    border-radius: 999px;
    background: rgba(10,10,22,0.82);
    color: rgba(255,255,255,0.88);
    font-size: 12px;
    text-align: center;
    pointer-events: none;
  }

  .cp-error {
    position: absolute;
    inset: 0;
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.75);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }

  .cp-error__inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 32px 28px;
    background: rgba(10,10,22,0.7);
    border: 1px solid rgba(200,169,110,0.2);
    border-radius: 20px;
    text-align: center;
    max-width: min(360px, 90vw);
  }

  .cp-error__icon  { font-size: 40px; margin-bottom: 4px; }

  .cp-error__title {
    font-size: 17px;
    font-weight: 700;
    color: #fff;
    margin: 0;
  }

  .cp-error__message {
    font-size: 13px;
    color: rgba(255,255,255,0.55);
    margin: 0;
    line-height: 1.5;
  }

  .cp-error__fallback {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    padding: 10px 22px;
    border-radius: 100px;
    background: linear-gradient(135deg, #c8a96e, #e8c98a);
    color: #0a0a0f;
    font-size: 13px;
    font-weight: 700;
    text-decoration: none;
    letter-spacing: 0.02em;
    transition: opacity 0.15s ease;
  }

  .cp-error__fallback:hover { opacity: 0.88; }
`;

export default CinemaPlayer;
