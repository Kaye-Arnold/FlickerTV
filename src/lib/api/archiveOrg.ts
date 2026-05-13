/**
 * Flicker.TV — Internet Archive API Client
 *
 * Wraps the archive.org Advanced Search API (Lucene syntax) and the
 * Metadata API to fetch public domain film data without requiring
 * any API key.
 *
 * Endpoints used:
 *   Search:   https://archive.org/advancedsearch.php
 *   Metadata: https://archive.org/metadata/{identifier}
 *   Stream:   https://archive.org/download/{identifier}/{filename}
 *   Thumb:    https://archive.org/services/img/{identifier}
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArchiveFilmResult {
  identifier:      string;
  title:           string;
  creator?:        string;
  year?:           number;
  description?:    string;
  subject?:        string[];
  thumbnailUrl:    string;
  streamUrl:       string;
  runtimeMinutes?: number;
  mediatype:       string;
  downloads?:      number;
  avgRating?:      number;
  addedDate?:      string;
}

export interface ArchiveSearchOptions {
  limit?:  number;
  page?:   number;
  sort?:   'downloads desc' | 'avg_rating desc' | 'addeddate desc' | 'year asc' | 'year desc';
  signal?: AbortSignal;
}

interface ArchiveSearchDoc {
  identifier:  string;
  title?:      string;
  creator?:    string | string[];
  year?:       string | number;
  description?:string | string[];
  subject?:    string | string[];
  mediatype?:  string;
  downloads?:  number;
  avg_rating?: number;
  addeddate?:  string;
}

interface ArchiveSearchResponse {
  response: {
    numFound: number;
    start:    number;
    docs:     ArchiveSearchDoc[];
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARCHIVE_SEARCH_BASE = 'https://archive.org/advancedsearch.php';
const ARCHIVE_METADATA_BASE = 'https://archive.org/metadata';
const ARCHIVE_THUMB_BASE = 'https://archive.org/services/img';
const ARCHIVE_DOWNLOAD_BASE = 'https://archive.org/download';

// Fields to request — keeps response payload small.
const SEARCH_FIELDS = [
  'identifier',
  'title',
  'creator',
  'year',
  'description',
  'subject',
  'mediatype',
  'downloads',
  'avg_rating',
  'addeddate',
].join(',');

// Video MIME types we'll accept for streaming, in preference order.
const PREFERRED_VIDEO_EXTENSIONS = [
  '.mp4',
  '.ogv',
  '.mpeg',
  '.avi',
  '.mov',
  '.mkv',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseStringOrArray(
  val: string | string[] | undefined
): string | undefined {
  if (!val) return undefined;
  return Array.isArray(val) ? val.join(', ') : val;
}

function normaliseSubjectArray(
  val: string | string[] | undefined
): string[] {
  if (!val) return [];
  const raw = Array.isArray(val) ? val : [val];
  // Flatten comma-separated subjects.
  return raw
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function guessRuntime(description?: string): number | undefined {
  if (!description) return undefined;
  // Common patterns: "60 min", "1 hour 20 minutes", "approx. 94 mins"
  const minMatch = description.match(/(\d{1,3})\s*min/i);
  if (minMatch && minMatch[1]) return parseInt(minMatch[1], 10);

  const hrMatch = description.match(/(\d{1,2})\s*h(?:our)?s?\s*(?:and\s*)?(\d{0,2})\s*m?/i);
  if (hrMatch && hrMatch[1]) {
    const hours = parseInt(hrMatch[1], 10);
    const mins  = hrMatch[2] ? parseInt(hrMatch[2], 10) : 0;
    return hours * 60 + mins;
  }

  return undefined;
}

function buildThumbnailUrl(identifier: string): string {
  return `${ARCHIVE_THUMB_BASE}/${identifier}`;
}

/**
 * Builds a direct streaming URL for an identifier.
 * We construct a predictable MP4 URL first; if it 404s the player falls back
 * to the WaitingRoom error state which then redirects to archive.org.
 */
function buildStreamUrl(identifier: string): string {
  // archive.org often mirrors the MP4 at /{identifier}/{identifier}.mp4
  return `${ARCHIVE_DOWNLOAD_BASE}/${identifier}/${identifier}.mp4`;
}

function docToFilmResult(doc: ArchiveSearchDoc): ArchiveFilmResult {
  const description = normaliseStringOrArray(doc.description);
  const year =
    typeof doc.year === 'string'
      ? parseInt(doc.year, 10) || undefined
      : doc.year;

  return {
    identifier:      doc.identifier,
    title:           doc.title ?? doc.identifier,
    creator:         normaliseStringOrArray(doc.creator),
    year:            isNaN(year as number) ? undefined : year,
    description,
    subject:         normaliseSubjectArray(doc.subject),
    thumbnailUrl:    buildThumbnailUrl(doc.identifier),
    streamUrl:       buildStreamUrl(doc.identifier),
    runtimeMinutes:  guessRuntime(description),
    mediatype:       doc.mediatype ?? 'movies',
    downloads:       doc.downloads,
    avgRating:       doc.avg_rating,
    addedDate:       doc.addeddate,
  };
}

function escapeLuceneTerm(input: string): string {
  return input
    .trim()
    .replace(/[+\-&|!(){}\[\]^"~*?:\\/]/g, '\\$&')
    .replace(/\s+/g, ' ');
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the Internet Archive for public domain films.
 *
 * Applies a fixed Lucene filter: `mediatype:movies AND licenseurl:(*publicdomain* OR NOT licenseurl:[* TO *])`
 * to target freely usable content.
 */
export async function searchArchiveOrg(
  query: string,
  options: ArchiveSearchOptions = {}
): Promise<ArchiveFilmResult[]> {
  const {
    limit  = 20,
    page   = 1,
    sort   = 'downloads desc',
    signal,
  } = options;

  const luceneQuery = [
    `(${escapeLuceneTerm(query)})`,
    'mediatype:movies',
    'year:[1888 TO 1965]', // Focus on films most likely in public domain
    '-subject:(adult OR xxx OR porn)', // Content safety filter
  ].join(' AND ');

  const params = new URLSearchParams({
    q:        luceneQuery,
    fl:       SEARCH_FIELDS,
    sort:     sort,
    rows:     String(limit),
    page:     String(page),
    output:   'json',
    callback: '',
  });

  const url = `${ARCHIVE_SEARCH_BASE}?${params.toString()}`;

  const response = await fetch(url, {
    signal,
    headers: {
      'Accept': 'application/json',
    },
    cache: 'default',
  });

  if (!response.ok) {
    throw new Error(
      `Archive search failed: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as ArchiveSearchResponse;
  const docs = data?.response?.docs ?? [];

  return docs
    .filter((doc) => Boolean(doc.identifier) && Boolean(doc.title))
    .map(docToFilmResult);
}

/**
 * Fetch full metadata for a single archive.org identifier.
 * Used to resolve the exact stream URL from the item's file manifest.
 */
export async function fetchArchiveMetadata(
  identifier: string,
  signal?: AbortSignal
): Promise<ArchiveFilmResult | null> {
  const url = `${ARCHIVE_METADATA_BASE}/${encodeURIComponent(identifier)}`;

  const response = await fetch(url, {
    signal,
    headers: { 'Accept': 'application/json' },
    cache: 'default',
  });

  if (!response.ok) return null;

  const data = await response.json();
  const meta = data?.metadata ?? {};
  const files: Array<{ name: string; format?: string; size?: string }> =
    data?.files ?? [];

  // Resolve best streaming URL from file manifest.
  const streamUrl = resolveStreamUrl(identifier, files);

  const description =
    typeof meta.description === 'string'
      ? meta.description
      : Array.isArray(meta.description)
      ? meta.description.join(' ')
      : undefined;

  return {
    identifier,
    title:           meta.title ?? identifier,
    creator:         Array.isArray(meta.creator) ? meta.creator[0] : meta.creator,
    year:            meta.year ? parseInt(meta.year, 10) : undefined,
    description,
    subject:         normaliseSubjectArray(meta.subject),
    thumbnailUrl:    buildThumbnailUrl(identifier),
    streamUrl,
    runtimeMinutes:  guessRuntime(description),
    mediatype:       meta.mediatype ?? 'movies',
  };
}

/**
 * Walk the archive.org file manifest and return the best direct video URL.
 * Prefers MP4, then falls back through other containers.
 */
function resolveStreamUrl(
  identifier: string,
  files: Array<{ name: string; format?: string }>
): string {
  for (const ext of PREFERRED_VIDEO_EXTENSIONS) {
    const match = files.find(
      (f) =>
        f.name.toLowerCase().endsWith(ext) &&
        !f.name.toLowerCase().includes('sample') &&
        !f.name.toLowerCase().includes('trailer')
    );
    if (match) {
      return `${ARCHIVE_DOWNLOAD_BASE}/${identifier}/${encodeURIComponent(match.name)}`;
    }
  }
  // Fallback: construct a predictable URL.
  return buildStreamUrl(identifier);
}

/**
 * Fetch a curated list of highly-downloaded public domain films.
 * Used to populate the discovery feed's initial reel.
 */
export async function fetchCuratedPublicDomainFilms(
  options: ArchiveSearchOptions = {}
): Promise<ArchiveFilmResult[]> {
  return searchArchiveOrg(
    'silent film OR public domain film OR classic cinema',
    {
      limit: options.limit ?? 30,
      page:  options.page ?? 1,
      sort:  'downloads desc',
      signal: options.signal,
    }
  );
}

/**
 * Fetch films by a specific director name.
 */
export async function fetchFilmsByDirector(
  directorName: string,
  options: ArchiveSearchOptions = {}
): Promise<ArchiveFilmResult[]> {
  return searchArchiveOrg(`creator:"${directorName}"`, options);
}

/**
 * Fetch films from a specific decade (e.g., 1920, 1930).
 */
export async function fetchFilmsByDecade(
  decadeStart: number,
  options: ArchiveSearchOptions = {}
): Promise<ArchiveFilmResult[]> {
  return searchArchiveOrg(
    `year:[${decadeStart} TO ${decadeStart + 9}] film`,
    options
  );
}