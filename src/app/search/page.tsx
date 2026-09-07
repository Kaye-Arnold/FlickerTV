'use client';

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { searchArchiveOrg, type ArchiveFilmResult } from '@/lib/api/archiveOrg';
import { useFeedStore } from '@/lib/store/feedStore';
import type { CinemaCard } from '@/components/Feed/SwiperFeed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function archiveResultToCinemaCard(result: ArchiveFilmResult): CinemaCard {
  return {
    tmdbId:         result.identifier,
    movieTitle:     result.title,
    releaseYear:    result.year ?? 1920,
    directorName:   result.creator ?? 'Unknown',
    synopsis:       result.description ?? 'A classic public domain film from the Internet Archive.',
    trailerUrl:     result.streamUrl,
    posterWebpUrl:  result.thumbnailUrl,
    backdropUrl:    result.thumbnailUrl,
    runtimeMinutes: result.runtimeMinutes ?? 60,
    genres:         result.subject?.slice(0, 3) ?? ['Silent', 'Classic'],
    archiveOrgUrl:  `https://archive.org/details/${result.identifier}`,
    rating:         undefined,
  };
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

const SearchResultSkeleton: React.FC = () => (
  <div className="search-skeleton">
    {Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className="search-skeleton__card">
        <div className="search-skeleton__poster" />
        <div className="search-skeleton__meta">
          <div className="search-skeleton__bar search-skeleton__bar--title" />
          <div className="search-skeleton__bar search-skeleton__bar--sub" />
          <div className="search-skeleton__bar search-skeleton__bar--narrow" />
        </div>
      </div>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Result card
// ---------------------------------------------------------------------------

const SearchResultCard: React.FC<{
  card:         CinemaCard;
  index:        number;
  isBookmarked: boolean;
  onBookmark:   (tmdbId: string) => void;
  onWatch:      (card: CinemaCard) => void;
}> = ({ card, index, isBookmarked, onBookmark, onWatch }) => (
  <motion.div
    className="search-result-card"
    initial={{ opacity: 0, y: 14 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay: index * 0.035, duration: 0.28 }}
  >
    <div className="search-result-card__poster-wrap">
      <img
        src={card.posterWebpUrl}
        alt={card.movieTitle}
        className="search-result-card__poster"
        loading="lazy"
        decoding="async"
        onError={(e) => {
          (e.target as HTMLImageElement).src =
            'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="150" viewBox="0 0 100 150"%3E%3Crect width="100" height="150" fill="%2317171f"/%3E%3Ctext x="50" y="80" text-anchor="middle" fill="%23444" font-size="28"%3E🎬%3C/text%3E%3C/svg%3E';
        }}
      />
    </div>

    <div className="search-result-card__meta">
      <div className="search-result-card__header">
        <div>
          <p className="search-result-card__title">{card.movieTitle}</p>
          <p className="search-result-card__year-director">
            {card.releaseYear} · {card.directorName}
          </p>
        </div>

        <button
          className={`search-result-card__bookmark ${
            isBookmarked ? 'search-result-card__bookmark--active' : ''
          }`}
          onClick={() => onBookmark(card.tmdbId)}
          aria-label={
            isBookmarked
              ? `Remove ${card.movieTitle} from watchlist`
              : `Add ${card.movieTitle} to watchlist`
          }
        >
          {isBookmarked ? '🔖' : '🎞'}
        </button>
      </div>

      <div className="search-result-card__genres">
        {card.genres.slice(0, 3).map((g) => (
          <span key={g} className="search-result-card__genre">{g}</span>
        ))}
      </div>

      <p className="search-result-card__synopsis">{card.synopsis}</p>

      <div className="search-result-card__actions">
        <button
          type="button"
          onClick={() => onWatch(card)}
          className="search-result-card__watch-btn"
        >
          Watch Free
        </button>
        <span className="search-result-card__runtime">
          {Math.floor(card.runtimeMinutes / 60)}h {card.runtimeMinutes % 60}m
        </span>
      </div>
    </div>
  </motion.div>
);

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

const EmptyState: React.FC<{ query: string }> = ({ query }) => (
  <motion.div
    className="search-empty"
    initial={{ opacity: 0, y: 12 }}
    animate={{ opacity: 1, y: 0 }}
  >
    <span className="search-empty__icon">🔭</span>
    <p className="search-empty__title">No films found</p>
    <p className="search-empty__desc">
      No public domain results for <strong>"{query}"</strong>.
      Try a different title or director.
    </p>
  </motion.div>
);

// ---------------------------------------------------------------------------
// Genre quick-filters
// ---------------------------------------------------------------------------

const GENRE_FILTERS = [
  { label: '🎭 All',        query: 'silent film public domain' },
  { label: '👻 Horror',     query: 'horror silent film public domain' },
  { label: '😂 Comedy',     query: 'comedy chaplin keaton public domain' },
  { label: '🚂 Action',     query: 'adventure action silent film archive' },
  { label: '🤍 Romance',    query: 'romance drama silent film public domain' },
  { label: '🏛 Historical', query: 'historical documentary silent film archive' },
  { label: '🚀 Sci-Fi',     query: 'science fiction silent film metropolis' },
  { label: '🃏 Crime',      query: 'crime mystery thriller silent film archive' },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SearchPage() {
  const router = useRouter();
  const [query,           setQuery          ] = useState('');
  const [committedQuery,  setCommittedQuery  ] = useState('');
  const [results,         setResults        ] = useState<CinemaCard[]>([]);
  const [hasSearched,     setHasSearched    ] = useState(false);
  const [error,           setError          ] = useState<string | null>(null);
  const [isPending,       startTransition   ] = useTransition();
  const [isLoading,       setIsLoading      ] = useState(false);
  const [activeGenreIndex, setActiveGenreIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const searchGenerationRef = useRef(0);

  const { bookmarkedIds, toggleBookmark, appendToReel } = useFeedStore();

  // ---------------------------------------------------------------------------
  // Core search execution — stable reference, no external deps that change.
  // appendToReel and startTransition are stable; setters from useState are
  // stable by spec. This callback is intentionally defined without re-declaring
  // on every render so the mount effect below can list it as a dependency
  // without triggering re-runs.
  // ---------------------------------------------------------------------------

  const executeSearch = useCallback(async (searchQuery: string) => {
    const normalizedQuery = searchQuery.trim();
    const generation = ++searchGenerationRef.current;

    abortRef.current?.abort();
    abortRef.current = null;

    if (!normalizedQuery) {
      setResults([]);
      setHasSearched(false);
      setCommittedQuery('');
      setError(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);
    setCommittedQuery(searchQuery);

    try {
      const raw = await searchArchiveOrg(normalizedQuery, {
        limit: 20,
        signal: controller.signal,
      });

      if (
        controller.signal.aborted ||
        generation !== searchGenerationRef.current
      ) {
        return;
      }

      const cards = raw.map(archiveResultToCinemaCard);
      startTransition(() => {
        if (generation !== searchGenerationRef.current) return;
        setResults(cards);
        setHasSearched(true);
        appendToReel(cards);
      });
    } catch (error: unknown) {
      if (
        controller.signal.aborted ||
        generation !== searchGenerationRef.current
      ) {
        return;
      }

      const errorName =
        error instanceof DOMException || error instanceof Error ? error.name : '';
      if (errorName === 'AbortError') return;

      console.error('[SearchPage] Search request failed:', error);
      setError(
        'Could not reach the archive index. Check your connection and try again.'
      );
      setResults([]);
      setHasSearched(true);
    } finally {
      if (generation === searchGenerationRef.current) {
        setIsLoading(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    }
  }, [appendToReel]); // appendToReel is stable (Zustand action ref is stable)

  // ---------------------------------------------------------------------------
  // C8 FIX: Mount-only effect with stable callback dependency.
  //
  // Previously this used an empty dependency array with an eslint-disable
  // comment suppressing the exhaustive-deps warning, masking a stale-closure
  // risk in React Strict Mode (double-invocation in dev fires executeSearch
  // twice on the same AbortController generation).
  //
  // Fix: extract the mount-only search call into its own useCallback that
  // captures the default genre query at definition time (closed over constant
  // GENRE_FILTERS[0].query — not a reactive value). executeSearch IS listed
  // as a dependency. Because executeSearch is wrapped in useCallback with
  // [appendToReel] as its only dep, and appendToReel is a stable Zustand
  // action reference, this effect runs exactly once after mount in both normal
  // and Strict Mode (the abort controller cleanly cancels the first invocation
  // on Strict Mode's unmount/remount cycle before the second fires).
  // ---------------------------------------------------------------------------

  const runDefaultSearch = useCallback(() => {
    const defaultFilter = GENRE_FILTERS[0];
    if (defaultFilter) {
      executeSearch(defaultFilter.query);
    }
  }, [executeSearch]);

  useEffect(() => {
    runDefaultSearch();
    return () => {
      searchGenerationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [runDefaultSearch]);

  // ---------------------------------------------------------------------------
  // Input handlers
  // ---------------------------------------------------------------------------

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setQuery(val);

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void executeSearch(val);
      }, 480);
    },
    [executeSearch]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      executeSearch(query);
      inputRef.current?.blur();
    },
    [query, executeSearch]
  );

  const handleClear = useCallback(() => {
    searchGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setQuery('');
    setCommittedQuery('');
    setResults([]);
    setHasSearched(false);
    setError(null);
    setIsLoading(false);
    inputRef.current?.focus();
  }, []);

  const handleGenreFilter = useCallback(
    (genreQuery: string, index: number) => {
      setActiveGenreIndex(index);
      setQuery('');
      if (debounceRef.current) clearTimeout(debounceRef.current);
      executeSearch(genreQuery);
    },
    [executeSearch]
  );

  const handleBookmark = useCallback(
    (tmdbId: string) => { toggleBookmark(tmdbId); },
    [toggleBookmark]
  );

  const handleWatch = useCallback(
    (card: CinemaCard) => {
      appendToReel([card]);
      router.push(`/watch/${encodeURIComponent(card.tmdbId)}`);
    },
    [appendToReel, router]
  );

  const showSkeleton = isLoading || isPending;
  const showEmpty    = !showSkeleton && hasSearched && results.length === 0 && !error;
  const showResults  = !showSkeleton && results.length > 0;

  return (
    <>
      <style>{SEARCH_STYLES}</style>

      <div className="search-root">
        <div className="search-sticky-header">
          <div className="search-top-bar">
            <h1 className="search-top-bar__wordmark">
              Flicker<span>.</span>TV
            </h1>
          </div>

          <form
            className="search-input-wrap"
            onSubmit={handleSubmit}
            role="search"
            aria-label="Search public domain films"
          >
            <span className="search-input-wrap__icon" aria-hidden="true">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input
              ref={inputRef}
              type="search"
              inputMode="search"
              enterKeyHint="search"
              className="search-input"
              value={query}
              onChange={handleInputChange}
              placeholder="Directors, titles, eras…"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Search films"
            />
            <AnimatePresence>
              {query.length > 0 && (
                <motion.button
                  key="clear"
                  type="button"
                  className="search-input-wrap__clear"
                  onClick={handleClear}
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  transition={{ duration: 0.15 }}
                  aria-label="Clear search"
                >
                  ✕
                </motion.button>
              )}
            </AnimatePresence>
          </form>

          <div
            className="search-genre-chips"
            role="listbox"
            aria-label="Filter by genre"
          >
            {GENRE_FILTERS.map((filter, i) => (
              <button
                key={filter.label}
                role="option"
                aria-selected={activeGenreIndex === i}
                className={`search-genre-chip ${
                  activeGenreIndex === i ? 'search-genre-chip--active' : ''
                }`}
                onClick={() => handleGenreFilter(filter.query, i)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        <main className="search-results-area">
          <AnimatePresence mode="wait">
            {showResults && (
              <motion.p
                key="count"
                className="search-result-count"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {committedQuery
                  ? `${results.length} films for "${committedQuery}"`
                  : `${results.length} films`}
              </motion.p>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {error && (
              <motion.div
                key="error"
                className="search-error"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <span>⚠️</span>
                <p>{error}</p>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showSkeleton && (
              <motion.div
                key="skeleton"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <SearchResultSkeleton />
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence mode="wait">
            {showResults && (
              <motion.div
                key="results"
                className="search-results-list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {results.map((card, i) => (
                  <SearchResultCard
                    key={card.tmdbId}
                    card={card}
                    index={i}
                    isBookmarked={bookmarkedIds.has(card.tmdbId)}
                    onBookmark={handleBookmark}
                    onWatch={handleWatch}
                  />
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showEmpty && <EmptyState key="empty" query={committedQuery} />}
          </AnimatePresence>
        </main>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const SEARCH_STYLES = `
  .search-root {
    min-height: 100dvh;
    background: #0a0a0f;
    color: #fff;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    display: flex;
    flex-direction: column;
    padding-bottom: calc(80px + env(safe-area-inset-bottom, 0px));
  }

  .search-sticky-header {
    position: sticky;
    top: 0;
    z-index: 50;
    background: rgba(10, 10, 22, 0.95);
    backdrop-filter: blur(16px) saturate(1.5);
    -webkit-backdrop-filter: blur(16px) saturate(1.5);
    border-bottom: 1px solid rgba(255,255,255,0.06);
    padding-bottom: 10px;
  }

  .search-top-bar {
    display: flex;
    align-items: center;
    padding: calc(14px + env(safe-area-inset-top, 0px)) 20px 10px;
  }

  .search-top-bar__wordmark {
    font-size: 22px;
    font-weight: 900;
    letter-spacing: -0.04em;
    color: #fff;
  }

  .search-top-bar__wordmark span { color: #c8a96e; }

  .search-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
    margin: 0 16px 10px;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 14px;
    overflow: hidden;
    transition: border-color 0.2s ease, background 0.2s ease;
  }

  .search-input-wrap:focus-within {
    background: rgba(255,255,255,0.1);
    border-color: rgba(200,169,110,0.4);
  }

  .search-input-wrap__icon {
    display: flex;
    align-items: center;
    padding: 0 12px 0 14px;
    color: rgba(255,255,255,0.38);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    height: 46px;
    background: none;
    border: none;
    outline: none;
    color: #fff;
    font-size: 15px;
    font-family: inherit;
    caret-color: #c8a96e;
    padding: 0;
  }

  .search-input::placeholder { color: rgba(255,255,255,0.3); }
  .search-input::-webkit-search-cancel-button { display: none; }

  .search-input-wrap__clear {
    background: rgba(255,255,255,0.1);
    border: none;
    color: rgba(255,255,255,0.5);
    width: 26px;
    height: 26px;
    border-radius: 50%;
    margin-right: 12px;
    cursor: pointer;
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s ease;
  }

  .search-input-wrap__clear:hover { background: rgba(255,255,255,0.2); }

  .search-genre-chips {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 0 16px;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .search-genre-chips::-webkit-scrollbar { display: none; }

  .search-genre-chip {
    padding: 7px 14px;
    border-radius: 100px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.05);
    color: rgba(255,255,255,0.55);
    font-family: inherit;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    flex-shrink: 0;
  }

  .search-genre-chip--active {
    background: rgba(200,169,110,0.15);
    border-color: rgba(200,169,110,0.4);
    color: #e8c98a;
  }

  .search-results-area {
    flex: 1;
    padding: 14px 16px 0;
  }

  .search-result-count {
    font-size: 12px;
    color: rgba(255,255,255,0.35);
    letter-spacing: 0.03em;
    margin: 0 0 12px;
  }

  .search-results-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .search-result-card {
    display: flex;
    gap: 14px;
    background: #17171f;
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 16px;
    overflow: hidden;
  }

  .search-result-card__poster-wrap {
    width: 88px;
    flex-shrink: 0;
    background: #111118;
    overflow: hidden;
  }

  .search-result-card__poster {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center top;
    display: block;
    min-height: 130px;
  }

  .search-result-card__meta {
    flex: 1;
    min-width: 0;
    padding: 12px 14px 12px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .search-result-card__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  .search-result-card__title {
    font-size: 14px;
    font-weight: 700;
    line-height: 1.2;
    margin: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .search-result-card__year-director {
    font-size: 11px;
    color: #c8a96e;
    margin: 3px 0 0;
  }

  .search-result-card__bookmark {
    background: none;
    border: none;
    font-size: 18px;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    opacity: 0.5;
    transition: opacity 0.15s ease, transform 0.15s ease;
    line-height: 1;
  }

  .search-result-card__bookmark--active { opacity: 1; }
  .search-result-card__bookmark:active  { transform: scale(0.88); }

  .search-result-card__genres {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .search-result-card__genre {
    padding: 2px 7px;
    border-radius: 100px;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: rgba(200,169,110,0.08);
    border: 1px solid rgba(200,169,110,0.18);
    color: rgba(200,169,110,0.75);
  }

  .search-result-card__synopsis {
    font-size: 12px;
    line-height: 1.5;
    color: rgba(255,255,255,0.45);
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .search-result-card__actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 2px;
  }

  .search-result-card__watch-btn {
    display: inline-flex;
    align-items: center;
    padding: 6px 14px;
    border-radius: 100px;
    background: linear-gradient(135deg, #c8a96e, #e8c98a);
    color: #0a0a0f;
    font-size: 11px;
    font-weight: 700;
    text-decoration: none;
    border: none;
    font-family: inherit;
    cursor: pointer;
    letter-spacing: 0.02em;
    transition: opacity 0.15s ease;
    white-space: nowrap;
  }

  .search-result-card__watch-btn:hover { opacity: 0.88; }

  .search-result-card__runtime {
    font-size: 11px;
    color: rgba(255,255,255,0.3);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .search-skeleton {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .search-skeleton__card {
    display: flex;
    gap: 14px;
    background: #17171f;
    border: 1px solid rgba(255,255,255,0.05);
    border-radius: 16px;
    overflow: hidden;
    height: 130px;
  }

  .search-skeleton__poster {
    width: 88px;
    flex-shrink: 0;
    background: linear-gradient(90deg, #1c1c2a 25%, #252535 50%, #1c1c2a 75%);
    background-size: 200% 100%;
    animation: searchShimmer 1.6s infinite;
  }

  .search-skeleton__meta {
    flex: 1;
    padding: 16px 14px 16px 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    justify-content: center;
  }

  .search-skeleton__bar {
    height: 12px;
    border-radius: 6px;
    background: linear-gradient(90deg, #1c1c2a 25%, #252535 50%, #1c1c2a 75%);
    background-size: 200% 100%;
    animation: searchShimmer 1.6s infinite;
  }

  .search-skeleton__bar--title  { width: 70%; }
  .search-skeleton__bar--sub    { width: 45%; }
  .search-skeleton__bar--narrow { width: 35%; }

  @keyframes searchShimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .search-error {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 14px 16px;
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.2);
    border-radius: 14px;
    margin-bottom: 16px;
    font-size: 13px;
    color: rgba(255,255,255,0.7);
    line-height: 1.5;
  }

  .search-error p { margin: 0; }

  .search-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 40vh;
    gap: 10px;
    text-align: center;
    padding: 0 32px;
  }

  .search-empty__icon {
    font-size: 44px;
    margin-bottom: 4px;
    opacity: 0.55;
  }

  .search-empty__title {
    font-size: 17px;
    font-weight: 700;
    margin: 0;
    color: rgba(255,255,255,0.7);
  }

  .search-empty__desc {
    font-size: 13px;
    color: rgba(255,255,255,0.38);
    line-height: 1.55;
    max-width: 280px;
    margin: 0;
  }

  .search-empty__desc strong { color: rgba(255,255,255,0.6); }
`;
