/**
 * Flicker.TV — Ground Truth Schema v1.0.0
 *
 * Canonical data contract between the archive.org ingestion pipeline,
 * the GitHub Gist catalog oracle, and all frontend consumers.
 *
 * streamType discriminator drives two distinct client-side fetch strategies:
 *
 *   'mp4' → VideoCacheManager issues HTTP Range requests (bytes=N-M).
 *           Chunks are fixed-size ArrayBuffer slices of the MP4 container.
 *           Suitable for progressive download, random seeking, and WebRTC
 *           InsertableStreams encryption at the chunk boundary level.
 *
 *   'hls' → VideoCacheManager sequences .ts segment fetches derived from
 *           the .m3u8 manifest. Each .ts segment is one discrete ArrayBuffer
 *           chunk passed to the InsertableStreams encryption layer.
 *           The streamUrl MUST point to the master .m3u8 manifest, not a
 *           variant playlist or a .ts segment directly.
 */

export type StreamType = 'mp4' | 'hls';

export interface CinemaCard {
  /** The canonical archive.org item identifier (e.g. "Nosferatu_1922"). */
  id: string;

  /** Display title sourced from archive.org item metadata. */
  title: string;

  /**
   * Plain-text description. HTML tags stripped. Max 1000 characters.
   */
  description: string;

  /**
   * Absolute URL to the item poster image.
   * Resolution order:
   *   1. WebP via archive.org /services/img/{id} (auto-selects best format)
   *   2. First image file found in the item file manifest
   */
  posterUrl: string;

  /**
   * Absolute URL to the primary media resource.
   *   streamType === 'mp4' → direct .mp4 CDN URL
   *   streamType === 'hls' → absolute master .m3u8 manifest URL
   *
   * Both forms use: https://archive.org/download/{identifier}/{filename}
   */
  streamUrl: string;

  /**
   * REQUIRED discriminator. Drives chunk-fetching strategy in
   * VideoCacheManager and segment-routing in InsertableStreams.
   * This field is NEVER optional — ingest.ts must always resolve it.
   */
  streamType: StreamType;

  /**
   * Total duration in seconds. Parsed from archive.org `length` metadata.
   * May be absent if the metadata record omits it.
   */
  duration?: number;

  metadata: {
    /**
     * 4-digit year string (e.g. "1922").
     * Sourced from archive.org `year` or `date` field.
     */
    year?: string;

    /**
     * Director / creator. Sourced from archive.org `creator` field.
     * Multiple creators joined with " & " (max 3).
     */
    director?: string;
  };
}

/**
 * Root structure of the compiled catalog pushed to the GitHub Gist.
 * Clients fetch the raw Gist URL and parse this exact shape.
 */
export interface CatalogGist {
  /** ISO 8601 timestamp of when this catalog was generated. */
  generatedAt: string;
  /** Semver schema version for forward-compatibility guards on the client. */
  schemaVersion: '1.0.0';
  /** Total number of valid CinemaCard entries. */
  totalItems: number;
  /** Validated, sorted film records. */
  catalog: CinemaCard[];
}