'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * OfflineBanner
 *
 * Renders a persistent top banner when the browser reports being offline.
 * Disappears automatically 2s after the connection is restored.
 */
const OfflineBanner: React.FC = () => {
  const [isOnline, setIsOnline] = useState(true);
  const [showRestored, setShowRestored] = useState(false);

  useEffect(() => {
    setIsOnline(navigator.onLine);

    const handleOffline = () => {
      setIsOnline(false);
      setShowRestored(false);
    };

    const handleOnline = () => {
      setIsOnline(true);
      setShowRestored(true);
      setTimeout(() => setShowRestored(false), 2500);
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online',  handleOnline);

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online',  handleOnline);
    };
  }, []);

  const showBanner = !isOnline || showRestored;

  return (
    <>
      <style>{OFFLINE_STYLES}</style>

      <AnimatePresence>
        {showBanner && (
          <motion.div
            key="offline-banner"
            className={`offline-banner ${
              isOnline ? 'offline-banner--restored' : 'offline-banner--offline'
            }`}
            initial={{ y: '-100%', opacity: 0 }}
            animate={{ y: 0,       opacity: 1 }}
            exit={{    y: '-100%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 36 }}
            role="status"
            aria-live="polite"
          >
            <span className="offline-banner__icon" aria-hidden="true">
              {isOnline ? '✓' : '⚡'}
            </span>
            <span className="offline-banner__message">
              {isOnline
                ? 'Connection restored — resuming streams'
                : 'No internet connection — showing cached content'}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

const OFFLINE_STYLES = `
  .offline-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 9800;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: calc(10px + env(safe-area-inset-top, 0px)) 16px 10px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.03em;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    pointer-events: none;
  }

  .offline-banner--offline {
    background: rgba(248, 113, 113, 0.92);
    color: #fff;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }

  .offline-banner--restored {
    background: rgba(74, 222, 128, 0.92);
    color: #052e16;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }

  .offline-banner__icon {
    font-size: 14px;
    font-style: normal;
  }

  .offline-banner__message {
    line-height: 1;
  }
`;

export default OfflineBanner;