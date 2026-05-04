'use client';

import { useCallback, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntersectionAutoplayOptions {
  /**
   * Fraction of the element that must be visible to trigger play.
   * Default: 0.6 (60% visible).
   */
  visibilityThreshold?: number;
  /**
   * If true, the video will be muted before attempting autoplay.
   * Browsers block unmuted autoplay — this ensures it works.
   */
  muteOnAutoplay?: boolean;
  onPlay?:  () => void;
  onPause?: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useIntersectionAutoplay
 *
 * Attaches an IntersectionObserver to a video element and plays/pauses it
 * automatically based on its viewport visibility. Handles the common
 * autoplay-policy rejection gracefully.
 *
 * Returns a ref to attach to the <video> element.
 */
export function useIntersectionAutoplay(
  options: IntersectionAutoplayOptions = {}
): React.RefObject<HTMLVideoElement> {
  const {
    visibilityThreshold = 0.6,
    muteOnAutoplay = true,
    onPlay,
    onPause,
  } = options;

  const videoRef = useRef<HTMLVideoElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const isPlayingRef = useRef(false);

  const attemptPlay = useCallback(async (video: HTMLVideoElement) => {
    if (isPlayingRef.current) return;
    if (muteOnAutoplay) video.muted = true;

    try {
      await video.play();
      isPlayingRef.current = true;
      onPlay?.();
    } catch (err) {
      // AbortError is expected if the element leaves the viewport before play resolves.
      if ((err as DOMException).name !== 'AbortError') {
        console.warn('[useIntersectionAutoplay] Autoplay failed:', err);
      }
    }
  }, [muteOnAutoplay, onPlay]);

  const attemptPause = useCallback((video: HTMLVideoElement) => {
    if (!isPlayingRef.current) return;
    video.pause();
    isPlayingRef.current = false;
    onPause?.();
  }, [onPause]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof IntersectionObserver === 'undefined') return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;

        if (entry.isIntersecting) {
          attemptPlay(video);
        } else {
          attemptPause(video);
        }
      },
      {
        threshold: visibilityThreshold,
        rootMargin: '0px',
      }
    );

    observerRef.current.observe(video);

    return () => {
      observerRef.current?.disconnect();
    };
  }, [visibilityThreshold, attemptPlay, attemptPause]);

  // Pause on unmount to clean up.
  useEffect(() => {
    return () => {
      const video = videoRef.current;
      if (video && isPlayingRef.current) {
        video.pause();
      }
    };
  }, []);

  return videoRef;
}