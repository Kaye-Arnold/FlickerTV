/**
 * Flicker.TV — IndexedDB Persistence Layer
 *
 * Provides durable, offline-capable storage for:
 *  - Bookmarked film records (full CinemaCard objects)
 *  - Watch progress per film (resumable playback)
 *  - Recently viewed identifiers (feed personalisation)
 *
 * Uses the `idb` wrapper library for a promise-based IndexedDB API.
 * Falls back silently if IndexedDB is unavailable (private browsing, SSR).
 */

import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { CinemaCard } from '@/components/Feed/SwiperFeed';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface FlickerDBSchema extends DBSchema {
  bookmarks: {
    key: string;          // tmdbId
    value: CinemaCard & { savedAt: number };
    indexes: { 'by-savedAt': number };
  };
  progress: {
    key: string;          // tmdbId
    value: {
      tmdbId:         string;
      currentSeconds: number;
      durationSeconds:number;
      updatedAt:      number;
    };
  };
  recentlyViewed: {
    key: string;          // tmdbId
    value: {
      tmdbId:    string;
      viewedAt:  number;
      movieTitle:string;
    };
    indexes: { 'by-viewedAt': number };
  };
}

const DB_NAME    = 'flicker-tv-db';
const DB_VERSION = 1;

// Maximum entries to retain in recentlyViewed store.
const MAX_RECENTLY_VIEWED = 50;

// ---------------------------------------------------------------------------
// DB singleton
// ---------------------------------------------------------------------------

let _db: IDBPDatabase<FlickerDBSchema> | null = null;

async function getDB(): Promise<IDBPDatabase<FlickerDBSchema>> {
  if (_db !== null) return _db;

  _db = await openDB<FlickerDBSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // ── Bookmarks ──
      if (!db.objectStoreNames.contains('bookmarks')) {
        const bookmarkStore = db.createObjectStore('bookmarks', {
          keyPath: 'tmdbId',
        });
        bookmarkStore.createIndex('by-savedAt', 'savedAt');
      }

      // ── Progress ──
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'tmdbId' });
      }

      // ── Recently viewed ──
      if (!db.objectStoreNames.contains('recentlyViewed')) {
        const recentStore = db.createObjectStore('recentlyViewed', {
          keyPath: 'tmdbId',
        });
        recentStore.createIndex('by-viewedAt', 'viewedAt');
      }
    },
    blocked() {
      console.warn('[FlickerDB] Database upgrade blocked by an older version open in another tab.');
    },
    blocking() {
      _db?.close();
      _db = null;
    },
  });

  return _db;
}

// ---------------------------------------------------------------------------
// Safety wrapper — all public functions swallow IDB errors gracefully.
// The app must remain functional even when IDB is unavailable.
// ---------------------------------------------------------------------------

async function safeRun<T>(
  fn: (db: IDBPDatabase<FlickerDBSchema>) => Promise<T>,
  fallback: T
): Promise<T> {
  if (typeof window === 'undefined') return fallback;
  try {
    const db = await getDB();
    return await fn(db);
  } catch (err) {
    console.warn('[FlickerDB] Operation failed:', err);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Bookmark API
// ---------------------------------------------------------------------------

export async function saveBookmark(card: CinemaCard): Promise<void> {
  await safeRun(async (db) => {
    await db.put('bookmarks', { ...card, savedAt: Date.now() });
  }, undefined);
}

export async function removeBookmark(tmdbId: string): Promise<void> {
  await safeRun(async (db) => {
    await db.delete('bookmarks', tmdbId);
  }, undefined);
}

export async function getAllBookmarks(): Promise<CinemaCard[]> {
  return safeRun(async (db) => {
    const all = await db.getAllFromIndex('bookmarks', 'by-savedAt');
    // Return newest first.
    return all.reverse().map(({ savedAt: _savedAt, ...card }) => card as CinemaCard);
  }, []);
}

export async function isBookmarked(tmdbId: string): Promise<boolean> {
  return safeRun(async (db) => {
    const record = await db.get('bookmarks', tmdbId);
    return record !== undefined;
  }, false);
}

export async function getBookmarkCount(): Promise<number> {
  return safeRun(async (db) => {
    return db.count('bookmarks');
  }, 0);
}

// ---------------------------------------------------------------------------
// Watch Progress API
// ---------------------------------------------------------------------------

export interface WatchProgress {
  tmdbId:          string;
  currentSeconds:  number;
  durationSeconds: number;
  updatedAt:       number;
  /** Completion percentage (0–100). */
  percentComplete: number;
}

export async function saveProgress(
  tmdbId: string,
  currentSeconds: number,
  durationSeconds: number
): Promise<void> {
  await safeRun(async (db) => {
    await db.put('progress', {
      tmdbId,
      currentSeconds,
      durationSeconds,
      updatedAt: Date.now(),
    });
  }, undefined);
}

export async function getProgress(
  tmdbId: string
): Promise<WatchProgress | null> {
  return safeRun(async (db) => {
    const record = await db.get('progress', tmdbId);
    if (!record) return null;
    return {
      ...record,
      percentComplete:
        record.durationSeconds > 0
          ? Math.round((record.currentSeconds / record.durationSeconds) * 100)
          : 0,
    };
  }, null);
}

export async function clearProgress(tmdbId: string): Promise<void> {
  await safeRun(async (db) => {
    await db.delete('progress', tmdbId);
  }, undefined);
}

export async function getAllProgress(): Promise<WatchProgress[]> {
  return safeRun(async (db) => {
    const all = await db.getAll('progress');
    return all.map((r) => ({
      ...r,
      percentComplete:
        r.durationSeconds > 0
          ? Math.round((r.currentSeconds / r.durationSeconds) * 100)
          : 0,
    }));
  }, []);
}

// ---------------------------------------------------------------------------
// Recently Viewed API
// ---------------------------------------------------------------------------

export async function recordView(
  tmdbId: string,
  movieTitle: string
): Promise<void> {
  await safeRun(async (db) => {
    await db.put('recentlyViewed', {
      tmdbId,
      movieTitle,
      viewedAt: Date.now(),
    });

    // Evict oldest entries beyond limit.
    const keys = await db.getAllKeysFromIndex(
      'recentlyViewed',
      'by-viewedAt'
    );
    if (keys.length > MAX_RECENTLY_VIEWED) {
      const toDelete = keys.slice(0, keys.length - MAX_RECENTLY_VIEWED);
      const tx = db.transaction('recentlyViewed', 'readwrite');
      await Promise.all([
        ...toDelete.map((k) => tx.store.delete(k)),
        tx.done,
      ]);
    }
  }, undefined);
}

export async function getRecentlyViewed(): Promise<
  Array<{ tmdbId: string; movieTitle: string; viewedAt: number }>
> {
  return safeRun(async (db) => {
    const all = await db.getAllFromIndex('recentlyViewed', 'by-viewedAt');
    return all.reverse(); // newest first
  }, []);
}

export async function clearRecentlyViewed(): Promise<void> {
  await safeRun(async (db) => {
    await db.clear('recentlyViewed');
  }, undefined);
}

// ---------------------------------------------------------------------------
// Database maintenance
// ---------------------------------------------------------------------------

export async function clearAllData(): Promise<void> {
  await safeRun(async (db) => {
    const tx = db.transaction(
      ['bookmarks', 'progress', 'recentlyViewed'],
      'readwrite'
    );
    await Promise.all([
      tx.objectStore('bookmarks').clear(),
      tx.objectStore('progress').clear(),
      tx.objectStore('recentlyViewed').clear(),
      tx.done,
    ]);
  }, undefined);
}

export async function getDatabaseSizeEstimate(): Promise<{
  bookmarks: number;
  progress: number;
  recentlyViewed: number;
  total: number;
}> {
  return safeRun(async (db) => {
    const [bookmarks, progress, recentlyViewed] = await Promise.all([
      db.count('bookmarks'),
      db.count('progress'),
      db.count('recentlyViewed'),
    ]);
    return {
      bookmarks,
      progress,
      recentlyViewed,
      total: bookmarks + progress + recentlyViewed,
    };
  }, { bookmarks: 0, progress: 0, recentlyViewed: 0, total: 0 });
}
