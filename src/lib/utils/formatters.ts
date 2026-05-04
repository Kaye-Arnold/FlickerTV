/**
 * Flicker.TV — Display formatters
 * Pure functions, zero dependencies.
 */

/**
 * Format seconds into a human-readable duration string.
 * Examples: 94 → "1h 34m" | 67 → "1h 07m" | 45 → "45m"
 */
export function formatRuntime(totalMinutes: number): string {
  if (!isFinite(totalMinutes) || totalMinutes <= 0) return '—';
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Format a seconds counter into MM:SS or H:MM:SS for the seek bar.
 */
export function formatTimecode(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Format a rating on a 0–10 scale to a display string.
 * Example: 7.9 → "7.9 / 10"
 */
export function formatRating(rating: number): string {
  if (!isFinite(rating) || rating < 0) return '—';
  return `${rating.toFixed(1)} / 10`;
}

/**
 * Format a byte count into a human-readable size.
 * Used by the VideoCacheManager debug overlay.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Truncate a string to maxLength characters, appending an ellipsis.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Convert a snake_case or kebab-case identifier to Title Case.
 * Used to clean up archive.org subject tags.
 * Example: "silent_film" → "Silent Film"
 */
export function toTitleCase(input: string): string {
  return input
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Format a large download count into compact notation.
 * Example: 1_234_567 → "1.2M"
 */
export function formatDownloads(count: number): string {
  if (!isFinite(count) || count < 0) return '—';
  if (count < 1000)         return String(count);
  if (count < 1_000_000)    return `${(count / 1000).toFixed(1)}K`;
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${(count / 1_000_000_000).toFixed(1)}B`;
}

/**
 * Format an ISO 8601 date string into a short human-readable label.
 * Example: "2023-05-12T10:30:00Z" → "May 12, 2023"
 *
 * C2 FIX: year was previously set to 'month' which is not a valid
 * Intl.DateTimeFormat option and would throw a RangeError at runtime.
 * Corrected to 'numeric'.
 */
export function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
      year:  'numeric',
      month: 'long',
      day:   'numeric',
    });
  } catch {
    return isoString;
  }
}

/**
 * Generate a deterministic colour from a string (for genre pill backgrounds).
 * Returns an HSL string.
 */
export function stringToHslColor(
  str: string,
  saturation = 35,
  lightness  = 20
): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Clamp a number between min and max (inclusive).
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Linear interpolation between two values.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * Convert a 0–10 TMDB rating to a 0–5 star count for display.
 */
export function ratingToStars(rating: number): number {
  return Math.round(clamp(rating, 0, 10) / 2);
}