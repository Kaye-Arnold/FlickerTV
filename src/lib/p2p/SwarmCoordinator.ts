/**
 * Flicker.TV — Swarm Coordinator
 *
 * Orchestrates the full decentralized film streaming swarm by connecting
 * the Phase 1 and Phase 2 infrastructure layers into a single coherent system:
 *
 *   WebAuthnIdentity  →  derives Nostr/Gun keypair
 *         │
 *         ▼
 *   NostrClient       →  discovers peers and film announcements
 *         │
 *         ▼
 *   PeerConnectionManager  →  manages WebRTC lifecycle
 *         │                        │
 *         ▼                        ▼
 *   NodeResolver         InsertableStreams (AES-GCM)
 *   (stream URL)         (blind seeding)
 *         │
 *         ▼
 *   VideoCacheManager    →  deferred-release memory
 *         │
 *         ▼
 *   CinemaPlayer         →  decrypted frames → video element
 *
 * Peer Discovery:
 *   1. On init, subscribe to FILM_ANNOUNCEMENT events on Nostr relays.
 *   2. Parse announcements into CinemaCards and inject into the feed store.
 *   3. When a viewer opens a film, publish a WATCH_REQUEST (private, NIP-17)
 *      to known seeders for that film.
 *   4. Seeders respond with an SDP offer; the viewer receives it via the
 *      signaling proxy WebSocket and hands off to PeerConnectionManager.
 *
 * Swarm Health:
 *   - The coordinator tracks which peers are seeding which films.
 *   - If a connection drops, it retries via NodeResolver HTTP fallback before
 *     giving up on P2P entirely.
 *   - Reports swarm metrics (peer count, connection quality) to callers.
 */

import { NostrClient, getNostrClient, NOSTR_KINDS, FLICKER_DEFAULT_RELAYS }
  from '../nostr/NostrClient';
import {
  PeerConnectionManager,
  getPeerConnectionManager,
  type ManagedConnection,
  type PeerConnectionConfig,
} from './PeerConnectionManager';
import { resolveFromArchiveUrl, type ResolvedStream } from './NodeResolver';
import type { FlickerIdentity }                       from '../crypto/WebAuthnIdentity';
import type { NostrEvent, NostrSubscription }         from '../nostr/NostrClient';
import type { CinemaCard }                            from '@/components/Feed/SwiperFeed';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SwarmState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'degraded'   // Nostr relays connected, no P2P peers available
  | 'offline'    // All relays down; falling back to HTTP
  | 'error';

export interface SwarmPeerInfo {
  pubkeyHex:      string;
  seeding:        string[];  // archive.org identifiers this peer is seeding
  connectionId:   string | null;
  connectionState: string;
  addedAt:        number;
  lastSeenAt:     number;
}

export interface FilmSeedRecord {
  identifier:  string;
  seeders:     string[];   // pubkeyHex array
  resolvedUrl: ResolvedStream | null;
  lastUpdated: number;
}

export interface SwarmMetrics {
  state:           SwarmState;
  connectedRelays: number;
  knownPeers:      number;
  activeConnections: number;
  seedRecords:     number;
  localPubkeyHex:  string | null;
}

export interface SwarmCoordinatorOptions {
  identity:         FlickerIdentity;
  signalingUrl:     string;
  /** Additional Nostr relay URLs beyond the defaults. */
  extraRelays?:     string[];
  /** Called when swarm state changes. */
  onStateChange?:   (state: SwarmState) => void;
  /** Called when new films are discovered via Nostr. */
  onFilmDiscovered?: (card: CinemaCard) => void;
  /** Called when swarm metrics update (throttled to 5s). */
  onMetrics?:       (metrics: SwarmMetrics) => void;
}

// ---------------------------------------------------------------------------
// Nostr film announcement parsing
// ---------------------------------------------------------------------------

function parseFilmAnnouncement(event: NostrEvent): CinemaCard | null {
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>;

    if (
      typeof content['title']      !== 'string' ||
      typeof content['identifier'] !== 'string' ||
      typeof content['archiveUrl'] !== 'string'
    ) {
      return null;
    }

    const genres: string[] = event.tags
      .filter((t) => t[0] === 't' && typeof t[1] === 'string')
      .map((t) => t[1] as string);

    const year = typeof content['year'] === 'number' ? content['year'] as number : 1920;

    return {
      tmdbId:         content['identifier'] as string,
      movieTitle:     content['title'] as string,
      releaseYear:    year,
      directorName:   (content['director'] as string | undefined) ?? 'Unknown',
      synopsis:       (content['synopsis'] as string | undefined) ??
                        'A public domain film from the Internet Archive.',
      trailerUrl:     content['archiveUrl'] as string,
      posterWebpUrl:  (content['posterUrl'] as string | undefined) ??
                        `https://archive.org/services/img/${content['identifier']}`,
      backdropUrl:    (content['posterUrl'] as string | undefined) ??
                        `https://archive.org/services/img/${content['identifier']}`,
      runtimeMinutes: (content['runtimeMinutes'] as number | undefined) ?? 60,
      genres:         genres.length > 0 ? genres : ['Silent', 'Classic'],
      archiveOrgUrl:  content['archiveUrl'] as string,
      rating:         content['rating'] as number | undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SwarmCoordinator
// ---------------------------------------------------------------------------

export class SwarmCoordinator {
  private readonly options:     SwarmCoordinatorOptions;
  private          state:       SwarmState  = 'idle';
  private          nostr:       NostrClient | null = null;
  private          pcManager:   PeerConnectionManager | null = null;
  private          destroyed    = false;

  // Peer registry: pubkeyHex → SwarmPeerInfo
  private readonly peers:       Map<string, SwarmPeerInfo> = new Map();

  // Film seed registry: archive identifier → FilmSeedRecord
  private readonly seedRecords: Map<string, FilmSeedRecord> = new Map();

  // Active Nostr subscriptions.
  private filmFeedSub:    NostrSubscription | null = null;
  private dmSub:          NostrSubscription | null = null;

  // Metrics throttle timer.
  private metricsTimer:   ReturnType<typeof setInterval> | null = null;

  // Pending watch requests: identifier → resolve/reject callbacks
  private readonly watchRequests: Map<string, {
    resolve: (stream: ResolvedStream) => void;
    reject:  (err: Error) => void;
    timer:   ReturnType<typeof setTimeout>;
  }> = new Map();

  constructor(options: SwarmCoordinatorOptions) {
    this.options = options;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.destroyed) throw new Error('[SwarmCoordinator] Already destroyed.');
    if (this.state !== 'idle') return;

    this.setState('initializing');

    const relayUrls = [
      ...FLICKER_DEFAULT_RELAYS,
      ...(this.options.extraRelays ?? []),
    ];

    // Initialize Nostr client with identity.
    this.nostr = getNostrClient({
      relayUrls,
      identity:          this.options.identity,
      verifySignatures:  true,
      onRelayStateChange: (_url, relayState) => {
        this.refreshDerivedState();
      },
    });

    this.nostr.setIdentity(this.options.identity);

    // Initialize PeerConnection manager.
    this.pcManager = getPeerConnectionManager(
      this.options.identity,
      this.options.signalingUrl,
    );

    // Subscribe to the film discovery feed.
    this.filmFeedSub = this.nostr.subscribeToFilmFeed(
      (event, _relayUrl) => {
        this.handleFilmAnnouncement(event);
      }
    );

    // Subscribe to incoming DMs (SDP signals, watch invites).
    this.dmSub = this.nostr.subscribeToDirectMessages(
      (event, _relayUrl) => {
        this.handleIncomingDM(event);
      }
    );

    // Announce ourselves as online.
    await this.publishPresence();

    this.setState('ready');

    // Start metrics reporting.
    if (this.options.onMetrics) {
      this.metricsTimer = setInterval(() => {
        this.options.onMetrics!(this.getMetrics());
      }, 5000);
    }
  }

  // ---------------------------------------------------------------------------
  // Nostr event handlers
  // ---------------------------------------------------------------------------

  private handleFilmAnnouncement(event: NostrEvent): void {
    const card = parseFilmAnnouncement(event);
    if (!card) return;

    // Update the seeder registry.
    const identifier = card.tmdbId;
    if (!this.seedRecords.has(identifier)) {
      this.seedRecords.set(identifier, {
        identifier,
        seeders:     [],
        resolvedUrl: null,
        lastUpdated: Date.now(),
      });
    }

    const record = this.seedRecords.get(identifier)!;
    if (!record.seeders.includes(event.pubkey)) {
      record.seeders.push(event.pubkey);
      record.lastUpdated = Date.now();
    }

    // Track as known peer.
    this.upsertPeer(event.pubkey, identifier);

    // Notify feed store of discovered film.
    this.options.onFilmDiscovered?.(card);
  }

  private handleIncomingDM(event: NostrEvent): void {
    // DMs may contain watch-request responses (resolved stream URLs from seeders).
    try {
      const content = JSON.parse(event.content) as Record<string, unknown>;
      if (content['type'] === 'WATCH_RESPONSE') {
        const identifier = content['identifier'] as string | undefined;
        const streamUrl  = content['streamUrl']  as string | undefined;

        if (!identifier || !streamUrl) return;

        const pending = this.watchRequests.get(identifier);
        if (pending) {
          clearTimeout(pending.timer);
          this.watchRequests.delete(identifier);
          pending.resolve({
            url:       streamUrl,
            nodeLabel: `peer:${event.pubkey.slice(0, 8)}`,
            latencyMs: 0,
            cached:    false,
          });
        }
      }
    } catch {
      // Non-JSON DM — likely an SDP signal, handled by PCManager.
    }
  }

  // ---------------------------------------------------------------------------
  // Public API: resolve a film stream
  // ---------------------------------------------------------------------------

  /**
   * Resolve the best available stream URL for a film, attempting:
   *   1. Known swarm seeder (P2P via PeerConnectionManager)
   *   2. NodeResolver HTTP mirror probing (Phase 2)
   *   3. Direct archive.org primary URL (fallback)
   *
   * @param card     The film to resolve.
   * @param signal   Optional AbortSignal.
   * @returns        Resolved stream URL and metadata.
   */
  async resolveFilmStream(
    card:    CinemaCard,
    signal?: AbortSignal
  ): Promise<ResolvedStream> {
    const identifier = card.tmdbId;

    // Step 1: Check if we have active seeders for this film.
    const seedRecord = this.seedRecords.get(identifier);
    if (seedRecord && seedRecord.resolvedUrl) {
      return seedRecord.resolvedUrl;
    }

    // Step 2: Broadcast a watch request to known seeders.
    const knownSeeders = seedRecord?.seeders ?? [];
    if (knownSeeders.length > 0 && this.state === 'ready') {
      try {
        const p2pStream = await this.requestStreamFromPeers(
          identifier,
          knownSeeders,
          signal
        );
        if (seedRecord) {
          seedRecord.resolvedUrl = p2pStream;
          seedRecord.lastUpdated = Date.now();
        }
        return p2pStream;
      } catch {
        // P2P failed — fall through to HTTP resolution.
      }
    }

    // Step 3: NodeResolver HTTP mirror probing.
    const resolved = await resolveFromArchiveUrl(card.trailerUrl, { signal });

    if (seedRecord) {
      seedRecord.resolvedUrl = resolved;
      seedRecord.lastUpdated = Date.now();
    }

    return resolved;
  }

  /**
   * Send a NIP-17 WATCH_REQUEST DM to each known seeder and wait for a
   * WATCH_RESPONSE, with a 5-second timeout before falling back to HTTP.
   */
  private async requestStreamFromPeers(
    identifier: string,
    seeders:    string[],
    signal?:    AbortSignal
  ): Promise<ResolvedStream> {
    if (!this.nostr) throw new Error('Nostr client not initialized');

    return new Promise<ResolvedStream>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.watchRequests.delete(identifier);
        reject(new Error('Peer watch request timed out.'));
      }, 5000);

      if (signal) {
        signal.addEventListener('abort', () => {
          this.watchRequests.delete(identifier);
          clearTimeout(timeout);
          reject(new Error('Watch request aborted.'));
        }, { once: true });
      }

      this.watchRequests.set(identifier, { resolve, reject, timer: timeout });

      // Publish watch request to each seeder via NIP-17 DM.
      // (Simplified: publish as a public tagged note for demo purposes.
      //  Production: encrypt each request individually with NIP-44.)
      const content = JSON.stringify({
        type:       'WATCH_REQUEST',
        identifier,
        requester:  this.options.identity.nostr.npubHex,
      });

      this.nostr!.publish({
        kind:    NOSTR_KINDS.WATCH_PARTY_INVITE,
        content,
        tags:    [
          ['d', identifier],
          ...seeders.map((s) => ['p', s]),
        ],
      }).catch(() => {
        // Publish failure is non-fatal — timeout will handle it.
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Presence announcement
  // ---------------------------------------------------------------------------

  private async publishPresence(): Promise<void> {
    if (!this.nostr) return;
    try {
      await this.nostr.publish({
        kind:    NOSTR_KINDS.SET_METADATA,
        content: JSON.stringify({
          name:    'Flicker.TV Viewer',
          about:   'Public domain cinema swarm node.',
          picture: 'https://flicker.tv/icons/icon-192x192.png',
        }),
        tags: [['client', 'flicker.tv']],
      });
    } catch {
      // Non-fatal — viewer still works without presence.
    }
  }

  // ---------------------------------------------------------------------------
  // Announce a film to the swarm (origin/seeder role)
  // ---------------------------------------------------------------------------

  async announceFilm(card: CinemaCard): Promise<void> {
    if (!this.nostr) throw new Error('[SwarmCoordinator] Not initialized.');

    await this.nostr.publishFilmAnnouncement({
      title:      card.movieTitle,
      identifier: card.tmdbId,
      archiveUrl: card.trailerUrl,
      posterUrl:  card.posterWebpUrl,
      year:       card.releaseYear,
      genres:     card.genres,
    });

    // Register ourselves as a seeder.
    const existing = this.seedRecords.get(card.tmdbId) ?? {
      identifier:  card.tmdbId,
      seeders:     [],
      resolvedUrl: null,
      lastUpdated: Date.now(),
    };
    const myPubkey = this.options.identity.nostr.npubHex;
    if (!existing.seeders.includes(myPubkey)) {
      existing.seeders.push(myPubkey);
    }
    this.seedRecords.set(card.tmdbId, existing);
  }

  // ---------------------------------------------------------------------------
  // Peer registry
  // ---------------------------------------------------------------------------

  private upsertPeer(pubkeyHex: string, seeding?: string): void {
    const existing = this.peers.get(pubkeyHex);
    if (existing) {
      existing.lastSeenAt = Date.now();
      if (seeding && !existing.seeding.includes(seeding)) {
        existing.seeding.push(seeding);
      }
    } else {
      const conn = this.pcManager?.getAllConnections()
        .find((c) => c.remotePubkeyHex === pubkeyHex);

      this.peers.set(pubkeyHex, {
        pubkeyHex,
        seeding:         seeding ? [seeding] : [],
        connectionId:    conn?.id ?? null,
        connectionState: conn?.state ?? 'idle',
        addedAt:         Date.now(),
        lastSeenAt:      Date.now(),
      });
    }
  }

  getPeerInfo(pubkeyHex: string): SwarmPeerInfo | null {
    return this.peers.get(pubkeyHex) ?? null;
  }

  getKnownSeeders(identifier: string): string[] {
    return this.seedRecords.get(identifier)?.seeders ?? [];
  }

  // ---------------------------------------------------------------------------
  // State management
  // ---------------------------------------------------------------------------

  private setState(state: SwarmState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private refreshDerivedState(): void {
    if (this.destroyed) return;

    const relayStatus   = this.nostr?.getRelayStatus() ?? [];
    const connectedCount = relayStatus.filter((r) => r.state === 'connected').length;
    const peerCount     = this.pcManager?.getConnectionCount() ?? 0;

    if (connectedCount === 0) {
      this.setState('offline');
    } else if (peerCount === 0) {
      this.setState('degraded');
    } else {
      this.setState('ready');
    }
  }

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  getMetrics(): SwarmMetrics {
    const relayStatus     = this.nostr?.getRelayStatus() ?? [];
    const connectedRelays = relayStatus.filter((r) => r.state === 'connected').length;

    return {
      state:             this.state,
      connectedRelays,
      knownPeers:        this.peers.size,
      activeConnections: this.pcManager?.getConnectionCount() ?? 0,
      seedRecords:       this.seedRecords.size,
      localPubkeyHex:    this.options.identity.nostr.npubHex,
    };
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  destroy(): void {
    this.destroyed = true;

    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }

    for (const pending of this.watchRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('SwarmCoordinator destroyed.'));
    }
    this.watchRequests.clear();

    this.filmFeedSub?.close();
    this.dmSub?.close();
    this.filmFeedSub = null;
    this.dmSub       = null;

    this.setState('idle');
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _swarmInstance: SwarmCoordinator | null = null;

export function getSwarmCoordinator(
  options?: SwarmCoordinatorOptions
): SwarmCoordinator {
  if (
    _swarmInstance &&
    !(_swarmInstance as unknown as { destroyed: boolean }).destroyed
  ) {
    return _swarmInstance;
  }

  if (!options) {
    throw new Error(
      '[SwarmCoordinator] Options required for first initialization.'
    );
  }

  _swarmInstance = new SwarmCoordinator(options);
  return _swarmInstance;
}

export function destroySwarmCoordinator(): void {
  _swarmInstance?.destroy();
  _swarmInstance = null;
}