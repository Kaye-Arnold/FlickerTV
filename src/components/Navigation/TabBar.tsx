'use client';

import React, { useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

interface TabDefinition {
  id: string;
  label: string;
  href: string;
  icon: (active: boolean) => React.ReactNode;
}

const TABS: TabDefinition[] = [
  {
    id: 'discover',
    label: 'Discover',
    href: '/',
    icon: (active) => (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill={active ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={active ? 0 : 1.75}
      >
        <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    id: 'search',
    label: 'Search',
    href: '/search',
    icon: (active) => (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.25 : 1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
  },
  {
    id: 'watchlist',
    label: 'Watchlist',
    href: '/watchlist',
    icon: (active) => (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill={active ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={active ? 0 : 1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    href: '/settings',
    icon: (active) => (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={active ? 2.25 : 1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const TabBar: React.FC = () => {
  const pathname = usePathname();
  const router = useRouter();

  const handleTabPress = useCallback(
    (href: string) => {
      router.push(href);
    },
    [router]
  );

  return (
    <>
      <style>{TAB_BAR_STYLES}</style>

      <nav className="tab-bar" role="navigation" aria-label="Main navigation">
        {TABS.map((tab) => {
          const isActive =
            tab.href === '/'
              ? pathname === '/'
              : pathname.startsWith(tab.href);

          return (
            <button
              key={tab.id}
              className={`tab-bar__item ${isActive ? 'tab-bar__item--active' : ''}`}
              onClick={() => handleTabPress(tab.href)}
              aria-label={tab.label}
              aria-current={isActive ? 'page' : undefined}
              role="link"
            >
              <div className="tab-bar__icon-wrapper">
                {/* Active indicator pill */}
                {isActive && (
                  <motion.div
                    layoutId="tab-active-pill"
                    className="tab-bar__active-pill"
                    initial={false}
                    transition={{
                      type: 'spring',
                      stiffness: 480,
                      damping: 38,
                    }}
                  />
                )}
                <span className="tab-bar__icon">
                  {tab.icon(isActive)}
                </span>
              </div>
              <span className="tab-bar__label">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
};

const TAB_BAR_STYLES = `
  .tab-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    display: flex;
    align-items: flex-start;
    justify-content: space-around;
    padding: 10px 8px calc(10px + env(safe-area-inset-bottom, 0px));
    background: rgba(10, 10, 22, 0.85);
    backdrop-filter: blur(20px) saturate(1.6);
    -webkit-backdrop-filter: blur(20px) saturate(1.6);
    border-top: 1px solid rgba(255, 255, 255, 0.07);
  }

  .tab-bar__item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    flex: 1;
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 0;
    color: rgba(255, 255, 255, 0.38);
    transition: color 0.18s ease;
    -webkit-tap-highlight-color: transparent;
    user-select: none;
  }

  .tab-bar__item--active {
    color: #c8a96e;
  }

  .tab-bar__icon-wrapper {
    position: relative;
    width: 48px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .tab-bar__active-pill {
    position: absolute;
    inset: 0;
    border-radius: 100px;
    background: rgba(200, 169, 110, 0.14);
  }

  .tab-bar__icon {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }

  .tab-bar__label {
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.03em;
    line-height: 1;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
`;

export default TabBar;