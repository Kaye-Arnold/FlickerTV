/**
 * Flicker.TV — IndexedDB Persistence Layer
 *
 * Provides durable, offline-capable storage for:
 *  - Bookmarked film records (full CinemaCard objects)
 *  - Watch progress per film (resumable playback)
 *  - Recently viewed identifiers (feed personalisation)
 *
 * Uses the `idb` wrapper library for a promise-based IndexedDB API.
 * Keeps the UI usable when IndexedDB is unavailable (private browsing, SSR)
 * while exposing the last operation and failure through diagnostics.
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

export type IndexedDbStatus = 'unknown' | 'available' | 'error';

export interface IndexedDbDiagnostics {
  status: IndexedDbStatus;
  operation: string | null;
  message: string | null;
  checkedAt: number | null;
}

let _diagnostics: IndexedDbDiagnostics = {
  status: 'unknown',
  operation: null,
  message: null,
  checkedAt: null,
};

function updateDiagnostics(
  status: IndexedDbStatus,
  operation: string,
  error?: unknown
): void {
  _diagnostics = {
    status,
    operation,
    message:
      error instanceof Error
        ? error.message
        : error === undefined
        ? null
        : String(error),
    checkedAt: Date.now(),
  };
}

export function getIndexedDbDiagnostics(): IndexedDbDiagnostics {
  return { ..._diagnostics };
}

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
// Safety wrapper — public operations keep the app usable when storage is
// unavailable, while diagnostics preserve the actual failure for the UI and
// support tooling instead of silently discarding it.
// ---------------------------------------------------------------------------

async function safeRun<T>(
  operation: string,
  fn: (db: IDBPDatabase<FlickerDBSchema>) => Promise<T>,
  fallback: T
): Promise<T> {
  if (typeof window === 'undefined') return fallback;
  try {
    const db = await getDB();
    const result = await fn(db);
    updateDiagnostics('available', operation);
    return result;
  } catch (error: unknown) {
    updateDiagnostics('error', operation, error);
    console.warn(`[FlickerDB] ${operation} failed:`, error);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Bookmark API
// ---------------------------------------------------------------------------

export async function saveBookmark(card: CinemaCard): Promise<void> {
  await safeRun('save bookmark', async (db) => {
    await db.put('bookmarks', { ...card, savedAt: Date.now() });
  }, undefined);
}

export async function removeBookmark(tmdbId: string): Promise<void> {
  await safeRun('remove bookmark', async (db) => {
    await db.delete('bookmarks', tmdbId);
  }, undefined);
}

export async function getAllBookmarks(): Promise<CinemaCard[]> {
  return safeRun('load bookmarks', async (db) => {
    const all = await db.getAllFromIndex('bookmarks', 'by-savedAt');
    // Return newest first.
    return all.reverse().map(({ savedAt: _savedAt, ...card }) => card as CinemaCard);
  }, []);
}

export async function isBookmarked(tmdbId: string): Promise<boolean> {
  return safeRun('check bookmark', async (db) => {
    const record = await db.get('bookmarks', tmdbId);
    return record !== undefined;
  }, false);
}

export async function getBookmarkCount(): Promise<number> {
  return safeRun('count bookmarks', async (db) => {
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
  await safeRun('save progress', async (db) => {
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
  return safeRun('load progress', async (db) => {
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
  await safeRun('clear progress', async (db) => {
    await db.delete('progress', tmdbId);
  }, undefined);
}

export async function getAllProgress(): Promise<WatchProgress[]> {
  return safeRun('load all progress', async (db) => {
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
  await safeRun('record view', async (db) => {
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
  return safeRun('load recently viewed', async (db) => {
    const all = await db.getAllFromIndex('recentlyViewed', 'by-viewedAt');
    return all.reverse(); // newest first
  }, []);
}

export async function clearRecentlyViewed(): Promise<void> {
  await safeRun('clear recently viewed', async (db) => {
    await db.clear('recentlyViewed');
  }, undefined);
}

// ---------------------------------------------------------------------------
// Database maintenance
// ---------------------------------------------------------------------------

export async function clearAllData(): Promise<void> {
  await safeRun('clear all data', async (db) => {
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
  return safeRun('estimate database size', async (db) => {
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
