'use client';

import { useEffect } from 'react';

export default function ClientBootstrap() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('/sw.js', { scope: '/' })
          .catch((err) => {
            console.warn('[Flicker.TV] SW registration failed:', err);
          });
      });
    }

    const splash = document.getElementById('flicker-splash');
    if (!splash) return;

    const hideTimer = window.setTimeout(() => {
      splash.classList.add('flicker-splash--hidden');
      window.setTimeout(() => {
        splash.style.display = 'none';
      }, 500);
    }, 600);

    return () => window.clearTimeout(hideTimer);
  }, []);

  return null;
}