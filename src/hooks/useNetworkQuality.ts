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
  readonly effectiveType?: string;
  readonly downlink?: number;
  readonly rtt?: number;
  readonly saveData?: boolean;
}

type NavigatorWithConnection = Navigator & {
  connection?: NetworkInformation;
  mozConnection?: NetworkInformation;
  webkitConnection?: NetworkInformation;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConnection(): NetworkInformation | undefined {
  if (typeof navigator === 'undefined') return undefined;

  const withConnection = navigator as NavigatorWithConnection;
  return (
    withConnection.connection ??
    withConnection.mozConnection ??
    withConnection.webkitConnection
  );
}

function normaliseEffectiveType(value: string | undefined): NetworkEffectiveType {
  switch (value) {
    case '4g':
    case '3g':
    case '2g':
    case 'slow-2g':
      return value;
    default:
      return 'unknown';
  }
}

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

  const conn = getConnection();
  const effectiveType = normaliseEffectiveType(conn?.effectiveType);
  const isOnline = navigator.onLine;
  const saveData = conn?.saveData ?? false;
  const isTurboMode =
    !isOnline ||
    effectiveType === '2g' ||
    effectiveType === 'slow-2g' ||
    effectiveType === '3g' ||
    saveData ||
    (conn?.downlink !== undefined && conn.downlink < 1.0);

  return {
    effectiveType,
    downlinkMbps: conn?.downlink,
    rttMs: conn?.rtt,
    saveData,
    isTurboMode,
    isOnline,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Reactively tracks browser network quality and the online/offline state.
 * Turbo Mode is a derived signal: callers can combine it with the user's
 * persisted preference without mutating that preference when the connection
 * changes.
 */
export function useNetworkQuality(): NetworkQualityState {
  const [state, setState] = useState<NetworkQualityState>(readNetworkState);
  const frameRef = useRef<number | null>(null);

  const refresh = useCallback(() => {
    if (typeof window === 'undefined') return;

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      window.clearTimeout(frameRef.current);
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setState(readNetworkState());
    });
  }, []);

  useEffect(() => {
    const connection = getConnection();

    connection?.addEventListener('change', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    refresh();

    return () => {
      connection?.removeEventListener('change', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        window.clearTimeout(frameRef.current);
      }
    };
  }, [refresh]);

  return state;
}
