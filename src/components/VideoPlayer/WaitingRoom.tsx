'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ---------------------------------------------------------------------------
// Public Domain Movie Trivia — shown during Phase 3 (3s+)
// ---------------------------------------------------------------------------
const CINEMA_TRIVIA: string[] = [
  'Nosferatu (1922) was almost destroyed — all copies were ordered burned after a copyright lawsuit by Bram Stoker\'s estate.',
  'The first film ever shown publicly for profit was "Workers Leaving the Lumière Factory" in Paris, December 28, 1895.',
  'Charlie Chaplin once entered a Charlie Chaplin lookalike contest — and came in third place.',
  'The Great Train Robbery (1903) was only 12 minutes long, yet invented the concept of the movie chase scene.',
  'Metropolis (1927) cost 5 million Reichsmarks — it nearly bankrupted UFA Studios.',
  'Birth of a Nation (1915) was the first film screened at the White House, by Woodrow Wilson.',
  'Harold Lloyd performed all his own stunts, including the iconic clock-hanging scene, with a partially amputated hand.',
  'Buster Keaton\'s stone-faced performance style was trained into him at age 3 by his vaudeville parents.',
  'The word "cinema" derives from the Greek "kinema" — meaning movement.',
  'Edison\'s "Black Maria" (1893) was the world\'s first purpose-built film production studio, and it rotated to track the sun.',
  'Fritz Lang claimed he came up with the idea for Metropolis by seeing the New York City skyline for the first time.',
  'Carl Laemmle brought Universal Pictures into the public domain era by releasing dozens of silent-era films freely.',
  'The Phantom of the Opera (1925) was shot with hand-tinted Technicolor sequences for the Masquerade Ball.',
  'D.W. Griffith invented the close-up — before him, all films were shot in a single continuous wide shot.',
  'The Cabinet of Dr. Caligari (1920) used deliberately distorted sets to mirror the protagonist\'s fractured mind.',
  'Every frame of a silent film was hand-cranked — meaning frame rate varied wildly between projectionists.',
  'Mary Pickford co-founded United Artists in 1919 to give artists control of their own distribution.',
  'Murnau\'s Sunrise (1927) was the first film to win Best Picture at the Academy Awards — and it\'s now free to watch.',
  'The Internet Archive hosts over 20,000 public domain films, accessible to anyone on Earth for free.',
  'A film enters the public domain in the US 95 years after its copyright registration date.',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type WaitingRoomPhase = 'skeleton' | 'poster' | 'trivia' | 'ready';

export interface WaitingRoomProps {
  /** High-resolution TMDB poster URL (w780 or original). */
  posterUrl: string;
  /** Film title for the poster overlay. */
  movieTitle: string;
  /** TMDB or archive.org film ID — used as a stable React key. */
  tmdbId: string | number;
  /** Called when the consumer should mount the actual video player. */
  onReady: () => void;
  /** Override the phase manually (e.g. for testing). */
  forcePhase?: WaitingRoomPhase;
  /** Elapsed milliseconds, if driven externally (e.g. from a parent timer). */
  externalElapsedMs?: number;
}

// ---------------------------------------------------------------------------
// Phase timing constants (ms)
// ---------------------------------------------------------------------------
const PHASE_SKELETON_DURATION = 1000;  // 0 → 1s
const PHASE_POSTER_DURATION   = 2000;  // 1 → 3s
// Phase 3 starts at 3s and runs until the mesh resolves / onReady fires.

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Phase 1: Shimmer skeleton that mirrors the video player layout. */
const SkeletonPhase: React.FC = () => (
  <div
    className="waiting-room__skeleton"
    aria-label="Loading film"
    role="status"
  >
    {/* Top bar — film title area */}
    <div className="skeleton-bar skeleton-bar--title" />
    {/* Central poster area */}
    <div className="skeleton-poster">
      <div className="skeleton-shimmer" />
    </div>
    {/* Bottom controls */}
    <div className="skeleton-controls">
      <div className="skeleton-bar skeleton-bar--wide" />
      <div className="skeleton-bar skeleton-bar--narrow" />
    </div>
  </div>
);

/** Phase 2: High-res poster with "Resolving Encrypted Mesh…" overlay. */
const PosterPhase: React.FC<{
  posterUrl: string;
  movieTitle: string;
}> = ({ posterUrl, movieTitle }) => {
  const [posterLoaded, setPosterLoaded] = useState(false);

  return (
    <div className="waiting-room__poster-phase">
      {/* Poster image */}
      <motion.img
        key={posterUrl}
        src={posterUrl}
        alt={`${movieTitle} poster`}
        className="waiting-room__poster-img"
        onLoad={() => setPosterLoaded(true)}
        initial={{ opacity: 0, scale: 1.04 }}
        animate={{ opacity: posterLoaded ? 1 : 0, scale: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        draggable={false}
      />

      {/* Frosted glass overlay */}
      <div className="waiting-room__mesh-overlay">
        <div className="mesh-overlay__inner">
          {/* Animated signal dots */}
          <div className="mesh-overlay__dots" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="mesh-dot"
                style={{ animationDelay: `${i * 0.22}s` }}
              />
            ))}
          </div>

          <p className="mesh-overlay__label">Resolving Encrypted Mesh…</p>

          <p className="mesh-overlay__subtitle">
            Connecting to decentralized film node
          </p>

          {/* Fake progress bar — slides from 0 → ~85% to imply activity */}
          <div className="mesh-overlay__progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={72}>
            <motion.div
              className="mesh-overlay__progress-fill"
              initial={{ width: '0%' }}
              animate={{ width: '72%' }}
              transition={{ duration: 1.8, ease: [0.25, 0.1, 0.25, 1] }}
            />
          </div>
        </div>
      </div>

      {/* Film title at bottom */}
      <div className="waiting-room__title-bar">
        <span className="waiting-room__movie-title">{movieTitle}</span>
      </div>
    </div>
  );
};

/** Rotating trivia card used in Phase 3. */
const TriviaCard: React.FC<{ triviaText: string }> = ({ triviaText }) => (
  <motion.div
    key={triviaText}
    className="trivia-card"
    initial={{ opacity: 0, y: 18 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -18 }}
    transition={{ duration: 0.55, ease: 'easeInOut' }}
  >
    <div className="trivia-card__icon" aria-hidden="true">🎬</div>
    <p className="trivia-card__label">DID YOU KNOW?</p>
    <p className="trivia-card__text">{triviaText}</p>
  </motion.div>
);

/** Phase 3: Poster stays, trivia rotates over frosted glass panel. */
const TriviaPhase: React.FC<{
  posterUrl: string;
  movieTitle: string;
  triviaIndex: number;
}> = ({ posterUrl, movieTitle, triviaIndex }) => (
  <div className="waiting-room__trivia-phase">
    {/* Blurred poster as ambient background */}
    <img
      src={posterUrl}
      alt=""
      aria-hidden="true"
      className="waiting-room__poster-bg"
      draggable={false}
    />

    {/* Ambient colour scrim */}
    <div className="waiting-room__scrim" />

    {/* Film title */}
    <div className="waiting-room__title-bar waiting-room__title-bar--trivia">
      <span className="waiting-room__movie-title">{movieTitle}</span>
    </div>

    {/* Rotating trivia panel */}
    <div className="waiting-room__trivia-panel">
      <AnimatePresence mode="wait">
        <TriviaCard
          key={triviaIndex}
          triviaText={CINEMA_TRIVIA[triviaIndex % CINEMA_TRIVIA.length]}
        />
      </AnimatePresence>

      {/* Still connecting indicator */}
      <div className="trivia-phase__connecting">
        <span className="trivia-phase__spinner" aria-hidden="true" />
        <span className="trivia-phase__connecting-text">
          Still resolving node…
        </span>
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------
const WaitingRoom: React.FC<WaitingRoomProps> = ({
  posterUrl,
  movieTitle,
  tmdbId,
  onReady,
  forcePhase,
  externalElapsedMs,
}) => {
  const [phase, setPhase] = useState<WaitingRoomPhase>(
    forcePhase ?? 'skeleton'
  );
  const [triviaIndex, setTriviaIndex] = useState<number>(() =>
    Math.floor(Math.random() * CINEMA_TRIVIA.length)
  );

  const startTimeRef = useRef<number>(Date.now());
  const triviaTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readyFiredRef = useRef(false);

  // Randomise starting trivia index per film.
  useEffect(() => {
    setTriviaIndex(Math.floor(Math.random() * CINEMA_TRIVIA.length));
  }, [tmdbId]);

  // Override phase if forcePhase prop changes (useful in Storybook / testing).
  useEffect(() => {
    if (forcePhase !== undefined) {
      setPhase(forcePhase);
    }
  }, [forcePhase]);

  // Phase state machine driven by internal timers.
  useEffect(() => {
    if (forcePhase !== undefined) return; // externally controlled

    startTimeRef.current = Date.now();

    // Phase 1 → 2 after PHASE_SKELETON_DURATION
    phaseTimerRef.current = setTimeout(() => {
      setPhase('poster');

      // Phase 2 → 3 after PHASE_POSTER_DURATION
      phaseTimerRef.current = setTimeout(() => {
        setPhase('trivia');
      }, PHASE_POSTER_DURATION);
    }, PHASE_SKELETON_DURATION);

    return () => {
      if (phaseTimerRef.current !== null) {
        clearTimeout(phaseTimerRef.current);
      }
    };
  }, [tmdbId, forcePhase]);

  // Rotate trivia every 7 seconds during Phase 3.
  useEffect(() => {
    if (phase !== 'trivia') return;

    triviaTimerRef.current = setInterval(() => {
      setTriviaIndex((prev) => (prev + 1) % CINEMA_TRIVIA.length);
    }, 7000);

    return () => {
      if (triviaTimerRef.current !== null) {
        clearInterval(triviaTimerRef.current);
      }
    };
  }, [phase]);

  // Allow external elapsed time to override phase (e.g., from a parent
  // that has already been counting since the fetch started).
  useEffect(() => {
    if (externalElapsedMs === undefined || forcePhase !== undefined) return;

    if (externalElapsedMs >= PHASE_SKELETON_DURATION + PHASE_POSTER_DURATION) {
      setPhase('trivia');
    } else if (externalElapsedMs >= PHASE_SKELETON_DURATION) {
      setPhase('poster');
    } else {
      setPhase('skeleton');
    }
  }, [externalElapsedMs, forcePhase]);

  // Expose imperative "signal ready" — parent calls onReady once stream
  // URL is confirmed. We transition to a brief fade-out then unmount.
  const signalReady = useCallback(() => {
    if (readyFiredRef.current) return;
    readyFiredRef.current = true;

    // Stop trivia rotation.
    if (triviaTimerRef.current !== null) {
      clearInterval(triviaTimerRef.current);
    }

    setPhase('ready');
    // Give Framer Motion time to run the exit animation before the parent
    // replaces WaitingRoom with the actual player.
    setTimeout(onReady, 400);
  }, [onReady]);

  // Expose signalReady via a custom event for decoupled parents.
  useEffect(() => {
    const handler = () => signalReady();
    window.addEventListener(`flicker:stream-ready:${tmdbId}`, handler);
    return () =>
      window.removeEventListener(`flicker:stream-ready:${tmdbId}`, handler);
  }, [tmdbId, signalReady]);

  return (
    <>
      {/* Inline critical styles — scoped to avoid global pollution */}
      <style>{WAITING_ROOM_STYLES}</style>

      <AnimatePresence mode="wait">
        {phase !== 'ready' && (
          <motion.div
            key={`waiting-room-${tmdbId}`}
            className="waiting-room"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            <AnimatePresence mode="wait">
              {phase === 'skeleton' && (
                <motion.div
                  key="skeleton"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <SkeletonPhase />
                </motion.div>
              )}

              {phase === 'poster' && (
                <motion.div
                  key="poster"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.35 }}
                  style={{ width: '100%', height: '100%' }}
                >
                  <PosterPhase
                    posterUrl={posterUrl}
                    movieTitle={movieTitle}
                  />
                </motion.div>
              )}

              {phase === 'trivia' && (
                <motion.div
                  key="trivia"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.35 }}
                  style={{ width: '100%', height: '100%' }}
                >
                  <TriviaPhase
                    posterUrl={posterUrl}
                    movieTitle={movieTitle}
                    triviaIndex={triviaIndex}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Debug: signal ready button — hidden in production */}
            {process.env.NODE_ENV === 'development' && (
              <button
                onClick={signalReady}
                style={{
                  position: 'absolute',
                  bottom: 24,
                  right: 24,
                  zIndex: 9999,
                  background: 'rgba(255,255,255,0.15)',
                  border: '1px solid rgba(255,255,255,0.3)',
                  color: '#fff',
                  padding: '6px 14px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 12,
                  backdropFilter: 'blur(8px)',
                }}
              >
                [DEV] Signal Ready
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

// ---------------------------------------------------------------------------
// Scoped CSS — avoids Tailwind dependency for this standalone component.
// ---------------------------------------------------------------------------
const WAITING_ROOM_STYLES = `
  .waiting-room {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 100dvh;
    background: #0a0a0f;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    color: #fff;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  /* ---- Skeleton ---- */
  .waiting-room__skeleton {
    width: 100%;
    height: 100%;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 40px 24px 32px;
    gap: 20px;
  }
  .skeleton-bar {
    height: 18px;
    border-radius: 9px;
    background: linear-gradient(90deg, #1c1c2a 25%, #2a2a3d 50%, #1c1c2a 75%);
    background-size: 200% 100%;
    animation: shimmer 1.6s infinite;
  }
  .skeleton-bar--title { width: 55%; }
  .skeleton-bar--wide  { width: 80%; }
  .skeleton-bar--narrow { width: 45%; margin-top: 10px; }
  .skeleton-poster {
    flex: 1;
    width: min(340px, 90%);
    max-height: 65vh;
    border-radius: 16px;
    overflow: hidden;
    background: #1c1c2a;
    position: relative;
  }
  .skeleton-shimmer {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, #1c1c2a 25%, #2a2a3d 50%, #1c1c2a 75%);
    background-size: 200% 100%;
    animation: shimmer 1.6s infinite;
  }
  .skeleton-controls {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  @keyframes shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  /* ---- Poster phase ---- */
  .waiting-room__poster-phase {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .waiting-room__poster-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center top;
  }
  .waiting-room__mesh-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(
      to bottom,
      rgba(0,0,0,0.35) 0%,
      rgba(0,0,0,0.15) 40%,
      rgba(0,0,0,0.75) 100%
    );
  }
  .mesh-overlay__inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    background: rgba(10, 10, 20, 0.55);
    backdrop-filter: blur(12px) saturate(1.4);
    -webkit-backdrop-filter: blur(12px) saturate(1.4);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 20px;
    padding: 28px 36px;
    min-width: min(320px, 85vw);
    text-align: center;
    box-shadow: 0 8px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.07);
  }
  .mesh-overlay__dots {
    display: flex;
    gap: 10px;
    margin-bottom: 4px;
  }
  .mesh-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #c8a96e;
    animation: pulseDot 1.2s ease-in-out infinite;
  }
  @keyframes pulseDot {
    0%, 100% { opacity: 0.3; transform: scale(0.85); }
    50%       { opacity: 1;   transform: scale(1.1);  }
  }
  .mesh-overlay__label {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: #e8d9b8;
    margin: 0;
  }
  .mesh-overlay__subtitle {
    font-size: 12px;
    color: rgba(255,255,255,0.5);
    margin: 0;
    letter-spacing: 0.02em;
  }
  .mesh-overlay__progress-track {
    width: 100%;
    height: 3px;
    border-radius: 2px;
    background: rgba(255,255,255,0.12);
    overflow: hidden;
    margin-top: 6px;
  }
  .mesh-overlay__progress-fill {
    height: 100%;
    border-radius: 2px;
    background: linear-gradient(90deg, #c8a96e, #e8c98a);
  }

  /* ---- Shared title bar ---- */
  .waiting-room__title-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 60px 24px 32px;
    background: linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%);
    display: flex;
    align-items: flex-end;
  }
  .waiting-room__title-bar--trivia {
    bottom: auto;
    top: 0;
    padding: 56px 24px 32px;
    background: linear-gradient(to bottom, rgba(0,0,0,0.8) 0%, transparent 100%);
  }
  .waiting-room__movie-title {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 0.01em;
    text-shadow: 0 2px 12px rgba(0,0,0,0.8);
    color: #fff;
    line-height: 1.2;
  }

  /* ---- Trivia phase ---- */
  .waiting-room__trivia-phase {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .waiting-room__poster-bg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center top;
    filter: blur(22px) brightness(0.45);
    transform: scale(1.08); /* hide blur edges */
  }
  .waiting-room__scrim {
    position: absolute;
    inset: 0;
    background: rgba(5, 5, 12, 0.55);
  }
  .waiting-room__trivia-panel {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding: 0 20px;
    width: min(460px, 92vw);
  }

  /* ---- Trivia card ---- */
  .trivia-card {
    background: rgba(10, 10, 22, 0.65);
    backdrop-filter: blur(12px) saturate(1.5);
    -webkit-backdrop-filter: blur(12px) saturate(1.5);
    border: 1px solid rgba(200,169,110,0.2);
    border-radius: 20px;
    padding: 28px 26px 24px;
    text-align: center;
    box-shadow: 0 12px 48px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
    width: 100%;
  }
  .trivia-card__icon {
    font-size: 32px;
    margin-bottom: 10px;
  }
  .trivia-card__label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.18em;
    color: #c8a96e;
    text-transform: uppercase;
    margin: 0 0 12px;
  }
  .trivia-card__text {
    font-size: 14px;
    line-height: 1.65;
    color: rgba(255,255,255,0.88);
    margin: 0;
  }

  /* ---- Still connecting indicator ---- */
  .trivia-phase__connecting {
    display: flex;
    align-items: center;
    gap: 10px;
    color: rgba(255,255,255,0.45);
    font-size: 12px;
    letter-spacing: 0.04em;
  }
  .trivia-phase__spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(200,169,110,0.25);
    border-top-color: #c8a96e;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;

export default WaitingRoom;