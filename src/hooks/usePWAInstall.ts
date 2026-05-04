'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export type InstallState =
  | 'not-available'   // No install prompt available (already installed / unsupported browser)
  | 'available'       // Prompt can be triggered
  | 'installing'      // User triggered the prompt, awaiting response
  | 'installed'       // User accepted
  | 'dismissed';      // User dismissed

export interface UsePWAInstallReturn {
  installState: InstallState;
  isInstalled:  boolean;
  canInstall:   boolean;
  triggerInstall: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    ('standalone' in navigator &&
      (navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * usePWAInstall
 *
 * Manages the PWA install lifecycle:
 *  1. Captures the beforeinstallprompt event.
 *  2. Exposes triggerInstall() to fire the native prompt.
 *  3. Tracks the user's choice and reports the final install state.
 *
 * Works independently from InstallPrompt.tsx — can be used anywhere
 * in the component tree that needs access to install capability.
 */
export function usePWAInstall(): UsePWAInstallReturn {
  const [installState, setInstallState] = useState<InstallState>(() =>
    isInStandaloneMode() ? 'installed' : 'not-available'
  );

  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isInStandaloneMode()) {
      setInstallState('installed');
      return;
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setInstallState('available');
    };

    const handleAppInstalled = () => {
      deferredPromptRef.current = null;
      setInstallState('installed');
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const triggerInstall = useCallback(async () => {
    const prompt = deferredPromptRef.current;
    if (!prompt) return;

    setInstallState('installing');

    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      deferredPromptRef.current = null;
      setInstallState(outcome === 'accepted' ? 'installed' : 'dismissed');
    } catch {
      setInstallState('available');
    }
  }, []);

  return {
    installState,
    isInstalled:  installState === 'installed',
    canInstall:   installState === 'available',
    triggerInstall,
  };
}