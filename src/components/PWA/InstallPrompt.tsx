'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// ---------------------------------------------------------------------------
// BeforeInstallPromptEvent — not yet in TypeScript's lib.dom.d.ts
// ---------------------------------------------------------------------------
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_STORAGE_KEY = 'flicker-tv-install-dismissed';
// Re-show after 7 days if dismissed.
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// iOS detection — iOS Safari has no beforeinstallprompt, needs manual guide.
// ---------------------------------------------------------------------------
function detectIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function isInStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in navigator &&
      (navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}

// ---------------------------------------------------------------------------
// iOS manual install guide sheet
// ---------------------------------------------------------------------------
const IOSInstallSheet: React.FC<{ onDismiss: () => void }> = ({ onDismiss }) => (
  <motion.div
    className="ios-sheet"
    initial={{ opacity: 0, y: '100%' }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: '100%' }}
    transition={{ type: 'spring', stiffness: 360, damping: 36 }}
    role="dialog"
    aria-modal="true"
    aria-label="Install Flicker.TV"
  >
    <div className="ios-sheet__handle" />

    <div className="ios-sheet__header">
      <div className="ios-sheet__app-icon">🎬</div>
      <div>
        <p className="ios-sheet__app-name">Flicker.TV</p>
        <p className="ios-sheet__app-tagline">The MovieDom</p>
      </div>
      <button
        className="ios-sheet__close"
        onClick={onDismiss}
        aria-label="Close install guide"
      >
        ✕
      </button>
    </div>

    <p className="ios-sheet__title">Add to Home Screen</p>

    <div className="ios-sheet__steps">
      <div className="ios-sheet__step">
        <span className="ios-sheet__step-num">1</span>
        <span className="ios-sheet__step-text">
          Tap the{' '}
          <strong>Share</strong> button{' '}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            style={{ verticalAlign: 'middle', color: '#007AFF' }}
          >
            <path d="M16 5l-1.42 1.42-1.59-1.59V16h-1.98V4.83L9.42 6.42 8 5l4-4 4 4zm4 5v11c0 1.1-.9 2-2 2H6c-1.11 0-2-.9-2-2V10c0-1.11.89-2 2-2h3v2H6v11h12V10h-3V8h3c1.1 0 2 .89 2 2z" />
          </svg>{' '}
          at the bottom of your screen.
        </span>
      </div>
      <div className="ios-sheet__step">
        <span className="ios-sheet__step-num">2</span>
        <span className="ios-sheet__step-text">
          Scroll down and tap{' '}
          <strong>"Add to Home Screen"</strong>.
        </span>
      </div>
      <div className="ios-sheet__step">
        <span className="ios-sheet__step-num">3</span>
        <span className="ios-sheet__step-text">
          Tap <strong>"Add"</strong> in the top right.
        </span>
      </div>
    </div>

    <p className="ios-sheet__benefit">
      Get the full cinematic experience — fullscreen, offline access, instant launch.
    </p>
  </motion.div>
);

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const InstallPrompt: React.FC = () => {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [showIOSSheet, setShowIOSSheet] = useState(false);
  const [isIOS] = useState(detectIOS);

  useEffect(() => {
    // Don't show if already installed.
    if (isInStandaloneMode()) return;

    // Don't show if recently dismissed.
    const dismissedAt = localStorage.getItem(DISMISS_STORAGE_KEY);
    if (dismissedAt) {
      const elapsed = Date.now() - parseInt(dismissedAt, 10);
      if (elapsed < DISMISS_DURATION_MS) return;
    }

    if (isIOS) {
      // Show iOS guide after 4 seconds.
      const timer = setTimeout(() => setShowIOSSheet(true), 4000);
      return () => clearTimeout(timer);
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      // Delay banner to avoid competing with initial render.
      setTimeout(() => setShowBanner(true), 2500);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [isIOS]);

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;

    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === 'accepted') {
      setShowBanner(false);
      setDeferredPrompt(null);
    } else {
      localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
      setShowBanner(false);
    }
  }, [deferredPrompt]);

  const handleDismiss = useCallback(() => {
    localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
    setShowBanner(false);
    setShowIOSSheet(false);
  }, []);

  return (
    <>
      <style>{INSTALL_PROMPT_STYLES}</style>

      {/* ── Android/Chrome install banner ── */}
      <AnimatePresence>
        {showBanner && (
          <motion.div
            key="install-banner"
            className="install-banner"
            initial={{ opacity: 0, y: 32 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 32 }}
            transition={{ type: 'spring', stiffness: 400, damping: 34 }}
            role="banner"
          >
            <span className="install-banner__icon">🎬</span>
            <div className="install-banner__text">
              <strong>Install Flicker.TV</strong>
              <span>Fullscreen cinema, offline access</span>
            </div>
            <button
              className="install-banner__btn install-banner__btn--install"
              onClick={handleInstall}
              aria-label="Install Flicker.TV app"
            >
              Install
            </button>
            <button
              className="install-banner__btn install-banner__btn--dismiss"
              onClick={handleDismiss}
              aria-label="Dismiss install prompt"
            >
              ✕
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── iOS install sheet backdrop ── */}
      <AnimatePresence>
        {showIOSSheet && (
          <>
            <motion.div
              key="ios-backdrop"
              className="ios-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={handleDismiss}
            />
            <IOSInstallSheet key="ios-sheet" onDismiss={handleDismiss} />
          </>
        )}
      </AnimatePresence>
    </>
  );
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const INSTALL_PROMPT_STYLES = `
  /* ── Install banner (Android/Chrome) ── */
  .install-banner {
    position: fixed;
    bottom: calc(72px + env(safe-area-inset-bottom, 0px));
    left: 16px;
    right: 16px;
    z-index: 900;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    background: rgba(10, 10, 22, 0.92);
    border: 1px solid rgba(200, 169, 110, 0.25);
    backdrop-filter: blur(16px) saturate(1.5);
    -webkit-backdrop-filter: blur(16px) saturate(1.5);
    border-radius: 16px;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #fff;
  }

  .install-banner__icon {
    font-size: 28px;
    flex-shrink: 0;
  }

  .install-banner__text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .install-banner__text strong {
    font-size: 14px;
    font-weight: 700;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .install-banner__text span {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .install-banner__btn {
    border: none;
    cursor: pointer;
    font-family: inherit;
    transition: opacity 0.15s ease, transform 0.1s ease;
    flex-shrink: 0;
  }

  .install-banner__btn:active {
    transform: scale(0.94);
  }

  .install-banner__btn--install {
    padding: 9px 18px;
    border-radius: 100px;
    background: linear-gradient(135deg, #c8a96e, #e8c98a);
    color: #0a0a0f;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .install-banner__btn--install:hover {
    opacity: 0.88;
  }

  .install-banner__btn--dismiss {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.5);
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* ── iOS sheet ── */
  .ios-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }

  .ios-sheet {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 1200;
    background: rgba(18, 18, 28, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-bottom: none;
    border-radius: 24px 24px 0 0;
    padding: 12px 24px calc(32px + env(safe-area-inset-bottom, 0px));
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #fff;
  }

  .ios-sheet__handle {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.25);
    margin: 0 auto 20px;
  }

  .ios-sheet__header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 20px;
  }

  .ios-sheet__app-icon {
    font-size: 40px;
    width: 56px;
    height: 56px;
    background: rgba(200, 169, 110, 0.15);
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border: 1px solid rgba(200, 169, 110, 0.2);
  }

  .ios-sheet__app-name {
    font-size: 17px;
    font-weight: 700;
    margin: 0;
  }

  .ios-sheet__app-tagline {
    font-size: 12px;
    color: #c8a96e;
    margin: 2px 0 0;
    letter-spacing: 0.04em;
  }

  .ios-sheet__close {
    margin-left: auto;
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: rgba(255, 255, 255, 0.5);
    width: 30px;
    height: 30px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .ios-sheet__title {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 16px;
  }

  .ios-sheet__steps {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-bottom: 20px;
  }

  .ios-sheet__step {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .ios-sheet__step-num {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: rgba(200, 169, 110, 0.18);
    border: 1px solid rgba(200, 169, 110, 0.3);
    color: #c8a96e;
    font-size: 13px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .ios-sheet__step-text {
    font-size: 14px;
    line-height: 1.55;
    color: rgba(255, 255, 255, 0.82);
  }

  .ios-sheet__step-text strong {
    color: #fff;
  }

  .ios-sheet__benefit {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.38);
    text-align: center;
    line-height: 1.55;
    margin: 0;
    padding-top: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.07);
  }
`;

export default InstallPrompt;