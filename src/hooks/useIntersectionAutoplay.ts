'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntersectionAutoplayOptions {
  /** Fraction of the element that must be visible to trigger play. */
  visibilityThreshold?: number;
  /** If true, mute the video before attempting autoplay. */
  muteOnAutoplay?: boolean;
  /** Disable autoplay without removing the video element. */
  enabled?: boolean;
  onPlay?: () => void;
  onPause?: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Plays a video while it is visible and pauses it when it leaves the
 * viewport. A request generation prevents a late play() promise from
 * restarting a video after a rapid swipe or unmount.
 */
export function useIntersectionAutoplay(
  options: IntersectionAutoplayOptions = {}
): RefObject<HTMLVideoElement> {
  const {
    visibilityThreshold = 0.6,
    muteOnAutoplay = true,
    enabled = true,
    onPlay,
    onPause,
  } = options;

  const videoRef = useRef<HTMLVideoElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const isPlayingRef = useRef(false);
  const playRequestRef = useRef(0);

  const attemptPlay = useCallback(
    async (video: HTMLVideoElement) => {
      if (!enabled || isPlayingRef.current) return;

      const requestId = ++playRequestRef.current;
      if (muteOnAutoplay) video.muted = true;

      try {
        await video.play();

        if (
          requestId !== playRequestRef.current ||
          !enabled ||
          !video.isConnected
        ) {
          video.pause();
          return;
        }

        isPlayingRef.current = true;
        onPlay?.();
      } catch (error) {
        if (requestId !== playRequestRef.current) return;

        const name = error instanceof DOMException ? error.name : '';
        if (name === 'AbortError' || name === 'NotAllowedError') {
          // These are normal browser outcomes when a swipe or autoplay policy
          // interrupts the request. The user can still start playback manually.
          return;
        }

        console.warn('[useIntersectionAutoplay] Autoplay failed:', error);
      }
    },
    [enabled, muteOnAutoplay, onPlay]
  );

  const attemptPause = useCallback(
    (video: HTMLVideoElement) => {
      // Invalidate any pending play() promise before pausing.
      playRequestRef.current += 1;
      if (!video.paused) video.pause();

      if (isPlayingRef.current) {
        isPlayingRef.current = false;
        onPause?.();
      }
    },
    [onPause]
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!enabled || !video || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          void attemptPlay(video);
        } else {
          attemptPause(video);
        }
      },
      {
        threshold: visibilityThreshold,
        rootMargin: '0px',
      }
    );

    observerRef.current = observer;
    observer.observe(video);

    return () => {
      observer.disconnect();
      observerRef.current = null;
      attemptPause(video);
    };
  }, [attemptPause, attemptPlay, enabled, visibilityThreshold]);

  return videoRef;
}
