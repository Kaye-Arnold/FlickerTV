/**
 * Flicker.TV — Decentralized Film Node Resolver
 *
 * Resolves the best available stream URL for a given film identifier
 * by probing a prioritised list of content mirror nodes.
 *
 * Node priority:
 *   1. Primary archive.org datacentre (auto-selected by geo)
 *   2. Known archive.org mirror nodes (ia800*, ia600*, ia400*, ia200*)
 *   3. Wayback Machine CDN paths
 *   4. Original direct URL (last resort)
 *
 * Resolution strategy:
 *   C5 FIX: Probes use mode: 'no-cors' because archive.org mirror nodes do
 *   not return CORS headers for cross-origin HEAD requests from browser
 *   origins. An opaque response (status 0, type 'opaque') cannot be read,
 *   but a successfully resolved promise — rather than a thrown network error
 *   — indicates the resource is reachable. We treat promise-resolution as
 *   success and promise-rejection (network failure / DNS miss) as failure.
 *
 *   Consequence: we can no longer distinguish HTTP 200 from HTTP 404 for
 *   mirror nodes. The primary archive.org URL is always probed first with
 *   mode: 'cors' since it does serve CORS headers, and its status code IS
 *   readable. Mirror nodes fall back to opaque reachability probing.
 *
 *   Resolved URLs are cached in sessionStorage to skip re-probing on revisit.
 *   AbortSignal is respected so the resolver cancels when the user swipes away.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodeCandidate {
  url:        string;
  nodeLabel:  string;
  priority:   number;
  /**
   * When true, this node supports CORS and the probe response status is
   * readable. When false, probe uses no-cors and success is inferred from
   * promise resolution rather than status code.
   */
  corsEnabled: boolean;
}

export interface ResolvedStream {
  url:       string;
  nodeLabel: string;
  latencyMs: number;
  cached:    boolean;
}

export interface NodeResolverOptions {
  signal?:         AbortSignal;
  probeTimeoutMs?: number;
  forceRefresh?:   boolean;
  onProbeAttempt?: (candidate: NodeCandidate) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_CACHE_PREFIX = 'flicker:resolved:';

const ARCHIVE_MIRROR_PREFIXES = [
  'ia800100.us',
  'ia800200.us',
  'ia600100.us',
  'ia600200.us',
  'ia400100.us',
  'ia400200.us',
  'ia200100.us',
] as const;

const PROBE_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

function buildArchivePrimaryUrl(identifier: string, filename: string): string {
  return `https://archive.org/download/${identifier}/${filename}`;
}

function buildArchiveMirrorUrl(
  mirrorPrefix: string,
  identifier:   string,
  filename:     string
): string {
  return `https://${mirrorPrefix}.archive.org/16/${identifier}/${filename}`;
}

function buildWaybackUrl(identifier: string, filename: string): string {
  return `https://web.archive.org/web/2024/${buildArchivePrimaryUrl(identifier, filename)}`;
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

export function buildCandidates(
  identifier: string,
  filename?:  string
): NodeCandidate[] {
  const resolvedFilename = filename ?? `${identifier}.mp4`;
  const candidates: NodeCandidate[] = [];

  // Priority 0: archive.org primary — CORS headers are served here.
  // Status code is readable so we can confirm 200/206.
  candidates.push({
    url:         buildArchivePrimaryUrl(identifier, resolvedFilename),
    nodeLabel:   'archive.org/primary',
    priority:    0,
    corsEnabled: true,
  });

  // Priority 1–N: mirror nodes — no CORS headers.
  // Probed with mode: 'no-cors'; reachability inferred from promise resolution.
  ARCHIVE_MIRROR_PREFIXES.forEach((prefix, i) => {
    candidates.push({
      url:         buildArchiveMirrorUrl(prefix, identifier, resolvedFilename),
      nodeLabel:   `archive.org/${prefix}`,
      priority:    1 + i,
      corsEnabled: false,
    });
  });

  // Wayback CDN — no reliable CORS on all paths.
  candidates.push({
    url:         buildWaybackUrl(identifier, resolvedFilename),
    nodeLabel:   'wayback/cdn',
    priority:    ARCHIVE_MIRROR_PREFIXES.length + 1,
    corsEnabled: false,
  });

  return candidates.sort((a, b) => a.priority - b.priority);
}

// ---------------------------------------------------------------------------
// Probe a single candidate
// ---------------------------------------------------------------------------

async function probeCandidate(
  candidate:  NodeCandidate,
  timeoutMs:  number,
  signal?:    AbortSignal
): Promise<{ success: boolean; latencyMs: number }> {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

  const abortHandler = () => controller.abort();
  signal?.addEventListener('abort', abortHandler, { once: true });

  const start = performance.now();

  try {
    if (candidate.corsEnabled) {
      // CORS-enabled: we can read the response status.
      const response = await fetch(candidate.url, {
        method: 'HEAD',
        signal: controller.signal,
        cache:  'no-store',
        mode:   'cors',
        headers: { Range: 'bytes=0-0' },
      });

      const latencyMs = Math.round(performance.now() - start);
      // 200 OK or 206 Partial Content confirm a streamable resource.
      const success = response.status === 200 || response.status === 206;
      return { success, latencyMs };
    } else {
      // C5 FIX: no-cors mode — response is opaque (status 0, body unreadable).
      // A resolved promise means the network reached the server without a
      // hard failure (DNS miss, connection refused, timeout). We treat this
      // as a reachability signal sufficient to prefer this mirror.
      // A rejected promise means the node is unreachable.
      await fetch(candidate.url, {
        method: 'GET',   // HEAD is blocked on some CDN edges under no-cors
        signal: controller.signal,
        cache:  'no-store',
        mode:   'no-cors',
      });

      const latencyMs = Math.round(performance.now() - start);
      // Promise resolved without throwing — node is reachable.
      return { success: true, latencyMs };
    }
  } catch {
    return { success: false, latencyMs: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortHandler);
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

export async function resolveStreamNode(
  identifier: string,
  filename?:  string,
  options:    NodeResolverOptions = {}
): Promise<ResolvedStream> {
  const {
    signal,
    probeTimeoutMs = PROBE_TIMEOUT_MS,
    forceRefresh   = false,
    onProbeAttempt,
  } = options;

  // ── Session cache ────────────────────────────────────────────────────────
  const cacheKey = `${SESSION_CACHE_PREFIX}${identifier}`;
  if (!forceRefresh && typeof sessionStorage !== 'undefined') {
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as ResolvedStream;
        return { ...parsed, cached: true };
      }
    } catch {
      // sessionStorage unavailable — proceed to probe.
    }
  }

  const candidates = buildCandidates(identifier, filename);

  if (signal?.aborted) {
    return fallbackResult(candidates[0]!);
  }

  return new Promise<ResolvedStream>((resolve) => {
    let settled = false;
    let pending  = candidates.length;

    const settle = (result: ResolvedStream) => {
      if (settled) return;
      settled = true;

      if (!result.cached && typeof sessionStorage !== 'undefined') {
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify(result));
        } catch {
          // Storage full or private mode — ignore.
        }
      }

      resolve(result);
    };

    for (const candidate of candidates) {
      onProbeAttempt?.(candidate);

      probeCandidate(candidate, probeTimeoutMs, signal).then(
        ({ success, latencyMs }) => {
          pending -= 1;

          if (success) {
            settle({
              url:       candidate.url,
              nodeLabel: candidate.nodeLabel,
              latencyMs,
              cached:    false,
            });
          } else if (pending === 0 && !settled) {
            // All probes failed — fall back to primary URL and let the
            // video element's error handler surface the failure to the user.
            settle(fallbackResult(candidates[0]!));
          }
        }
      );
    }

    signal?.addEventListener(
      'abort',
      () => {
        if (!settled) settle(fallbackResult(candidates[0]!));
      },
      { once: true }
    );
  });
}

function fallbackResult(candidate: NodeCandidate): ResolvedStream {
  return {
    url:       candidate.url,
    nodeLabel: candidate.nodeLabel,
    latencyMs: 0,
    cached:    false,
  };
}

// ---------------------------------------------------------------------------
// Convenience: resolve from a full archive.org download URL
// ---------------------------------------------------------------------------

export async function resolveFromArchiveUrl(
  archiveDownloadUrl: string,
  options: NodeResolverOptions = {}
): Promise<ResolvedStream> {
  const match = archiveDownloadUrl.match(
    /archive\.org\/download\/([^/]+)\/(.+)$/
  );

  if (!match || !match[1] || !match[2]) {
    return {
      url:       archiveDownloadUrl,
      nodeLabel: 'direct',
      latencyMs: 0,
      cached:    false,
    };
  }

  return resolveStreamNode(match[1], match[2], options);
}