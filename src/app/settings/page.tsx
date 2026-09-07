'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useFeedStore } from '@/lib/store/feedStore';
import { useNetworkQuality } from '@/hooks/useNetworkQuality';
import {
  invalidateCatalogCache,
  getCatalogCacheInfo,
} from '@/lib/api/catalogClient';
import {
  clearAllData,
  getDatabaseSizeEstimate,
  getIndexedDbDiagnostics,
  type IndexedDbDiagnostics,
} from '@/lib/idb/watchlistDB';
import { formatBytes } from '@/lib/utils/formatters';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ToggleRowProps {
  label:       string;
  description: string;
  checked:     boolean;
  onChange:    (val: boolean) => void;
  disabled?:   boolean;
  badge?:      string;
}

const ToggleRow: React.FC<ToggleRowProps> = ({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  badge,
}) => (
  <div className={`settings-row ${disabled ? 'settings-row--disabled' : ''}`}>
    <div className="settings-row__text">
      <span className="settings-row__label">
        {label}
        {badge && <span className="settings-row__badge">{badge}</span>}
      </span>
      <span className="settings-row__desc">{description}</span>
    </div>
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`settings-toggle ${checked ? 'settings-toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <motion.span
        className="settings-toggle__thumb"
        animate={{ x: checked ? 20 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 38 }}
      />
    </button>
  </div>
);

const SectionHeader: React.FC<{ title: string }> = ({ title }) => (
  <p className="settings-section-header">{title}</p>
);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { isMuted, setMuted, isTurboMode, setTurboMode } = useFeedStore();
  const network = useNetworkQuality();

  const [cacheCleared,   setCacheCleared  ] = useState(false);
  const [dbCleared,      setDbCleared     ] = useState(false);
  const [swVersion,      setSwVersion     ] = useState<string | null>(null);
  const [dbStats,        setDbStats       ] = useState<{
    bookmarks: number; progress: number; recentlyViewed: number; total: number;
  } | null>(null);
  const [dbDiagnostics, setDbDiagnostics] = useState<IndexedDbDiagnostics>(
    getIndexedDbDiagnostics()
  );
  const [catalogInfo, setCatalogInfo] = useState<{
    isCached: boolean; ageMs: number | null; isStale: boolean; totalItems: number | null;
  } | null>(null);

  useEffect(() => {
    navigator.serviceWorker?.getRegistration('/').then((reg) => {
      if (reg?.active) setSwVersion('flicker-tv-v1.0.0');
    });

    void getDatabaseSizeEstimate().then((stats) => {
      setDbStats(stats);
      setDbDiagnostics(getIndexedDbDiagnostics());
    });

    setCatalogInfo(getCatalogCacheInfo());
  }, []);

  const handleClearSwCache = useCallback(async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((name) => caches.delete(name)));
    invalidateCatalogCache();
    setCacheCleared(true);
    setCatalogInfo(getCatalogCacheInfo());
    setTimeout(() => setCacheCleared(false), 2500);
  }, []);

  const handleClearDatabase = useCallback(async () => {
    await clearAllData();
    const stats = await getDatabaseSizeEstimate();
    setDbStats(stats);
    setDbDiagnostics(getIndexedDbDiagnostics());
    setDbCleared(true);
    setTimeout(() => setDbCleared(false), 2500);
  }, []);

  const handleUninstallSW = useCallback(async () => {
    const registrations = await navigator.serviceWorker?.getRegistrations();
    if (registrations) {
      await Promise.all(registrations.map((r) => r.unregister()));
    }
    window.location.reload();
  }, []);

  const catalogAgeLabel = catalogInfo?.ageMs != null
    ? catalogInfo.ageMs < 60_000
      ? 'Just now'
      : catalogInfo.ageMs < 3_600_000
      ? `${Math.floor(catalogInfo.ageMs / 60_000)}m ago`
      : `${Math.floor(catalogInfo.ageMs / 3_600_000)}h ago`
    : 'Not loaded';

  return (
    <>
      <style>{SETTINGS_STYLES}</style>

      <div className="settings-root">
        <header className="settings-header">
          <h1 className="settings-header__title">
            <span>Settings</span>
          </h1>
        </header>

        <main className="settings-main">
          {/* ── Playback ── */}
          <SectionHeader title="PLAYBACK" />
          <div className="settings-card">
            <ToggleRow
              label="Mute by Default"
              description="Trailers start muted. Tap the speaker icon to unmute."
              checked={isMuted}
              onChange={setMuted}
            />
            <div className="settings-divider" />
            <ToggleRow
              label="Turbo Mode"
              description="Disables video autoplay on slow connections to save data."
              checked={isTurboMode}
              onChange={setTurboMode}
              badge={network.isTurboMode && !isTurboMode ? 'Auto-on' : undefined}
            />
          </div>

          {/* ── Network ── */}
          <SectionHeader title="NETWORK" />
          <div className="settings-card settings-card--info">
            <div className="network-info-row">
              <span className="network-info-row__label">Connection</span>
              <span className="network-info-row__value network-info-row__value--badge">
                {network.effectiveType.toUpperCase()}
              </span>
            </div>
            {network.downlinkMbps !== undefined && (
              <div className="network-info-row">
                <span className="network-info-row__label">Estimated Speed</span>
                <span className="network-info-row__value">
                  {network.downlinkMbps.toFixed(1)} Mbps
                </span>
              </div>
            )}
            {network.rttMs !== undefined && (
              <div className="network-info-row">
                <span className="network-info-row__label">Round-Trip Time</span>
                <span className="network-info-row__value">{network.rttMs} ms</span>
              </div>
            )}
            <div className="network-info-row">
              <span className="network-info-row__label">Online</span>
              <span className={`network-info-row__value ${network.isOnline ? 'network-info-row__value--on' : 'network-info-row__value--error'}`}>
                {network.isOnline ? '● Online' : '● Offline'}
              </span>
            </div>
          </div>

          {/* ── Catalog ── */}
          <SectionHeader title="FILM CATALOG" />
          <div className="settings-card settings-card--info">
            <div className="network-info-row">
              <span className="network-info-row__label">Cache Status</span>
              <span className={`network-info-row__value ${catalogInfo?.isCached ? 'network-info-row__value--on' : ''}`}>
                {catalogInfo?.isCached ? '● Cached' : '● Empty'}
              </span>
            </div>
            {catalogInfo?.isCached && (
              <>
                <div className="network-info-row">
                  <span className="network-info-row__label">Films Cached</span>
                  <span className="network-info-row__value">
                    {catalogInfo.totalItems ?? '—'}
                  </span>
                </div>
                <div className="network-info-row">
                  <span className="network-info-row__label">Cache Age</span>
                  <span className={`network-info-row__value ${catalogInfo.isStale ? 'network-info-row__value--error' : ''}`}>
                    {catalogAgeLabel}
                    {catalogInfo.isStale ? ' (stale)' : ''}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* ── Storage ── */}
          <SectionHeader title="STORAGE & CACHE" />
          <div className="settings-card">
            <div className="network-info-row">
              <span className="network-info-row__label">IndexedDB</span>
              <span
                className={`network-info-row__value ${
                  dbDiagnostics.status === 'available'
                    ? 'network-info-row__value--on'
                    : dbDiagnostics.status === 'error'
                    ? 'network-info-row__value--error'
                    : ''
                }`}
              >
                {dbDiagnostics.status === 'available'
                  ? '● Available'
                  : dbDiagnostics.status === 'error'
                  ? '● Unavailable'
                  : '● Checking'}
              </span>
            </div>
            {dbDiagnostics.status === 'error' && dbDiagnostics.message && (
              <p className="settings-storage-error" role="status">
                Storage diagnostics: {dbDiagnostics.message}
              </p>
            )}
            <div className="settings-divider" />

            <div className="settings-action-row">
              <div className="settings-row__text">
                <span className="settings-row__label">Clear Film Cache</span>
                <span className="settings-row__desc">
                  Removes cached posters, API responses, and the in-memory catalog.
                </span>
              </div>
              <button
                className={`settings-action-btn ${cacheCleared ? 'settings-action-btn--done' : ''}`}
                onClick={handleClearSwCache}
              >
                {cacheCleared ? '✓ Cleared' : 'Clear'}
              </button>
            </div>

            <div className="settings-divider" />

            <div className="settings-action-row">
              <div className="settings-row__text">
                <span className="settings-row__label">Clear Watchlist Data</span>
                <span className="settings-row__desc">
                  {dbStats
                    ? `${dbStats.bookmarks} bookmarks · ${dbStats.progress} progress records · ${dbStats.recentlyViewed} history items`
                    : 'Bookmarks, watch progress, and viewing history.'}
                </span>
              </div>
              <button
                className={`settings-action-btn settings-action-btn--danger ${dbCleared ? 'settings-action-btn--done' : ''}`}
                onClick={handleClearDatabase}
              >
                {dbCleared ? '✓ Cleared' : 'Clear'}
              </button>
            </div>

            {swVersion && (
              <>
                <div className="settings-divider" />
                <div className="settings-action-row">
                  <div className="settings-row__text">
                    <span className="settings-row__label">Service Worker</span>
                    <span className="settings-row__desc">{swVersion}</span>
                  </div>
                  <button
                    className="settings-action-btn settings-action-btn--danger"
                    onClick={handleUninstallSW}
                  >
                    Reset
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ── About ── */}
          <SectionHeader title="ABOUT" />
          <div className="settings-card settings-card--info">
            <div className="network-info-row">
              <span className="network-info-row__label">App</span>
              <span className="network-info-row__value">Flicker.TV</span>
            </div>
            <div className="network-info-row">
              <span className="network-info-row__label">Tagline</span>
              <span className="network-info-row__value">The MovieDom</span>
            </div>
            <div className="network-info-row">
              <span className="network-info-row__label">Version</span>
              <span className="network-info-row__value">0.1.0</span>
            </div>
            <div className="network-info-row">
              <span className="network-info-row__label">Catalog Source</span>
              <span className="network-info-row__value">Internet Archive</span>
            </div>
            <div className="network-info-row">
              <span className="network-info-row__label">Content License</span>
              <span className="network-info-row__value">Public Domain</span>
            </div>
            <div className="network-info-row">
              <span className="network-info-row__label">Schema Version</span>
              <span className="network-info-row__value">1.0.0</span>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const SETTINGS_STYLES = `
  .settings-root {
    min-height: 100dvh;
    background: #0a0a0f;
    color: #fff;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex;
    flex-direction: column;
    padding-bottom: calc(80px + env(safe-area-inset-bottom, 0px));
  }
  .settings-header {
    padding: calc(16px + env(safe-area-inset-top, 0px)) 20px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
  }
  .settings-header__title {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  .settings-header__title span { color: #c8a96e; }
  .settings-main {
    padding: 8px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .settings-section-header {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: rgba(255,255,255,0.35);
    text-transform: uppercase;
    padding: 20px 4px 8px;
    margin: 0;
  }
  .settings-card {
    background: #17171f;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 16px;
    overflow: hidden;
  }
  .settings-card--info { padding: 0; }
  .settings-divider {
    height: 1px;
    background: rgba(255,255,255,0.06);
    margin: 0 16px;
  }
  .settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px;
  }
  .settings-row--disabled { opacity: 0.45; pointer-events: none; }
  .settings-row__text {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }
  .settings-row__label {
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .settings-row__badge {
    padding: 2px 7px;
    border-radius: 100px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    background: rgba(200,169,110,0.15);
    border: 1px solid rgba(200,169,110,0.25);
    color: #c8a96e;
  }
  .settings-row__desc {
    font-size: 12px;
    color: rgba(255,255,255,0.4);
    line-height: 1.45;
  }
  .settings-toggle {
    width: 44px;
    height: 26px;
    border-radius: 13px;
    border: none;
    background: rgba(255,255,255,0.12);
    cursor: pointer;
    padding: 0;
    position: relative;
    flex-shrink: 0;
    transition: background 0.2s ease;
  }
  .settings-toggle--on {
    background: linear-gradient(135deg, #c8a96e, #e8c98a);
  }
  .settings-toggle__thumb {
    display: block;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
    position: absolute;
    top: 2px;
  }
  .network-info-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 11px 16px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  .network-info-row:last-child { border-bottom: none; }
  .network-info-row__label {
    font-size: 13px;
    color: rgba(255,255,255,0.5);
  }
  .network-info-row__value {
    font-size: 13px;
    font-weight: 600;
    color: rgba(255,255,255,0.85);
    font-variant-numeric: tabular-nums;
  }
  .network-info-row__value--badge {
    padding: 2px 8px;
    border-radius: 100px;
    background: rgba(200,169,110,0.15);
    color: #c8a96e;
    font-size: 11px;
    letter-spacing: 0.06em;
  }
  .network-info-row__value--on    { color: #4ade80; }
  .network-info-row__value--error { color: #f87171; }
  .settings-storage-error {
    margin: 0;
    padding: 0 16px 12px;
    color: #fca5a5;
    font-size: 11px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .settings-action-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px;
  }
  .settings-action-btn {
    padding: 8px 16px;
    border-radius: 100px;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.07);
    color: rgba(255,255,255,0.75);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    letter-spacing: 0.03em;
    white-space: nowrap;
    transition: background 0.15s ease, color 0.15s ease;
    flex-shrink: 0;
    font-family: inherit;
  }
  .settings-action-btn:hover { background: rgba(255,255,255,0.12); }
  .settings-action-btn--done {
    background: rgba(74,222,128,0.12);
    color: #4ade80;
    border-color: rgba(74,222,128,0.25);
  }
  .settings-action-btn--danger {
    background: rgba(248,113,113,0.1);
    color: #f87171;
    border-color: rgba(248,113,113,0.2);
  }
  .settings-action-btn--danger:hover { background: rgba(248,113,113,0.2); }
`;