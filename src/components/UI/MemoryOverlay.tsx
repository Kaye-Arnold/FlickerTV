'use client';

import React, { useEffect, useState } from 'react';
import { getVideoCacheManager, type CacheMetrics } from '@/lib/memory/VideoCacheManager';
import { formatBytes } from '@/lib/utils/formatters';

/**
 * MemoryOverlay — Development / debug overlay
 *
 * Renders a floating panel showing real-time VideoCacheManager metrics.
 * Only mounts when process.env.NODE_ENV === 'development' OR
 * NEXT_PUBLIC_ENABLE_MEMORY_OVERLAY === 'true'.
 *
 * Keyboard shortcut: Shift+M toggles visibility.
 */

const POLL_INTERVAL_MS = 1000;

const MemoryOverlay: React.FC = () => {
  const [metrics, setMetrics] = useState<CacheMetrics | null>(null);
  const [visible, setVisible] = useState(true);

  const isEnabled =
    process.env.NODE_ENV === 'development' ||
    process.env.NEXT_PUBLIC_ENABLE_MEMORY_OVERLAY === 'true';

  useEffect(() => {
    if (!isEnabled || typeof window === 'undefined') return;

    const poll = () => {
      try {
        const mgr = getVideoCacheManager();
        setMetrics(mgr.getMetrics());
      } catch {
        // Manager not yet initialised.
      }
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isEnabled]);

  useEffect(() => {
    if (!isEnabled) return;

    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && e.code === 'KeyM') {
        setVisible((v) => !v);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isEnabled]);

  if (!isEnabled || !metrics || !visible) return null;

  const usagePercent = Math.round(
    (metrics.totalResidentBytes / (512 * 1024 * 1024)) * 100
  );

  const barColor =
    usagePercent > 80
      ? '#f87171'
      : usagePercent > 50
      ? '#fbbf24'
      : '#4ade80';

  return (
    <>
      <style>{OVERLAY_STYLES}</style>

      <div className="mem-overlay" role="status" aria-label="Memory usage overlay">
        <div className="mem-overlay__header">
          <span className="mem-overlay__title">VideoCacheManager</span>
          <button
            className="mem-overlay__close"
            onClick={() => setVisible(false)}
            aria-label="Close memory overlay"
          >
            ✕
          </button>
        </div>

        {/* Usage bar */}
        <div className="mem-overlay__bar-track">
          <div
            className="mem-overlay__bar-fill"
            style={{ width: `${usagePercent}%`, backgroundColor: barColor }}
          />
        </div>

        {/* Metrics grid */}
        <div className="mem-overlay__grid">
          <MetricRow label="Resident"   value={formatBytes(metrics.totalResidentBytes)} />
          <MetricRow label="Usage"      value={`${usagePercent}% of 512 MB`} />
          <MetricRow label="Registries" value={String(metrics.totalRegistries)} />
          <MetricRow label="Chunks"     value={String(metrics.totalChunks)} />
          <MetricRow label="Revocations" value={String(metrics.totalRevocations)} />
          <MetricRow label="Evictions"  value={String(metrics.totalEvictions)} />
          <MetricRow
            label="OOM Guards"
            value={String(metrics.oomGuardActivations)}
            highlight={metrics.oomGuardActivations > 0}
          />
        </div>

        <p className="mem-overlay__hint">Shift+M to toggle</p>
      </div>
    </>
  );
};

const MetricRow: React.FC<{
  label: string;
  value: string;
  highlight?: boolean;
}> = ({ label, value, highlight = false }) => (
  <div className="mem-metric-row">
    <span className="mem-metric-row__label">{label}</span>
    <span
      className="mem-metric-row__value"
      style={highlight ? { color: '#f87171' } : undefined}
    >
      {value}
    </span>
  </div>
);

const OVERLAY_STYLES = `
  .mem-overlay {
    position: fixed;
    bottom: calc(90px + env(safe-area-inset-bottom, 0px));
    right: 16px;
    z-index: 9500;
    width: 240px;
    background: rgba(8, 8, 16, 0.95);
    border: 1px solid rgba(200,169,110,0.25);
    border-radius: 14px;
    padding: 12px 14px;
    font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
    font-size: 11px;
    color: rgba(255,255,255,0.75);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  }

  .mem-overlay__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }

  .mem-overlay__title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #c8a96e;
  }

  .mem-overlay__close {
    background: none;
    border: none;
    color: rgba(255,255,255,0.35);
    cursor: pointer;
    font-size: 11px;
    padding: 0;
    line-height: 1;
    font-family: inherit;
  }

  .mem-overlay__bar-track {
    height: 4px;
    border-radius: 2px;
    background: rgba(255,255,255,0.1);
    overflow: hidden;
    margin-bottom: 10px;
  }

  .mem-overlay__bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.5s ease, background-color 0.3s ease;
  }

  .mem-overlay__grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .mem-metric-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 0;
  }

  .mem-metric-row__label {
    color: rgba(255,255,255,0.4);
    font-size: 10px;
  }

  .mem-metric-row__value {
    color: rgba(255,255,255,0.82);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  .mem-overlay__hint {
    margin: 8px 0 0;
    font-size: 9px;
    color: rgba(255,255,255,0.2);
    text-align: right;
    letter-spacing: 0.05em;
  }
`;

export default MemoryOverlay;