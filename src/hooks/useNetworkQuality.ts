
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NetworkEffectiveType = '4g' | '3g' | '2g' | 'slow-2g' | 'unknown';

export interface NetworkQualityState {
  effectiveType: NetworkEffectiveType;
  /** Estimated downstream bandwidth in Mbps (may be undefined on some browsers). */
  downlinkMbps: number | undefined;
  /** Round-trip time estimate in ms (may be undefined on some browsers). */
  rttMs: number | undefined;
  /** true = the user has requested reduced data usage. */
  saveData: boolean;
  /** true = video autoplay should be suppressed. */
  isTurboMode: boolean;
  /** true = the browser reports being online. */
  isOnline: boolean;
}

interface NetworkInformation extends EventTarget {
  readonly effectiveType?: NetworkEffectiveType;
  readonly downlink?: number;
  readonly rtt?: number;
  readonly saveData?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readNetworkState(): NetworkQualityState {
  if (typeof navigator === 'undefined') {
    return {
      effectiveType: 'unknown',
      downlinkMbps: undefined,
      rttMs: undefined,
      saveData: false,
      isTurboMode: false,
      isOnline: true,
    };
  }

  const conn = (
    navigator as Navigator & {
      connection?: NetworkInformation;
      mozConnection?: NetworkInformation;
      webkitConnection?: NetworkInformation;
    }
  ).connection ??
    (navigator as Navigator & { mozConnection?: NetworkInformation })
      .mozConnection ??
    (navigator as Navigator & { webkitConnection?: NetworkInformation })
      .webkitConnection;

  const effectiveType: NetworkEffectiveType =
    (conn?.effectiveType as NetworkEffectiveType | undefined) ?? 'unknown';

  const isTurboMode =
    effectiveType === '2g' ||
    effectiveType === 'slow-2g' ||
    effectiveType === '3g' ||
    (conn?.saveData ?? false) ||
    (conn?.downlink !== undefined && conn.downlink < 1.0); // < 1 Mbps

  return {
    effectiveType,
    downlinkMbps: conn?.downlink,
    rttMs: conn?.rtt,
    saveData: conn?.saveData ?? false,
    isTurboMode,
    isOnline: navigator.onLine,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useNetworkQuality
 *
 * Reactively tracks the browser's reported network quality via the
 * Network Information API. Updates whenever the connection changes.
 *
 * Turbo Mode is activated when:
 *  - effectiveType is 2g / slow-2g / 3g
 *  - navigator.connection.saveData is true
 *  - Estimated downlink < 1 Mbps
 */
export function useNetworkQuality(): NetworkQualityState {
  const [state, setState] = useState<NetworkQualityState>(readNetworkState);
  const frameRef = useRef<number | null>(null);

  const refresh = useCallback(() => {
    // Debounce via rAF to coalesce rapid change events.
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      setState(readNetworkState());
    });
  }, []);

  useEffect(() => {
    const conn = (
      navigator as Navigator & { connection?: NetworkInformation }
    ).connection;

    conn?.addEventListener('change', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);

    // Immediate read in case SSR initial state differed.
    refresh();

    return () => {
      conn?.removeEventListener('change', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [refresh]);

  return state;
}