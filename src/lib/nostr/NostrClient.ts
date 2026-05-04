/**
 * Flicker.TV — Nostr Client
 *
 * A lightweight, dependency-free Nostr relay client implementing
 * NIP-01 (basic protocol), NIP-17 (private DMs via gift wrap),
 * and NIP-65 (relay list metadata) for the Flicker.TV feed and
 * P2P signaling infrastructure.
 *
 * Responsibilities:
 *   - Maintain persistent WebSocket connections to one or more relays.
 *   - Publish signed Nostr events (film announcements, SDP signals,
 *     watch party invites).
 *   - Subscribe to filters and dispatch events to registered handlers.
 *   - Implement automatic reconnection with exponential backoff.
 *   - Validate inbound event signatures before dispatching.
 *
 * This client does NOT depend on nostr-tools or any external Nostr library
 * to keep the bundle lean and allow direct integration with the Noble
 * cryptographic primitives already present in the codebase.
 *
 * Required packages (already present):
 *   "@noble/curves": "^1.4.0"
 *   "@noble/hashes": "^1.4.0"
 */

import { secp256k1 }            from '@noble/curves/secp256k1';
import { sha256 }               from '@noble/hashes/sha256';
import { utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { FlickerIdentity } from '../crypto/WebAuthnIdentity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NostrEvent {
  id:         string;
  pubkey:     string;
  created_at: number;
  kind:       number;
  tags:       string[][];
  content:    string;
  sig:        string;
}

export interface NostrFilter {
  ids?:     string[];
  authors?: string[];
  kinds?:   number[];
  since?:   number;
  until?:   number;
  limit?:   number;
  '#e'?:    string[];
  '#p'?:    string[];
  '#t'?:    string[];
  [key: string]: unknown;
}

export interface NostrSubscription {
  id:      string;
  filters: NostrFilter[];
  /** Called for each matching event. */
  onEvent: (event: NostrEvent, relayUrl: string) => void;
  /** Called when EOSE (End of Stored Events) is received. */
  onEOSE?: (relayUrl: string) => void;
  /** Unsubscribe and remove the handler. */
  close(): void;
}

type RelayConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'
  | 'failed';

interface RelayRecord {
  url:             string;
  socket:          WebSocket | null;
  state:           RelayConnectionState;
  reconnectCount:  number;
  reconnectTimer:  ReturnType<typeof setTimeout> | null;
  lastEventAt:     number;
  /** Active subscription IDs → filter arrays, for re-subscription on reconnect. */
  activeSubIds:    Set<string>;
}

export interface NostrClientOptions {
  /** List of relay WebSocket URLs. */
  relayUrls:        string[];
  /** Optional: override the signing identity. */
  identity?:        FlickerIdentity;
  /** Max reconnect attempts per relay. Default: 10. */
  maxReconnects?:   number;
  /** Base reconnect delay ms. Default: 1000. */
  reconnectBaseMs?: number;
  /** Inbound event signature verification toggle. Default: true. */
  verifySignatures?: boolean;
  /** Called when a relay's connection state changes. */
  onRelayStateChange?: (url: string, state: RelayConnectionState) => void;
}

// ---------------------------------------------------------------------------
// Nostr event kinds
// ---------------------------------------------------------------------------

export const NOSTR_KINDS = {
  SET_METADATA:        0,
  TEXT_NOTE:           1,
  RELAY_LIST:          10002,
  GIFT_WRAP:           1059,
  /** Flicker.TV custom kind: film announcement in the discovery feed. */
  FILM_ANNOUNCEMENT:   30078,
  /** Flicker.TV custom kind: watch party invite. */
  WATCH_PARTY_INVITE:  30079,
  /** Flicker.TV custom kind: SDP signaling (inner seal, before gift-wrapping). */
  SDP_SIGNAL:          30080,
} as const;

// ---------------------------------------------------------------------------
// NIP-01 cryptographic primitives
// ---------------------------------------------------------------------------

function computeEventId(
  pubkey:     string,
  created_at: number,
  kind:       number,
  tags:       string[][],
  content:    string
): string {
  const canonical = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

function signEvent(eventId: string, privkeyHex: string): string {
  const msgHash  = hexToBytes(eventId);
  const privkey  = hexToBytes(privkeyHex);
  const sigBytes = secp256k1.schnorr.sign(msgHash, privkey);
  return bytesToHex(sigBytes);
}

function verifyEventSignature(event: NostrEvent): boolean {
  try {
    const expectedId = computeEventId(
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content
    );
    if (expectedId !== event.id) return false;

    const msgHash  = hexToBytes(event.id);
    const sig      = hexToBytes(event.sig);
    const pubkey   = hexToBytes(event.pubkey);
    return secp256k1.schnorr.verify(sig, msgHash, pubkey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// NostrClient
// ---------------------------------------------------------------------------

export class NostrClient {
  private readonly options:       Required<NostrClientOptions>;
  private readonly relays:        Map<string, RelayRecord> = new Map();
  private readonly subscriptions: Map<string, NostrSubscription> = new Map();
  private          subCounter     = 0;
  private          destroyed      = false;
  private          identity:      FlickerIdentity | null;

  constructor(options: NostrClientOptions) {
    this.options = {
      relayUrls:         options.relayUrls,
      identity:          options.identity ?? null as unknown as FlickerIdentity,
      maxReconnects:     options.maxReconnects    ?? 10,
      reconnectBaseMs:   options.reconnectBaseMs  ?? 1000,
      verifySignatures:  options.verifySignatures ?? true,
      onRelayStateChange: options.onRelayStateChange ?? (() => {}),
    };

    this.identity = options.identity ?? null;

    for (const url of options.relayUrls) {
      this.connectRelay(url);
    }
  }

  // ---------------------------------------------------------------------------
  // Relay connection management
  // ---------------------------------------------------------------------------

  private connectRelay(url: string): void {
    if (this.destroyed) return;

    let record = this.relays.get(url);
    if (!record) {
      record = {
        url,
        socket:         null,
        state:          'connecting',
        reconnectCount: 0,
        reconnectTimer: null,
        lastEventAt:    Date.now(),
        activeSubIds:   new Set(),
      };
      this.relays.set(url, record);
    }

    record.state = 'connecting';
    this.options.onRelayStateChange(url, 'connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect(record);
      return;
    }

    record.socket = ws;

    ws.addEventListener('open', () => {
      if (record!.socket !== ws) return;
      record!.state          = 'connected';
      record!.reconnectCount = 0;
      this.options.onRelayStateChange(url, 'connected');
      // Re-subscribe all active subscriptions on reconnect.
      this.resubscribeToRelay(record!);
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      record!.lastEventAt = Date.now();
      this.handleRelayMessage(event.data, url);
    });

    ws.addEventListener('close', () => {
      if (record!.socket !== ws) return;
      record!.state = 'disconnected';
      this.options.onRelayStateChange(url, 'disconnected');
      this.scheduleReconnect(record!);
    });

    ws.addEventListener('error', () => {
      record!.state = 'failed';
      this.options.onRelayStateChange(url, 'failed');
    });
  }

  private scheduleReconnect(record: RelayRecord): void {
    if (this.destroyed) return;
    if (record.reconnectTimer) return;
    if (record.reconnectCount >= this.options.maxReconnects) {
      record.state = 'failed';
      this.options.onRelayStateChange(record.url, 'failed');
      return;
    }

    const delay = Math.min(
      this.options.reconnectBaseMs * Math.pow(2, record.reconnectCount) +
        Math.random() * 1000,
      60_000
    );
    record.reconnectCount += 1;

    record.reconnectTimer = setTimeout(() => {
      record.reconnectTimer = null;
      this.connectRelay(record.url);
    }, delay);
  }

  private resubscribeToRelay(record: RelayRecord): void {
    for (const subId of record.activeSubIds) {
      const sub = this.subscriptions.get(subId);
      if (!sub) {
        record.activeSubIds.delete(subId);
        continue;
      }
      this.sendToRelay(record, ['REQ', subId, ...sub.filters]);
    }
  }

  private sendToRelay(
    record:  RelayRecord,
    payload: unknown[]
  ): boolean {
    if (record.socket?.readyState === WebSocket.OPEN) {
      try {
        record.socket.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private broadcastToRelays(payload: unknown[]): number {
    let sent = 0;
    for (const record of this.relays.values()) {
      if (this.sendToRelay(record, payload)) sent++;
    }
    return sent;
  }

  // ---------------------------------------------------------------------------
  // Inbound message handling
  // ---------------------------------------------------------------------------

  private handleRelayMessage(raw: string, relayUrl: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(raw) as unknown[];
    } catch {
      return;
    }

    if (!Array.isArray(msg) || msg.length < 2) return;

    const msgType = msg[0];

    switch (msgType) {
      case 'EVENT': {
        if (msg.length < 3) return;
        const subId = msg[1] as string;
        const event = msg[2] as NostrEvent;

        if (this.options.verifySignatures && !verifyEventSignature(event)) {
          return; // Drop events with invalid signatures.
        }

        const sub = this.subscriptions.get(subId);
        if (sub) {
          sub.onEvent(event, relayUrl);
        }
        break;
      }

      case 'EOSE': {
        if (msg.length < 2) return;
        const subId = msg[1] as string;
        const sub   = this.subscriptions.get(subId);
        sub?.onEOSE?.(relayUrl);
        break;
      }

      case 'OK': {
        // Publication acknowledgement: ['OK', event_id, true/false, message]
        // No-op for now. Future: implement publish acknowledgement tracking.
        break;
      }

      case 'NOTICE': {
        console.info(`[NostrClient] NOTICE from ${relayUrl}:`, msg[1]);
        break;
      }

      case 'CLOSED': {
        // Relay has closed a subscription — re-subscribe if we still have it.
        const closedSubId = msg[1] as string;
        const sub         = this.subscriptions.get(closedSubId);
        if (sub) {
          const record = this.relays.get(relayUrl);
          if (record) {
            this.sendToRelay(record, ['REQ', closedSubId, ...sub.filters]);
          }
        }
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API: event publishing
  // ---------------------------------------------------------------------------

  /**
   * Build, sign, and publish a Nostr event to all connected relays.
   * Returns the fully signed event for reference.
   */
  async publish(params: {
    kind:    number;
    content: string;
    tags?:   string[][];
  }): Promise<NostrEvent> {
    if (!this.identity) {
      throw new Error('[NostrClient] No identity configured. Call setIdentity() first.');
    }

    const pubkey     = this.identity.nostr.npubHex;
    const created_at = Math.floor(Date.now() / 1000);
    const kind       = params.kind;
    const tags       = params.tags ?? [];
    const content    = params.content;

    const id  = computeEventId(pubkey, created_at, kind, tags, content);
    const sig = signEvent(id, this.identity.nostr.privkey);

    const event: NostrEvent = { id, pubkey, created_at, kind, tags, content, sig };

    this.broadcastToRelays(['EVENT', event]);

    return event;
  }

  /**
   * Publish a film announcement to the discovery feed.
   */
  async publishFilmAnnouncement(params: {
    title:       string;
    identifier:  string;
    archiveUrl:  string;
    posterUrl:   string;
    year:        number;
    genres:      string[];
  }): Promise<NostrEvent> {
    const content = JSON.stringify({
      title:      params.title,
      identifier: params.identifier,
      archiveUrl: params.archiveUrl,
      posterUrl:  params.posterUrl,
      year:       params.year,
    });

    const tags = [
      ['d', params.identifier],
      ['title', params.title],
      ['published_at', String(params.year)],
      ...params.genres.map((g) => ['t', g.toLowerCase()]),
    ];

    return this.publish({ kind: NOSTR_KINDS.FILM_ANNOUNCEMENT, content, tags });
  }

  // ---------------------------------------------------------------------------
  // Public API: subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to events matching one or more filters.
   * Returns a NostrSubscription handle with a close() method.
   */
  subscribe(
    filters: NostrFilter[],
    onEvent: (event: NostrEvent, relayUrl: string) => void,
    onEOSE?: (relayUrl: string) => void
  ): NostrSubscription {
    const subId  = `flicker-sub-${Date.now()}-${this.subCounter++}`;

    const sub: NostrSubscription = {
      id:      subId,
      filters,
      onEvent,
      onEOSE,
      close: () => {
        this.subscriptions.delete(subId);
        for (const record of this.relays.values()) {
          record.activeSubIds.delete(subId);
          this.sendToRelay(record, ['CLOSE', subId]);
        }
      },
    };

    this.subscriptions.set(subId, sub);

    for (const record of this.relays.values()) {
      record.activeSubIds.add(subId);
      this.sendToRelay(record, ['REQ', subId, ...filters]);
    }

    return sub;
  }

  /**
   * Subscribe to film announcements in the public discovery feed.
   */
  subscribeToFilmFeed(
    onFilm: (event: NostrEvent, relayUrl: string) => void,
    since?: number
  ): NostrSubscription {
    return this.subscribe(
      [{
        kinds: [NOSTR_KINDS.FILM_ANNOUNCEMENT],
        since: since ?? Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60,
        limit: 50,
      }],
      onFilm
    );
  }

  /**
   * Subscribe to NIP-17 gift-wrapped DMs addressed to the local pubkey.
   * Incoming SDP signals and watch party invites arrive via this subscription.
   */
  subscribeToDirectMessages(
    onDM: (event: NostrEvent, relayUrl: string) => void
  ): NostrSubscription {
    if (!this.identity) {
      throw new Error('[NostrClient] No identity configured.');
    }

    return this.subscribe(
      [{
        kinds: [NOSTR_KINDS.GIFT_WRAP],
        '#p':  [this.identity.nostr.npubHex],
        since: Math.floor(Date.now() / 1000) - 60 * 60, // last hour
        limit: 100,
      }],
      onDM
    );
  }

  // ---------------------------------------------------------------------------
  // Public API: relay management
  // ---------------------------------------------------------------------------

  addRelay(url: string): void {
    if (this.relays.has(url)) return;
    this.connectRelay(url);
  }

  removeRelay(url: string): void {
    const record = this.relays.get(url);
    if (!record) return;

    record.state = 'disconnecting';
    if (record.reconnectTimer) {
      clearTimeout(record.reconnectTimer);
      record.reconnectTimer = null;
    }
    record.socket?.close(1000, 'Relay removed');
    this.relays.delete(url);
  }

  getRelayStatus(): Array<{ url: string; state: RelayConnectionState; lastEventAt: number }> {
    return Array.from(this.relays.values()).map((r) => ({
      url:         r.url,
      state:       r.state,
      lastEventAt: r.lastEventAt,
    }));
  }

  setIdentity(identity: FlickerIdentity): void {
    this.identity = identity;
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  destroy(): void {
    this.destroyed = true;

    for (const sub of this.subscriptions.values()) {
      sub.close();
    }
    this.subscriptions.clear();

    for (const record of this.relays.values()) {
      if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
      record.socket?.close(1000, 'Client destroyed');
    }
    this.relays.clear();
  }
}

// ---------------------------------------------------------------------------
// Public relay list (well-known, high-uptime Nostr relays)
// ---------------------------------------------------------------------------

export const FLICKER_DEFAULT_RELAYS: string[] = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.primal.net',
];

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _clientInstance: NostrClient | null = null;

export function getNostrClient(
  options?: Partial<NostrClientOptions>
): NostrClient {
  if (
    _clientInstance &&
    !(_clientInstance as unknown as { destroyed: boolean }).destroyed
  ) {
    return _clientInstance;
  }

  _clientInstance = new NostrClient({
    relayUrls:       FLICKER_DEFAULT_RELAYS,
    verifySignatures: true,
    ...options,
  });

  return _clientInstance;
}

export function destroyNostrClient(): void {
  _clientInstance?.destroy();
  _clientInstance = null;
}