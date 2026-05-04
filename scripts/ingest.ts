/**
 * Flicker.TV — Deterministic Archive.org Ingestion Engine
 *
 * Execution:  npx ts-node --project scripts/tsconfig.scripts.json scripts/ingest.ts
 *
 * Required environment variables:
 *   GIST_PAT   GitHub PAT with `gist` write scope.
 *   GIST_ID    Target Gist alphanumeric ID.
 *
 * Optional environment variables:
 *   INGEST_LIMIT        Max items to process per collection query. Default: 200.
 *   INGEST_CONCURRENCY  Parallel metadata fetches. Default: 8.
 *   INGEST_DRY_RUN      "true" → print to stdout, skip Gist push.
 *
 * Transport: native Node 18+ fetch exclusively.
 * No Axios. No Puppeteer. No Cheerio. No DOM parsing of any kind.
 * All data sourced from archive.org JSON APIs only.
 */

import type { CinemaCard, CatalogGist, StreamType } from '../src/types/schema';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const GIST_PAT            = process.env['GIST_PAT']            ?? '';
const GIST_ID             = process.env['GIST_ID']             ?? '';
const INGEST_LIMIT        = parseInt(process.env['INGEST_LIMIT']        ?? '200', 10);
const INGEST_CONCURRENCY  = parseInt(process.env['INGEST_CONCURRENCY']  ?? '8',   10);
const DRY_RUN             = process.env['INGEST_DRY_RUN'] === 'true';

// ---------------------------------------------------------------------------
// Archive.org API endpoints — JSON only, no HTML
// ---------------------------------------------------------------------------

const ARCHIVE_SEARCH_BASE   = 'https://archive.org/advancedsearch.php';
const ARCHIVE_METADATA_BASE = 'https://archive.org/metadata';
const ARCHIVE_DOWNLOAD_BASE = 'https://archive.org/download';
const ARCHIVE_THUMB_BASE    = 'https://archive.org/services/img';

/**
 * Target collection queries. Each uses the archive.org Lucene search syntax.
 * Only `mediatype:movies` items are eligible — no audio, texts, or software.
 */
const TARGET_QUERIES: string[] = [
  'mediatype:movies AND collection:SciFi_Horror',
  'mediatype:movies AND collection:feature_films AND year:[1888 TO 1965]',
  'mediatype:movies AND collection:silent_films',
  'mediatype:movies AND collection:classic_cartoons',
  'mediatype:movies AND collection:newsandpublicaffairs AND year:[1888 TO 1970]',
  'mediatype:movies AND collection:prelinger',
  'mediatype:movies AND subject:"public domain" AND year:[1888 TO 1965]',
];

const SEARCH_FIELDS = [
  'identifier',
  'title',
  'description',
  'creator',
  'year',
  'date',
  'mediatype',
  'downloads',
].join(',');

// ---------------------------------------------------------------------------
// Raw archive.org API types
// ---------------------------------------------------------------------------

interface ArchiveSearchDoc {
  identifier:   string;
  title?:       string | string[];
  description?: string | string[];
  creator?:     string | string[];
  year?:        string | number;
  date?:        string;
  mediatype?:   string;
  downloads?:   number;
}

interface ArchiveSearchResponse {
  response: {
    numFound: number;
    docs:     ArchiveSearchDoc[];
  };
}

interface ArchiveFile {
  name:      string;
  format?:   string;
  size?:     string;
  length?:   string;
  source?:   string;
}

interface ArchiveMetadataResponse {
  metadata?: Record<string, unknown>;
  files?:    ArchiveFile[];
  dir?:      string;
  server?:   string;
}

// ---------------------------------------------------------------------------
// Utility: string normalisation
// ---------------------------------------------------------------------------

function normaliseString(val: unknown): string {
  if (!val) return '';
  if (Array.isArray(val)) return (val as string[]).join(' ').trim();
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number') return String(val);
  return '';
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&#39;/g,   "'")
    .replace(/\s{2,}/g,  ' ')
    .trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function parseDuration(files: ArchiveFile[]): number | undefined {
  for (const file of files) {
    if (!file.length) continue;
    const parsed = parseFloat(file.length);
    if (isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return undefined;
}

function parseYearString(doc: ArchiveSearchDoc): string | undefined {
  const raw = String(doc.year ?? doc.date ?? '');
  const m   = raw.match(/\b(1[89]\d{2}|20[01]\d)\b/);
  return m ? m[1] : undefined;
}

function parseDirector(doc: ArchiveSearchDoc, meta: Record<string, unknown>): string | undefined {
  const raw = normaliseString(
    (meta['creator'] as unknown) ?? doc.creator
  );
  if (!raw) return undefined;
  const names = raw.split(/[;,|]/).map((s) => s.trim()).filter(Boolean);
  return names.slice(0, 3).join(' & ') || undefined;
}

// ---------------------------------------------------------------------------
// Utility: HTTP fetch with exponential backoff retry
// Using native Node 18+ fetch — NO external HTTP libraries.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url:         string,
  options:     RequestInit = {},
  maxRetries:  number      = 3,
  baseDelayMs: number      = 1000
): Promise<Response> {
  let lastError: Error = new Error('fetch failed');

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 400);
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function mapConcurrent<T, R>(
  items:       T[],
  concurrency: number,
  fn:          (item: T, index: number) => Promise<R>
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) break;
      try {
        results[index] = await fn(items[index]!, index);
      } catch {
        results[index] = null;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

// ---------------------------------------------------------------------------
// Rule-based stream selector
//
// Rule 1: Select .m3u8 (HLS) — highest quality match wins.
// Rule 2: If no HLS, select .mp4 — quality preference order applies.
// Rule 3: .ogv, .mpeg, and all other containers are UNCONDITIONALLY discarded.
//         No fallback to .ogv or .mpeg ever occurs.
// ---------------------------------------------------------------------------

/** Files matching these patterns are silently skipped before rule evaluation. */
const SKIP_PATTERNS: RegExp[] = [
  /sample/i,
  /trailer/i,
  /preview/i,
  /thumb/i,
  // Unconditionally discarded formats per Rule 3.
  // This list is evaluated BEFORE the HLS/MP4 rules so .ogv and .mpeg
  // are never selected regardless of the HLS/MP4 pattern match order.
  /\.(ogv|mpeg|avi|wmv|flv|mov|mkv|webm|ogg|mp3|wav|flac|aac|png|jpg|jpeg|gif|webp|pdf|txt|xml|json|srt|vtt|nfo|torrent|sqlite|db|zip|gz|tar)$/i,
];

/** HLS manifest patterns in descending quality preference. */
const HLS_PATTERNS: RegExp[] = [
  /1080p?.*\.m3u8$/i,
  /720p?.*\.m3u8$/i,
  /hd.*\.m3u8$/i,
  /high.*\.m3u8$/i,
  /master.*\.m3u8$/i,
  /index.*\.m3u8$/i,
  /\.m3u8$/i,
];

/** MP4 patterns in descending quality preference. */
const MP4_PATTERNS: RegExp[] = [
  /1080[pi]?.*\.mp4$/i,
  /720p?.*\.mp4$/i,
  /hi[gh]?.*\.mp4$/i,
  /512kb?.*\.mp4$/i,
  /\.mp4$/i,
];

function isSkipped(filename: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(filename));
}

function selectByPatterns(
  files:    ArchiveFile[],
  patterns: RegExp[]
): ArchiveFile | null {
  for (const pattern of patterns) {
    const match = files.find(
      (f) => pattern.test(f.name) && !isSkipped(f.name)
    );
    if (match) return match;
  }
  return null;
}

interface SelectedStream {
  file:       ArchiveFile;
  streamType: StreamType;
}

/**
 * Rule-based stream selector.
 *
 * Applies Rule 1 (HLS), Rule 2 (MP4), Rule 3 (discard .ogv/.mpeg).
 * The SKIP_PATTERNS gate before both rules ensures .ogv and .mpeg are
 * never reachable by any pattern, even if they superficially match a glob.
 *
 * Returns null if the item has no streamable file → item is dropped.
 */
function selectStream(files: ArchiveFile[]): SelectedStream | null {
  // Rule 1: HLS preferred.
  const hlsFile = selectByPatterns(files, HLS_PATTERNS);
  if (hlsFile) return { file: hlsFile, streamType: 'hls' };

  // Rule 2: MP4 fallback.
  const mp4File = selectByPatterns(files, MP4_PATTERNS);
  if (mp4File) return { file: mp4File, streamType: 'mp4' };

  // Rule 3: No valid stream found — discard item.
  return null;
}

// ---------------------------------------------------------------------------
// Archive.org search (native fetch, JSON API)
// ---------------------------------------------------------------------------

async function searchArchive(
  query:  string,
  limit:  number
): Promise<ArchiveSearchDoc[]> {
  const params = new URLSearchParams({
    q:      query,
    fl:     SEARCH_FIELDS,
    sort:   'downloads desc',
    rows:   String(limit),
    page:   '1',
    output: 'json',
    // Exclude items without a usable title.
    'fq':   'title:(*)',
  });

  const url = `${ARCHIVE_SEARCH_BASE}?${params.toString()}`;
  log(`  Searching: ${url.slice(0, 120)}…`);

  const response = await fetchWithRetry(url, {
    headers: {
      'Accept':     'application/json',
      'User-Agent': 'Flicker.TV-Ingest/1.0 (https://flicker.tv; catalog ingestion)',
    },
  });

  if (!response.ok) {
    throw new Error(`Search API ${response.status}: ${query}`);
  }

  const data = await response.json() as ArchiveSearchResponse;
  return data?.response?.docs ?? [];
}

// ---------------------------------------------------------------------------
// Archive.org metadata fetch (native fetch, JSON API)
// ---------------------------------------------------------------------------

async function fetchItemMetadata(
  identifier: string
): Promise<ArchiveMetadataResponse | null> {
  const url = `${ARCHIVE_METADATA_BASE}/${encodeURIComponent(identifier)}`;

  try {
    const response = await fetchWithRetry(url, {
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'Flicker.TV-Ingest/1.0',
      },
    });

    if (!response.ok) return null;

    return await response.json() as ArchiveMetadataResponse;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CinemaCard builder
// ---------------------------------------------------------------------------

function buildCinemaCard(
  doc:      ArchiveSearchDoc,
  metadata: ArchiveMetadataResponse,
  stream:   SelectedStream
): CinemaCard {
  const identifier = doc.identifier;
  const meta       = metadata.metadata ?? {};
  const files      = metadata.files    ?? [];

  // Canonical stream URL — always uses archive.org download CDN.
  // For HLS: this is the absolute .m3u8 manifest URL.
  // The client HLS parser resolves .ts segment URLs relative to this base.
  const streamUrl = `${ARCHIVE_DOWNLOAD_BASE}/${encodeURIComponent(identifier)}/${stream.file.name}`;

  const rawTitle = normaliseString((meta['title'] as unknown) ?? doc.title);
  const rawDesc  = normaliseString((meta['description'] as unknown) ?? doc.description);

  const year      = parseYearString(doc);
  const director  = parseDirector(doc, meta);
  const duration  = parseDuration(files);

  return {
    id:          identifier,
    title:       rawTitle || identifier,
    description: truncate(stripHtml(rawDesc || rawTitle || ''), 1000),
    posterUrl:   `${ARCHIVE_THUMB_BASE}/${encodeURIComponent(identifier)}`,
    streamUrl,
    streamType:  stream.streamType,
    duration,
    metadata: { year, director },
  };
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function deduplicateDocs(docs: ArchiveSearchDoc[]): ArchiveSearchDoc[] {
  const seen = new Set<string>();
  const out:  ArchiveSearchDoc[] = [];
  for (const doc of docs) {
    if (!doc.identifier || seen.has(doc.identifier)) continue;
    seen.add(doc.identifier);
    out.push(doc);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub Gist publisher
//
// PATCH: Explicit try/catch with loud error propagation.
// If GIST_PAT is expired or invalid the cron job MUST exit non-zero so
// GitHub Actions marks the run as failed — a silent Gist push failure
// would leave the catalog stale without any operator notification.
// ---------------------------------------------------------------------------

async function publishToGist(catalog: CatalogGist): Promise<void> {
  if (!GIST_PAT) {
    throw new Error(
      '[Ingest] GIST_PAT is not set. ' +
        'Generate a GitHub PAT with gist scope at https://github.com/settings/tokens ' +
        'and store it as the GIST_PAT repository secret.'
    );
  }

  if (!GIST_ID) {
    throw new Error(
      '[Ingest] GIST_ID is not set. ' +
        'Create a Gist at https://gist.github.com and store its ID as the GIST_ID secret.'
    );
  }

  const payload = {
    description: `Flicker.TV Catalog — ${catalog.totalItems} films — ${catalog.generatedAt}`,
    files: {
      'catalog.json': {
        content: JSON.stringify(catalog, null, 2),
      },
      'catalog.min.json': {
        content: JSON.stringify(catalog),
      },
    },
  };

  log(`\nPushing ${catalog.totalItems} items to Gist ${GIST_ID}…`);

  // PATCH: Explicit try/catch — any failure here throws so the process exits
  // with code 1 and GitHub Actions marks the cron job run as failed.
  let response: Response;
  try {
    response = await fetchWithRetry(
      `https://api.github.com/gists/${GIST_ID}`,
      {
        method:  'PATCH',
        headers: {
          'Authorization':        `Bearer ${GIST_PAT}`,
          'Accept':               'application/vnd.github+json',
          'Content-Type':         'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent':           'Flicker.TV-Ingest/1.0',
        },
        body: JSON.stringify(payload),
      },
      3,   // max retries
      2000 // base delay ms
    );
  } catch (networkErr) {
    // Network-level failure (DNS, timeout, etc.)
    throw new Error(
      `[Ingest] Gist PATCH network failure: ${(networkErr as Error).message}. ` +
        'Check network connectivity and GitHub API availability.'
    );
  }

  if (!response.ok) {
    // Read the response body for diagnostic detail before throwing.
    let body = '';
    try {
      body = await response.text();
    } catch { /* ignore body read failure */ }

    // Provide actionable guidance for the most common failure codes.
    let hint = '';
    if (response.status === 401) {
      hint =
        'HTTP 401 Unauthorized: The GIST_PAT token is invalid or expired. ' +
        'Regenerate it at https://github.com/settings/tokens and update the ' +
        'GIST_PAT repository secret under Settings → Secrets and variables → Actions.';
    } else if (response.status === 403) {
      hint =
        'HTTP 403 Forbidden: The GIST_PAT token lacks gist write scope, or ' +
        'the token owner does not own the target Gist.';
    } else if (response.status === 404) {
      hint =
        `HTTP 404 Not Found: The Gist ID "${GIST_ID}" does not exist or is not ` +
        'accessible with the provided token. Verify GIST_ID is correct.';
    } else if (response.status === 422) {
      hint =
        'HTTP 422 Unprocessable Entity: The catalog payload may be malformed ' +
        'or exceed GitHub Gist file size limits (10 MB per file).';
    } else {
      hint = `HTTP ${response.status}: ${response.statusText}`;
    }

    throw new Error(
      `[Ingest] Gist PATCH failed.\n${hint}\nResponse body: ${body.slice(0, 500)}`
    );
  }

  const result = await response.json() as { html_url?: string };
  log(`✅ Gist updated: ${result.html_url ?? 'https://gist.github.com/' + GIST_ID}`);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string):      void { process.stdout.write(msg + '\n'); }
function logError(msg: string): void { process.stderr.write(msg + '\n'); }

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function ingest(): Promise<void> {
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('  Flicker.TV Archive.org Ingestion Pipeline');
  log(`  ${new Date().toISOString()}`);
  if (DRY_RUN) log('  MODE: DRY RUN (no Gist push)');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (!DRY_RUN && (!GIST_PAT || !GIST_ID)) {
    throw new Error(
      '[Ingest] GIST_PAT and GIST_ID must both be set.\n' +
        'Store them as repository secrets: Settings → Secrets and variables → Actions.'
    );
  }

  // ── Step 1: Query archive.org ─────────────────────────────────────────────
  log('Step 1 — Querying archive.org collections…\n');

  const perQueryLimit = Math.max(
    10,
    Math.ceil(INGEST_LIMIT / TARGET_QUERIES.length)
  );
  const allDocs: ArchiveSearchDoc[] = [];

  for (const query of TARGET_QUERIES) {
    log(`  Query: ${query}`);
    try {
      const docs = await searchArchive(query, perQueryLimit);
      log(`  → ${docs.length} results`);
      allDocs.push(...docs);
    } catch (err) {
      // Non-fatal: log and continue with remaining queries.
      logError(`  ⚠ Query failed: ${(err as Error).message}`);
    }
    await sleep(600); // Polite rate-limiting between queries.
  }

  const uniqueDocs = deduplicateDocs(allDocs);
  log(`\nTotal unique items: ${uniqueDocs.length} (from ${allDocs.length} raw)\n`);

  if (uniqueDocs.length === 0) {
    throw new Error(
      '[Ingest] No results returned from any query. ' +
        'Check archive.org API availability and query syntax.'
    );
  }

  // ── Step 2 & 3: Metadata fetch + rule-based stream selection ─────────────
  log('Step 2–3 — Fetching metadata and selecting streams…\n');

  let discarded = 0;
  let hlsCount  = 0;
  let mp4Count  = 0;

  const cards = (
    await mapConcurrent(uniqueDocs, INGEST_CONCURRENCY, async (doc, index) => {
      if ((index + 1) % 25 === 0 || index === uniqueDocs.length - 1) {
        log(`  [${index + 1}/${uniqueDocs.length}]`);
      }

      const metadata = await fetchItemMetadata(doc.identifier);
      if (!metadata?.files) { discarded++; return null; }

      const stream = selectStream(metadata.files);
      if (!stream)          { discarded++; return null; }

      if (stream.streamType === 'hls') hlsCount++;
      else                              mp4Count++;

      return buildCinemaCard(doc, metadata, stream);
    })
  ).filter((c): c is CinemaCard => c !== null);

  log(`\nStream selection:`);
  log(`  ✅ Valid   : ${cards.length}`);
  log(`  ❌ Discarded: ${discarded}`);
  log(`  HLS .m3u8 : ${hlsCount}`);
  log(`  MP4 .mp4  : ${mp4Count}\n`);

  if (cards.length === 0) {
    throw new Error(
      '[Ingest] Zero valid CinemaCards produced after stream selection. ' +
        'Verify that target collections contain streamable media files.'
    );
  }

  // ── Step 4: Build catalog ─────────────────────────────────────────────────
  log('Step 4 — Assembling catalog…\n');

  // Sort: HLS first (preferred by client), then MP4. Within each group,
  // preserve the API's downloads-descending order.
  const sorted = cards.slice().sort((a, b) => {
    if (a.streamType === 'hls' && b.streamType === 'mp4') return -1;
    if (a.streamType === 'mp4' && b.streamType === 'hls') return  1;
    return 0;
  });

  const catalog: CatalogGist = {
    generatedAt:   new Date().toISOString(),
    schemaVersion: '1.0.0',
    totalItems:    sorted.length,
    catalog:       sorted,
  };

  // ── Step 5: Publish ───────────────────────────────────────────────────────
  if (DRY_RUN) {
    log('Step 5 — DRY RUN: first 2 entries:\n');
    process.stdout.write(
      JSON.stringify({ ...catalog, catalog: catalog.catalog.slice(0, 2) }, null, 2) + '\n'
    );
    log(`\n[Dry run complete] Would have pushed ${catalog.totalItems} items.`);
    return;
  }

  log('Step 5 — Publishing to GitHub Gist…\n');

  // publishToGist throws loudly on any failure — this is intentional.
  // The process will exit with code 1 and GitHub Actions will mark the run
  // as failed, triggering any configured failure notifications.
  await publishToGist(catalog);

  log('\n✅ Ingestion pipeline complete.');
}

// ---------------------------------------------------------------------------
// Entry point — ensure process exits non-zero on any uncaught failure
// ---------------------------------------------------------------------------

ingest().catch((err: unknown) => {
  logError('\n❌ INGESTION FAILED — cron job reporting failure\n');
  logError((err as Error).message ?? String(err));
  if ((err as Error).stack) logError((err as Error).stack!);
  process.exit(1);
});