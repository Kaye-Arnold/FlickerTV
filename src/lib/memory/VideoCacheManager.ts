/**
 * Flicker.TV — Deferred-Release Memory Manager for Video Blobs
 *
 * Phase 3 upgrade: streamType-aware chunk fetching.
 *
 * Prior behaviour: chunks were stored externally and passed in as ArrayBuffers.
 * The manager's role was limited to ObjectURL lifecycle and OOM prevention.
 *
 * Phase 3 behaviour: the manager now owns the fetch layer.
 * Given a CinemaCard (or its subset StreamSource), it:
 *
 *   streamType === 'mp4'
 *     → Issues HTTP Range requests (Range: bytes=N-M) against the direct
 *       MP4 URL. Chunk size defaults to 2 MB, configurable per-stream.
 *       Returns fixed-size ArrayBuffer slices.
 *
 *   streamType === 'hls'
 *     → Fetches and parses the .m3u8 manifest, then fetches .ts segments
 *       in sequence. Each .ts segment is one discrete ArrayBuffer chunk.
 *       The segment list is resolved once and cached; individual segments
 *       are fetched on demand (no eager pre-buffering beyond one lookahead).
 *
 * In both cases the output is a uniform ArrayBuffer chunk that is passed
 * directly to the InsertableStreams encryption layer (Phase 2) without any
 * additional transformation. The encryption layer is chunk-shape-agnostic.
 *
 * OOM prevention is unchanged: 512 MB hard ceiling, LRU eviction, immediate
 * URL.revokeObjectURL() on consumption, TTL-based registry sweeper.
 */

import type { StreamType } from '@/types/schema';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StreamSource {
  /** archive.org identifier — used as the cache key. */
  id:         string;
  /** Direct MP4 URL or master .m3u8 manifest URL. */
  streamUrl:  string;
  streamType: StreamType;
}

export interface VideoChunk {
  readonly buffer:        ArrayBuffer;
  readonly byteOffset:    number;
  readonly byteLength:    number;
  readonly sequenceIndex: number;
  readonly streamId:      string;
  objectUrl:   string | null;
  consumedAt:  number | null;
}

export interface ChunkRequest {
  source:         StreamSource;
  sequenceIndex:  number;
  /** MP4 only: byte range start. HLS: ignored (segment URL is used). */
  byteRangeStart?: number;
  /** MP4 only: byte range end (inclusive). HLS: ignored. */
  byteRangeEnd?: number;
  /** Cancels a pending manifest, segment, or range request. */
  signal?: AbortSignal;
}

export interface CacheMetrics {
  totalResidentBytes:   number;
  totalRegistries:      number;
  totalChunks:          number;
  totalRevocations:     number;
  totalEvictions:       number;
  oomGuardActivations:  number;
  totalMp4ChunksFetched: number;
  totalHlsSegmentsFetched: number;
}

// ---------------------------------------------------------------------------
// HLS manifest parser (minimal — extracts .ts segment URLs only)
// ---------------------------------------------------------------------------

interface HlsManifest {
  segmentUrls: string[];
  /** Base URL used to resolve relative segment paths. */
  baseUrl:     string;
}

/**
 * Parse a .m3u8 manifest text and return the ordered list of .ts segment URLs.
 *
 * Handles:
 *   - Master playlists: selects the first variant stream URL and fetches it.
 *     The caller is responsible for providing the parsed variant URL if needed;
 *     this parser returns the first EXT-X-STREAM-INF URI as a redirect signal.
 *   - Media playlists: extracts all URI lines that do not begin with # and
 *     resolves them against the manifest base URL.
 *
 * This is an intentionally minimal parser. It does not handle:
 *   - EXT-X-KEY (encryption) — segments are fetched as plaintext and
 *     encrypted by the InsertableStreams layer at the WebRTC level.
 *   - EXT-X-BYTERANGE — not commonly used by archive.org.
 *   - Live streams — archive.org serves only VOD content.
 */
function parseHlsManifest(manifestText: string, manifestUrl: string): HlsManifest {
  const baseUrl = new URL('.', manifestUrl).toString();
  const lines = manifestText.split(/\r?\n/).map((line) => line.trim());
  const segmentUrls: string[] = [];
  let   isMasterPlaylist = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line === '' || line.startsWith('#EXTM3U')) continue;

    // Detect master playlist.
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMasterPlaylist = true;
      continue;
    }

    // In a master playlist, the next non-comment line after EXT-X-STREAM-INF
    // is the variant playlist URL — treat the first variant as the selected one.
    if (isMasterPlaylist && !line.startsWith('#')) {
      const variantUrl = new URL(line, manifestUrl).toString();
      // Signal to the caller that this is a master playlist variant.
      // We return a single "segment" URL that is actually the variant playlist.
      return {
        segmentUrls: [variantUrl],
        baseUrl,
      };
    }

    // Skip all other directives.
    if (line.startsWith('#')) continue;

    // Non-comment, non-empty line in a media playlist = segment URI.
    if (!isMasterPlaylist) {
      const resolved = new URL(line, manifestUrl).toString();
      segmentUrls.push(resolved);
    }
  }

  return { segmentUrls, baseUrl };
}

// ---------------------------------------------------------------------------
// Internal registry types
// ---------------------------------------------------------------------------

interface ChunkRegistry {
  chunks:          Map<number, VideoChunk>;
  totalBytes:      number;
  createdAt:       number;
  lastAccessedAt:  number;
  /**
   * HLS only: resolved segment URL list.
   * Populated on first fetchChunk() call for an HLS stream.
   * null = not yet resolved.
   */
  hlsSegmentUrls:  string[] | null;
  hlsManifestUrl:  string   | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 512 MB hard ceiling — preserves headroom on 4 GB Android devices. */
const MAX_RESIDENT_BYTES = 512 * 1024 * 1024;

/** Default MP4 chunk size: 2 MB. Tunable via fetchChunk chunkSize param. */
const DEFAULT_MP4_CHUNK_SIZE = 2 * 1024 * 1024;

const REGISTRY_TTL_MS    = 5 * 60 * 1000;
const EVICTION_INTERVAL_MS = 60 * 1000;

const INITIAL_CHUNK_SEQUENCE_INDEX = 0;

interface RequestSignal {
  signal: AbortSignal;
  dispose: () => void;
}

function createRequestSignal(
  timeoutMs: number,
  parentSignal?: AbortSignal
): RequestSignal {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );

  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

// ---------------------------------------------------------------------------
// VideoCacheManager
// ---------------------------------------------------------------------------

class VideoCacheManager {
  private static instance: VideoCacheManager | null = null;
  private chunkMap = new WeakMap<HTMLVideoElement, ChunkRegistry>();
  private activeRegistries = new Map<HTMLVideoElement, ChunkRegistry>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private metrics: CacheMetrics = {
    totalResidentBytes: 0,
    totalRegistries: 0,
    totalChunks: 0,
    totalRevocations: 0,
    totalEvictions: 0,
    oomGuardActivations: 0,
    totalMp4ChunksFetched: 0,
    totalHlsSegmentsFetched: 0,
  };

  private constructor() {
    this.startEvictionSweeper();
  }

  static getInstance(): VideoCacheManager {
    if (!VideoCacheManager.instance) {
      VideoCacheManager.instance = new VideoCacheManager();
    }
    return VideoCacheManager.instance;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  public registerVideoElement(videoEl: HTMLVideoElement): void {
    if (this.chunkMap.has(videoEl)) return;

    const registry: ChunkRegistry = {
      chunks:         new Map(),
      totalBytes:     0,
      createdAt:      Date.now(),
      lastAccessedAt: Date.now(),
      hlsSegmentUrls: null,
      hlsManifestUrl: null,
    };

    this.chunkMap.set(videoEl, registry);
    this.activeRegistries.set(videoEl, registry);
    this.metrics.totalRegistries += 1;
  }

  // ---------------------------------------------------------------------------
  // Phase 3 core: streamType-aware chunk fetching
  // ---------------------------------------------------------------------------

  /**
   * Fetch the next chunk for a video element according to its streamType.
   *
   * MP4 path:
   *   Issues a Range: bytes={start}-{end} HTTP request.
   *   Returns the response body as an ArrayBuffer.
   *   The caller provides byteRangeStart and optionally byteRangeEnd.
   *   If byteRangeEnd is absent, the chunk size defaults to DEFAULT_MP4_CHUNK_SIZE.
   *
   * HLS path:
   *   On the first call (sequenceIndex === 0):
   *     1. Fetches and parses the .m3u8 manifest.
   *     2. If the manifest is a master playlist, fetches and parses the
   *        first variant playlist to resolve the segment list.
   *     3. Caches the segment URL list in the registry.
   *   On subsequent calls:
   *     Uses the cached segment URL list to fetch segment[sequenceIndex].
   *
   * Returns the ObjectURL for immediate assignment to video.src, or null
   * if the OOM guard rejected the chunk or the fetch failed.
   */
  public async fetchChunk(
    videoEl:   HTMLVideoElement,
    request:   ChunkRequest,
    chunkSize: number = DEFAULT_MP4_CHUNK_SIZE
  ): Promise<string | null> {
    const registry = this.chunkMap.get(videoEl);
    if (!registry) {
      console.error('[VideoCacheManager] fetchChunk called on unregistered element.');
      return null;
    }

    const { source, sequenceIndex } = request;

    let buffer: ArrayBuffer;

    try {
      if (source.streamType === 'mp4') {
        buffer = await this.fetchMp4Chunk(source.streamUrl, request, chunkSize);
        this.metrics.totalMp4ChunksFetched += 1;
      } else {
        buffer = await this.fetchHlsSegment(
          source,
          sequenceIndex,
          registry,
          request.signal
        );
        this.metrics.totalHlsSegmentsFetched += 1;
      }
    } catch (err) {
      console.error(
        `[VideoCacheManager] Chunk fetch failed for ${source.id}[${sequenceIndex}]:`,
        err
      );
      return null;
    }

    return this.storeChunk(videoEl, buffer, sequenceIndex, source.id, source.streamType);
  }

  // ---------------------------------------------------------------------------
  // MP4 byte-range fetch
  // ---------------------------------------------------------------------------

  private async fetchMp4Chunk(
    url: string,
    request: ChunkRequest,
    chunkSize: number
  ): Promise<ArrayBuffer> {
    const start = request.byteRangeStart ?? 0;
    const end = request.byteRangeEnd ?? start + chunkSize - 1;
    const requestSignal = createRequestSignal(30_000, request.signal);

    try {
      const response = await fetch(url, {
        headers: {
          // Range header instructs the server to return a partial response (HTTP 206).
          // This is the standard mechanism for MP4 progressive download chunking.
          Range: `bytes=${start}-${end}`,
        },
        signal: requestSignal.signal,
      });

      // HTTP 206 Partial Content = success for range request.
      // HTTP 200 = server ignored the Range header and returned the full response.
      if (!response.ok && response.status !== 206) {
        throw new Error(
          `[VideoCacheManager] MP4 range fetch failed: HTTP ${response.status} for ${url}`
        );
      }

      return await response.arrayBuffer();
    } finally {
      requestSignal.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // HLS segment fetch
  // ---------------------------------------------------------------------------

  /**
   * Fetch a single .ts segment by sequenceIndex.
   *
   * On the first call for this registry, resolves the segment list from the
   * .m3u8 manifest and caches it. Subsequent calls use the cached list.
   *
   * If the initial manifest parse reveals a master playlist, a second fetch
   * is performed to resolve the first variant's media playlist.
   */
  private async fetchHlsSegment(
    source: StreamSource,
    sequenceIndex: number,
    registry: ChunkRegistry,
    parentSignal?: AbortSignal
  ): Promise<ArrayBuffer> {
    // Resolve segment list on first access.
    if (registry.hlsSegmentUrls === null) {
      registry.hlsSegmentUrls = await this.resolveHlsSegmentList(
        source.streamUrl,
        registry,
        parentSignal
      );
    }

    const segmentUrls = registry.hlsSegmentUrls;

    if (segmentUrls.length === 0) {
      throw new Error(
        `[VideoCacheManager] HLS manifest for ${source.id} resolved to zero segments.`
      );
    }

    if (sequenceIndex >= segmentUrls.length) {
      throw new Error(
        `[VideoCacheManager] HLS sequenceIndex ${sequenceIndex} out of range ` +
          `(${segmentUrls.length} segments available for ${source.id}).`
      );
    }

    const segmentUrl = segmentUrls[sequenceIndex]!;
    const requestSignal = createRequestSignal(30_000, parentSignal);

    try {
      const response = await fetch(segmentUrl, {
        // HLS .ts segments are fetched without Range headers — each segment is
        // a complete MPEG-TS container. The full segment is one chunk unit.
        signal: requestSignal.signal,
      });

      if (!response.ok) {
        throw new Error(
          `[VideoCacheManager] HLS segment fetch failed: HTTP ${response.status} for ${segmentUrl}`
        );
      }

      return await response.arrayBuffer();
    } finally {
      requestSignal.dispose();
    }
  }

  /**
   * Resolve the ordered segment URL list from an .m3u8 manifest URL.
   *
   * Handles the two-level HLS hierarchy:
   *   master playlist → variant playlist → .ts segment list
   *
   * archive.org typically serves single-level media playlists, but we handle
   * the master-playlist case for correctness and future-proofing.
   */
  private async resolveHlsSegmentList(
    manifestUrl: string,
    registry: ChunkRegistry,
    parentSignal?: AbortSignal
  ): Promise<string[]> {
    registry.hlsManifestUrl = manifestUrl;
    const manifestRequest = createRequestSignal(15_000, parentSignal);

    let manifestResponse: Response;
    try {
      manifestResponse = await fetch(manifestUrl, {
        signal: manifestRequest.signal,
      });
    } finally {
      manifestRequest.dispose();
    }

    if (!manifestResponse.ok) {
      throw new Error(
        `[VideoCacheManager] .m3u8 fetch failed: HTTP ${manifestResponse.status} for ${manifestUrl}`
      );
    }

    const manifestText = await manifestResponse.text();
    const parsed       = parseHlsManifest(manifestText, manifestUrl);

    // If the manifest is a master playlist, parsed.segmentUrls contains one
    // variant playlist URL. Fetch and parse that second-level manifest.
    if (
      parsed.segmentUrls.length === 1 &&
      parsed.segmentUrls[0] &&
      (parsed.segmentUrls[0].endsWith('.m3u8') ||
       parsed.segmentUrls[0].includes('.m3u8?'))
    ) {
      const variantUrl = parsed.segmentUrls[0];
      const variantRequest = createRequestSignal(15_000, parentSignal);

      let variantResponse: Response;
      try {
        variantResponse = await fetch(variantUrl, {
          signal: variantRequest.signal,
        });
      } finally {
        variantRequest.dispose();
      }

      if (!variantResponse.ok) {
        throw new Error(
          `[VideoCacheManager] HLS variant playlist fetch failed: HTTP ${variantResponse.status}`
        );
      }

      const variantText = await variantResponse.text();
      const variantParsed = parseHlsManifest(variantText, variantUrl);
      return variantParsed.segmentUrls;
    }

    return parsed.segmentUrls;
  }

  // ---------------------------------------------------------------------------
  // Chunk storage (ArrayBuffer → Blob → ObjectURL)
  // ---------------------------------------------------------------------------

  private storeChunk(
    videoEl:       HTMLVideoElement,
    buffer:        ArrayBuffer,
    sequenceIndex: number,
    streamId:      string,
    streamType:    StreamType
  ): string | null {
    const registry = this.chunkMap.get(videoEl);
    if (!registry) return null;

    // Replacing a sequence index must release the old blob before accounting
    // for the new one. Concurrent retries otherwise leak both the byte count
    // and the ObjectURL until the whole video element is destroyed.
    const previousChunk = registry.chunks.get(sequenceIndex);
    if (previousChunk) {
      if (previousChunk.objectUrl !== null) {
        URL.revokeObjectURL(previousChunk.objectUrl);
        this.metrics.totalRevocations += 1;
      }
      registry.chunks.delete(sequenceIndex);
      registry.totalBytes -= previousChunk.byteLength;
      this.metrics.totalResidentBytes -= previousChunk.byteLength;
      this.metrics.totalChunks -= 1;
    }

    // OOM guard.
    if (this.metrics.totalResidentBytes + buffer.byteLength > MAX_RESIDENT_BYTES) {
      this.metrics.oomGuardActivations += 1;
      console.warn(
        `[VideoCacheManager] OOM guard activated: ` +
          `${this.formatBytes(this.metrics.totalResidentBytes)} resident, ` +
          `${this.formatBytes(buffer.byteLength)} requested.`
      );
      this.evictStalest();

      if (this.metrics.totalResidentBytes + buffer.byteLength > MAX_RESIDENT_BYTES) {
        return null; // Hard reject.
      }
    }

    const mimeType  = streamType === 'hls' ? 'video/mp2t' : 'video/mp4';
    const blob      = new Blob([buffer], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);

    const chunk: VideoChunk = {
      buffer,
      byteOffset:    0,
      byteLength:    buffer.byteLength,
      sequenceIndex,
      streamId,
      objectUrl,
      consumedAt:    null,
    };

    registry.chunks.set(sequenceIndex, chunk);
    registry.totalBytes             += buffer.byteLength;
    registry.lastAccessedAt          = Date.now();
    this.metrics.totalResidentBytes += buffer.byteLength;
    this.metrics.totalChunks        += 1;

    return objectUrl;
  }

  // ---------------------------------------------------------------------------
  // Deferred-release: consume chunk immediately upon playback
  // ---------------------------------------------------------------------------

  /**
   * Called by CinemaPlayer's 'playing' event listener (wired in Phase 1.5 C4).
   *
   * Revokes the ObjectURL synchronously and removes the chunk from the
   * registry. This is the primary mechanism for keeping resident memory
   * minimal between the fetch and the video element's internal decode buffer
   * taking ownership of the data.
   */
  public consumeChunk(
    videoEl:       HTMLVideoElement,
    sequenceIndex: number
  ): void {
    const registry = this.chunkMap.get(videoEl);
    if (!registry) return;

    const chunk = registry.chunks.get(sequenceIndex);
    if (!chunk)   return;

    if (chunk.objectUrl !== null) {
      URL.revokeObjectURL(chunk.objectUrl);
      this.metrics.totalRevocations += 1;
      (chunk as { objectUrl: string | null }).objectUrl = null;
    }

    (chunk as { consumedAt: number | null }).consumedAt = Date.now();

    registry.chunks.delete(sequenceIndex);
    registry.totalBytes             -= chunk.byteLength;
    this.metrics.totalResidentBytes -= chunk.byteLength;
    this.metrics.totalChunks        -= 1;
    registry.lastAccessedAt          = Date.now();
  }

  // ---------------------------------------------------------------------------
  // InsertableStreams integration point
  // ---------------------------------------------------------------------------

  /**
   * Returns the raw ArrayBuffer for a stored chunk as a zero-copy DataView.
   *
   * This is the handoff point to the Phase 2 InsertableStreams encryption layer:
   *   DataView → Uint8Array(view.buffer, view.byteOffset, view.byteLength)
   *   → crypto.subtle.encrypt(AES-GCM, sessionKey, plaintext)
   *   → RTCRtpSender encrypted wire frame
   *
   * Works uniformly for both MP4 chunks and HLS .ts segments — the
   * InsertableStreams layer is chunk-shape-agnostic.
   *
   * Returns null if the chunk has already been consumed.
   */
  public getChunkView(
    videoEl:       HTMLVideoElement,
    sequenceIndex: number
  ): DataView | null {
    const registry = this.chunkMap.get(videoEl);
    if (!registry) return null;

    const chunk = registry.chunks.get(sequenceIndex);
    if (!chunk || chunk.objectUrl === null) return null;

    registry.lastAccessedAt = Date.now();
    return new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }

  /**
   * Returns the total number of segments in the HLS manifest for a given
   * video element. Returns null for MP4 streams or if the manifest has not
   * yet been resolved.
   *
   * Used by the player layer to determine when HLS playback is complete.
   */
  public getHlsSegmentCount(videoEl: HTMLVideoElement): number | null {
    const registry = this.chunkMap.get(videoEl);
    if (!registry || !registry.hlsSegmentUrls) return null;
    return registry.hlsSegmentUrls.length;
  }

  // ---------------------------------------------------------------------------
  // Registry lifecycle
  // ---------------------------------------------------------------------------

  public releaseRegistry(videoEl: HTMLVideoElement): void {
    const registry = this.chunkMap.get(videoEl);
    if (!registry) return;
    this.purgeRegistry(videoEl, registry);
    this.activeRegistries.delete(videoEl);
  }

  public getMetrics(): Readonly<CacheMetrics> {
    return { ...this.metrics };
  }

  public destroy(): void {
    if (this.evictionTimer !== null) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const [videoEl, registry] of this.activeRegistries.entries()) {
      this.purgeRegistry(videoEl, registry);
    }
    this.activeRegistries.clear();
  }

  // ---------------------------------------------------------------------------
  // Private internals
  // ---------------------------------------------------------------------------

  private purgeRegistry(
    videoEl: HTMLVideoElement,
    registry: ChunkRegistry
  ): void {
    if (!this.activeRegistries.has(videoEl)) return;

    for (const [seqIndex, chunk] of registry.chunks.entries()) {
      if (chunk.objectUrl !== null) {
        URL.revokeObjectURL(chunk.objectUrl);
        this.metrics.totalRevocations += 1;
        (chunk as { objectUrl: string | null }).objectUrl = null;
      }
      this.metrics.totalResidentBytes -= chunk.byteLength;
      this.metrics.totalChunks        -= 1;
      registry.chunks.delete(seqIndex);
    }
    registry.totalBytes          = 0;
    registry.hlsSegmentUrls = null;
    this.chunkMap.delete(videoEl);
    this.activeRegistries.delete(videoEl);
    this.metrics.totalRegistries -= 1;
    this.metrics.totalEvictions += 1;
  }

  private evictStalest(): void {
    let stalestEl:   HTMLVideoElement | null = null;
    let stalestTime: number                  = Infinity;

    for (const [videoEl, registry] of this.activeRegistries.entries()) {
      if (registry.lastAccessedAt < stalestTime) {
        stalestTime = registry.lastAccessedAt;
        stalestEl   = videoEl;
      }
    }

    if (stalestEl !== null) {
      const registry = this.activeRegistries.get(stalestEl)!;
      this.purgeRegistry(stalestEl, registry);
      this.activeRegistries.delete(stalestEl);
    }
  }

  private startEvictionSweeper(): void {
    this.evictionTimer = setInterval(() => {
      const now = Date.now();
      for (const [videoEl, registry] of this.activeRegistries.entries()) {
        if (!videoEl.isConnected || now - registry.lastAccessedAt > REGISTRY_TTL_MS) {
          this.purgeRegistry(videoEl, registry);
          this.activeRegistries.delete(videoEl);
        }
      }
    }, EVICTION_INTERVAL_MS);

    if (
      this.evictionTimer &&
      typeof this.evictionTimer === 'object' &&
      'unref' in this.evictionTimer
    ) {
      (this.evictionTimer as NodeJS.Timeout).unref();
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024)               return `${bytes} B`;
    if (bytes < 1024 * 1024)        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: VideoCacheManager | null = null;

export function getVideoCacheManager(): VideoCacheManager {
  if (typeof window === 'undefined') {
    throw new Error(
      '[VideoCacheManager] Cannot instantiate on the server. ' +
        'Call only in client-side code.'
    );
  }

  if (_instance === null) {
    _instance = VideoCacheManager.getInstance();
    window.addEventListener('beforeunload', () => {
      _instance?.destroy();
    });
  }

  return _instance;
}

export { VideoCacheManager, INITIAL_CHUNK_SEQUENCE_INDEX };
