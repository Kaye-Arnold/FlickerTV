'use client';

import { useCallback, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

export interface SwipeGestureOptions {
  /** Minimum px the user must travel before the gesture is recognised. */
  threshold?: number;
  /** Maximum ms the swipe may take (prevents slow drags being classified). */
  maxDurationMs?: number;
  /** If true, horizontal swipes are also recognised. Default: false. */
  enableHorizontal?: boolean;
  onSwipeUp?:    () => void;
  onSwipeDown?:  () => void;
  onSwipeLeft?:  () => void;
  onSwipeRight?: () => void;
  /** Fires on every touch move with the current delta values. */
  onDragMove?: (deltaX: number, deltaY: number) => void;
}

interface TouchState {
  startX: number;
  startY: number;
  startTime: number;
  active: boolean;
}

const DEFAULT_THRESHOLD    = 50;
const DEFAULT_MAX_DURATION = 800;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useSwipeGesture
 *
 * Attaches touch/pointer listeners to a target element and fires callbacks
 * for recognised swipe gestures. Designed for Flicker.TV's vertical feed
 * and horizontal in-player gesture navigation.
 */
export function useSwipeGesture<T extends HTMLElement = HTMLDivElement>(
  options: SwipeGestureOptions
): React.RefObject<T> {
  const {
    threshold     = DEFAULT_THRESHOLD,
    maxDurationMs = DEFAULT_MAX_DURATION,
    enableHorizontal = false,
    onSwipeUp,
    onSwipeDown,
    onSwipeLeft,
    onSwipeRight,
    onDragMove,
  } = options;

  const targetRef = useRef<T>(null);
  const touchState = useRef<TouchState>({
    startX: 0,
    startY: 0,
    startTime: 0,
    active: false,
  });

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchState.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      active: true,
    };
  }, []);

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!touchState.current.active) return;
      const touch = e.touches[0];
      if (!touch) return;

      const deltaX = touch.clientX - touchState.current.startX;
      const deltaY = touch.clientY - touchState.current.startY;

      onDragMove?.(deltaX, deltaY);

      // Prevent default scrolling only when vertical dominates
      // (lets horizontal page scrolling still work on hybrid layouts).
      if (Math.abs(deltaY) > Math.abs(deltaX)) {
        e.preventDefault();
      }
    },
    [onDragMove]
  );

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      if (!touchState.current.active) return;
      touchState.current.active = false;

      const touch = e.changedTouches[0];
      if (!touch) return;

      const deltaX = touch.clientX - touchState.current.startX;
      const deltaY = touch.clientY - touchState.current.startY;
      const elapsed = Date.now() - touchState.current.startTime;

      if (elapsed > maxDurationMs) return;

      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      // Determine dominant axis.
      if (absY >= absX && absY >= threshold) {
        if (deltaY < 0) onSwipeUp?.();
        else             onSwipeDown?.();
      } else if (enableHorizontal && absX > absY && absX >= threshold) {
        if (deltaX < 0) onSwipeLeft?.();
        else             onSwipeRight?.();
      }
    },
    [
      threshold,
      maxDurationMs,
      enableHorizontal,
      onSwipeUp,
      onSwipeDown,
      onSwipeLeft,
      onSwipeRight,
    ]
  );

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove',  handleTouchMove,  { passive: false });
    el.addEventListener('touchend',   handleTouchEnd,   { passive: true });
    el.addEventListener('touchcancel', handleTouchEnd,  { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove',  handleTouchMove);
      el.removeEventListener('touchend',   handleTouchEnd);
      el.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  return targetRef;
}