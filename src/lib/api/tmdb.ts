/**
 * Flicker.TV — TMDB API Client (optional enrichment layer)
 *
 * Used to enrich archive.org film records with high-quality posters,
 * backdrops, ratings, and cast data from TMDB.
 *
 * Authentication: TMDB API Read Access Token (Bearer).
 * Set NEXT_PUBLIC_TMDB_READ_TOKEN in .env.local
 *
 * All requests are cached aggressively — TMDB data for pre-1965 films
 * is stable and will not change.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TmdbMovieSearchResult {
  id:            number;
  title:         string;
  originalTitle: string;
  releaseDate:   string;
  releaseYear:   number;
  overview:      string;
  posterUrl:     string | null;
  backdropUrl:   string | null;
  rating:        number;
  voteCount:     number;
  genreIds:      number[];
  popularity:    number;
}

export interface TmdbMovieDetails extends TmdbMovieSearchResult {
  runtime:    number;
  genres:     Array<{ id: number; name: string }>;
  tagline:    string;
  status:     string;
  imdbId:     string | null;
  homepage:   string | null;
  director:   string | null;
  cast:       Array<{ name: string; character: string; profileUrl: string | null }>;
  trailerKey: string | null;
}

// Raw TMDB response types (minimal, only fields we use)
interface RawTmdbMovie {
  id:             number;
  title:          string;
  original_title: string;
  release_date:   string;
  overview:       string;
  poster_path:    string | null;
  backdrop_path:  string | null;
  vote_average:   number;
  vote_count:     number;
  genre_ids?:     number[];
  popularity:     number;
}

interface RawTmdbMovieDetails extends RawTmdbMovie {
  runtime:  number;
  tagline:  string;
  status:   string;
  imdb_id:  string | null;
  homepage: string | null;
  genres:   Array<{ id: number; name: string }>;
  credits?: {
    crew: Array<{ job: string; name: string }>;
    cast: Array<{ name: string; character: string; profile_path: string | null }>;
  };
  videos?: {
    results: Array<{ site: string; type: string; key: string }>;
  };
}

interface RawTmdbSearchResponse {
  results:       RawTmdbMovie[];
  total_results: number;
  total_pages:   number;
  page:          number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TMDB_BASE       = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

const POSTER_SIZE   = 'w780';
const BACKDROP_SIZE = 'w1280';
const PROFILE_SIZE  = 'w185';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getToken(): string | null {
  return process.env.NEXT_PUBLIC_TMDB_READ_TOKEN ?? null;
}

// C1 FIX: Accept header value corrected to 'application/json'.
// Previously had Accept: 'Authorization' which was a key/value transposition bug.
function buildHeaders(): HeadersInit {
  const token = getToken();
  if (!token) return { 'Accept': 'application/json' };
  return {
    'Accept':        'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

function posterUrl(path: string | null, size = POSTER_SIZE): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

function backdropUrl(path: string | null, size = BACKDROP_SIZE): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

function profileUrl(path: string | null): string | null {
  if (!path) return null;
  return `${TMDB_IMAGE_BASE}/${PROFILE_SIZE}${path}`;
}

function parseYear(releaseDate: string): number {
  const year = parseInt(releaseDate?.split('-')[0] ?? '0', 10);
  return isNaN(year) ? 0 : year;
}

function rawToSearchResult(raw: RawTmdbMovie): TmdbMovieSearchResult {
  return {
    id:            raw.id,
    title:         raw.title,
    originalTitle: raw.original_title,
    releaseDate:   raw.release_date ?? '',
    releaseYear:   parseYear(raw.release_date),
    overview:      raw.overview ?? '',
    posterUrl:     posterUrl(raw.poster_path),
    backdropUrl:   backdropUrl(raw.backdrop_path),
    rating:        raw.vote_average ?? 0,
    voteCount:     raw.vote_count ?? 0,
    genreIds:      raw.genre_ids ?? [],
    popularity:    raw.popularity ?? 0,
  };
}

function rawToDetails(raw: RawTmdbMovieDetails): TmdbMovieDetails {
  const base = rawToSearchResult(raw);

  const director =
    raw.credits?.crew.find((c) => c.job === 'Director')?.name ?? null;

  const cast = (raw.credits?.cast ?? []).slice(0, 8).map((c) => ({
    name:       c.name,
    character:  c.character,
    profileUrl: profileUrl(c.profile_path),
  }));

  const trailerKey =
    raw.videos?.results.find(
      (v) => v.site === 'YouTube' && v.type === 'Trailer'
    )?.key ?? null;

  return {
    ...base,
    runtime:    raw.runtime ?? 0,
    genres:     raw.genres ?? [],
    tagline:    raw.tagline ?? '',
    status:     raw.status ?? '',
    imdbId:     raw.imdb_id ?? null,
    homepage:   raw.homepage ?? null,
    director,
    cast,
    trailerKey,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search TMDB for a film by title and optional release year.
 * Returns null if no API token is configured.
 */
export async function searchTmdbFilm(
  title: string,
  year?: number,
  signal?: AbortSignal
): Promise<TmdbMovieSearchResult | null> {
  const token = getToken();
  if (!token) return null;

  const params = new URLSearchParams({
    query:         title,
    language:      'en-US',
    page:          '1',
    include_adult: 'false',
    ...(year ? { year: String(year) } : {}),
  });

  try {
    const response = await fetch(
      `${TMDB_BASE}/search/movie?${params.toString()}`,
      {
        headers: buildHeaders(),
        signal,
        next: { revalidate: 86400 },
      }
    );

    if (!response.ok) return null;

    const data = (await response.json()) as RawTmdbSearchResponse;
    const first = data.results?.[0];
    return first ? rawToSearchResult(first) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch full TMDB movie details including credits, genres, and trailer.
 * Returns null if not found or no API token.
 */
export async function fetchTmdbMovieDetails(
  tmdbId: number,
  signal?: AbortSignal
): Promise<TmdbMovieDetails | null> {
  const token = getToken();
  if (!token) return null;

  try {
    const response = await fetch(
      `${TMDB_BASE}/movie/${tmdbId}?language=en-US&append_to_response=credits,videos`,
      {
        headers: buildHeaders(),
        signal,
        next: { revalidate: 86400 },
      }
    );

    if (!response.ok) return null;

    const data = (await response.json()) as RawTmdbMovieDetails;
    return rawToDetails(data);
  } catch {
    return null;
  }
}

/**
 * Enrich an archive.org film result with TMDB poster/backdrop/rating data.
 * Silently returns the original data if enrichment fails (TMDB is optional).
 */
export async function enrichWithTmdb
  T extends {
    movieTitle:     string;
    releaseYear:    number;
    posterWebpUrl:  string;
    backdropUrl:    string;
    rating?:        number;
    runtimeMinutes: number;
    genres:         string[];
    directorName:   string;
  }
>(film: T, signal?: AbortSignal): Promise<T> {
  try {
    const tmdbResult = await searchTmdbFilm(
      film.movieTitle,
      film.releaseYear,
      signal
    );

    if (!tmdbResult) return film;

    const details = await fetchTmdbMovieDetails(tmdbResult.id, signal);

    return {
      ...film,
      posterWebpUrl:  tmdbResult.posterUrl                       ?? film.posterWebpUrl,
      backdropUrl:    tmdbResult.backdropUrl                     ?? film.backdropUrl,
      rating:         tmdbResult.rating > 0 ? tmdbResult.rating  : film.rating,
      runtimeMinutes: details?.runtime   > 0 ? details.runtime   : film.runtimeMinutes,
      genres:         details?.genres.map((g) => g.name)         ?? film.genres,
      directorName:   details?.director                          ?? film.directorName,
    };
  } catch {
    return film;
  }
}