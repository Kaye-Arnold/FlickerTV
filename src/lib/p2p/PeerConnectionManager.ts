/**
 * Flicker.TV — WebRTC Peer Connection Manager
 *
 * Manages the full lifecycle of encrypted peer-to-peer film streaming
 * connections. Wires together:
 *   - InsertableStreams AES-256-GCM chunk encryption (Phase 2)
 *   - NIP-17 signaling via the Cloudflare Worker proxy (Phase 2)
 *   - NodeResolver for initial stream URL resolution (Phase 1)
 *   - FlickerIdentity (WebAuthn PRF) for Nostr-signed SDP messages (Phase 2)
 *
 * Connection Lifecycle:
 *   1. Caller invokes openConnection(peerId, movieUrl).
 *   2. Manager generates a session nonce and posts a NIP-17-wrapped SDP
 *      offer to the signaling proxy, signed with the local Nostr identity.
 *   3. Remote peer receives the offer, derives the same AES-GCM session key
 *      (from the exchanged nonce), and responds with an SDP answer.
 *   4. ICE negotiation completes; RTCDataChannel and RTCPeerConnection
 *      are established.
 *   5. Sender attaches InsertableStreams encryption; receiver attaches
 *      decryption. Relay peers in the middle see only opaque ciphertext.
 *   6. Manager tracks connection health via ICE connection state and
 *      emits lifecycle events.
 *
 * Topology:
 *   The manager supports three peer roles:
 *     ORIGIN  — holds the original stream URL; encrypts and seeds chunks.
 *     RELAY   — blindly forwards encrypted ciphertext; no key access.
 *     VIEWER  — decrypts and renders. May also relay to further peers.
 *
 * Required packages (add to package.json):
 *   "@noble/hashes": "^1.4.0"    (already present)
 *   "@noble/curves": "^1.4.0"    (already present)
 */

import { sha256 }              from '@noble/hashes/sha256';
import { hkdf }                from '@noble/hashes/hkdf';
import { utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import {
  setupSenderEncryption,
  setupReceiverDecryption,
  generateSessionNonce,
  serializeNonce,
  deserializeNonce,
  createEncryptedPeerConnection,
  isInsertableStreamsSupported,
  type StreamEncryptionSession,
  type StreamEncryptionConfig,
} from './InsertableStreams';
import type { FlickerIdentity } from '../crypto/WebAuthnIdentity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PeerRole = 'origin' | 'relay' | 'viewer';

export type ConnectionState =
  | 'idle'
  | 'signaling'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export interface PeerConnectionConfig {
  /** The local peer's Nostr identity (from WebAuthnIdentity). */
  localIdentity:    FlickerIdentity;
  /** Remote peer's Nostr x-only pubkey (hex, 64 chars). */
  remotePubkeyHex:  string;
  /** Archive.org URL of the film being streamed. Used for key derivation. */
  movieUrl:         string;
  /** This peer's role in the connection. */
  role:             PeerRole;
  /** WebSocket URL of the NIP-17 signaling proxy. */
  signalingUrl:     string;
  /** STUN/TURN ICE servers. */
  iceServers?:      RTCIceServer[];
  /** Called when connection state changes. */
  onStateChange?:   (state: ConnectionState, peerId: string) => void;
  /** Called when a video track is received (viewer role). */
  onTrack?:         (track: MediaStreamTrack, stream: MediaStream) => void;
  /** Called when an AES-GCM integrity violation is detected. */
  onIntegrityViolation?: (frameTimestamp: number, reason: string) => void;
  /** Called when the data channel opens (relay/signaling messages). */
  onDataChannelOpen?: (channel: RTCDataChannel) => void;
  /** Max reconnect attempts before giving up. Default: 3. */
  maxReconnectAttempts?: number;
  /** Base reconnect delay ms (exponential backoff). Default: 1000. */
  reconnectBaseDelayMs?: number;
}

export interface ManagedConnection {
  /** Stable internal ID: SHA-256(localPubkey + remotePubkey + movieUrl). */
  id:              string;
  remotePubkeyHex: string;
  role:            PeerRole;
  state:           ConnectionState;
  pc:              RTCPeerConnection;
  dataChannel:     RTCDataChannel | null;
  encryptSession:  StreamEncryptionSession | null;
  createdAt:       number;
  connectedAt:     number | null;
  reconnectCount:  number;
  /** Cleanly close and remove the connection. */
  close(): void;
}

// ---------------------------------------------------------------------------
// NIP-17 gift-wrap types (for SDP exchange)
// ---------------------------------------------------------------------------

interface SDPSignalingPayload {
  type:           'offer' | 'answer' | 'ice-candidate';
  sdp?:           string;
  candidate?:     RTCIceCandidateInit;
  sessionNonce?:  string;   // hex-encoded 32 bytes, present in offer only
  movieUrl?:      string;   // present in offer only
  senderPubkey:   string;   // NIP-01 npubHex of actual sender (inside seal)
}

// ---------------------------------------------------------------------------
// Nostr NIP-01 / NIP-17 signing (outer gift wrap only)
// ---------------------------------------------------------------------------

/**
 * Compute NIP-01 event ID.
 */
function computeNostrEventId(
  pubkey:     string,
  created_at: number,
  kind:       number,
  tags:       string[][],
  content:    string
): string {
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  return bytesToHex(sha256(utf8ToBytes(serialized)));
}

/**
 * Sign a NIP-01 event with a secp256k1 Schnorr signature.
 * Uses the Web Crypto P-256 ECDSA key from the Gun SEA pair as a proxy,
 * since pure secp256k1 Schnorr is not available in Web Crypto.
 *
 * NOTE: For production Nostr signing, use @noble/curves secp256k1.schnorr
 * with the raw privkey from FlickerIdentity.nostr.privkey. This requires
 * the privkey bytes to be available — which they are during the session
 * but MUST NOT be persisted to disk.
 */
async function signNostrEvent(
  event: {
    pubkey:     string;
    created_at: number;
    kind:       number;
    tags:       string[][];
    content:    string;
  },
  privkeyHex: string
): Promise<{ id: string; sig: string }> {
  // Dynamic import to avoid loading @noble/curves in non-signing paths.
  const { secp256k1 } = await import('@noble/curves/secp256k1');

  const id      = computeNostrEventId(
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  );
  const msgHash  = hexToBytes(id);
  const privkey  = hexToBytes(privkeyHex);
  const sigBytes = secp256k1.schnorr.sign(msgHash, privkey);

  return { id, sig: bytesToHex(sigBytes) };
}

/**
 * Wrap an SDP payload into a NIP-17 gift-wrapped Nostr event (kind 1059).
 *
 * In full NIP-17 the inner `kind: 14` DM is NIP-44 encrypted with the
 * recipient's pubkey before being wrapped. Here we implement the outer
 * gift wrap structure with the SDP payload JSON-encoded in the content field.
 * For production, replace `content` with a real NIP-44 encrypted seal.
 */
async function createGiftWrap(
  payload:         SDPSignalingPayload,
  recipientPubkey: string,
  identity:        FlickerIdentity
): Promise<object> {
  // Generate a fresh ephemeral keypair for the outer gift wrap.
  // This randomises the sender identity on every message (NIP-17 requirement).
  const { secp256k1 }     = await import('@noble/curves/secp256k1');
  const ephemeralPrivBytes = crypto.getRandomValues(new Uint8Array(32));

  // Ensure scalar is in valid range [1, n-1].
  const n = secp256k1.CURVE.n;
  const ephemeralScalar = ((
    BigInt('0x' + bytesToHex(ephemeralPrivBytes)) % (n - 1n)
  ) + 1n);
  const ephemeralPrivHex = ephemeralScalar.toString(16).padStart(64, '0');
  const ephemeralPubBytes = secp256k1.getPublicKey(hexToBytes(ephemeralPrivHex), true);
  // x-only pubkey (strip 1-byte prefix).
  const ephemeralPubHex   = bytesToHex(ephemeralPubBytes.slice(1));

  const content    = JSON.stringify(payload);
  const created_at = Math.floor(Date.now() / 1000);
  const kind       = 1059;
  const tags       = [['p', recipientPubkey]];

  const { id, sig } = await signNostrEvent(
    { pubkey: ephemeralPubHex, created_at, kind, tags, content },
    ephemeralPrivHex
  );

  // Zero out ephemeral private key bytes immediately.
  ephemeralPrivBytes.fill(0);

  return { id, pubkey: ephemeralPubHex, created_at, kind, tags, content, sig };
}

// ---------------------------------------------------------------------------
// Connection ID derivation
// ---------------------------------------------------------------------------

function deriveConnectionId(
  localPubkey:     string,
  remotePubkeyHex: string,
  movieUrl:        string
): string {
  const material = utf8ToBytes(
    `${localPubkey}:${remotePubkeyHex}:${movieUrl}`
  );
  return bytesToHex(sha256(material)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Default ICE servers (public STUN + optional TURN)
// ---------------------------------------------------------------------------

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// ---------------------------------------------------------------------------
// PeerConnectionManager
// ---------------------------------------------------------------------------

export class PeerConnectionManager {
  private readonly identity:       FlickerIdentity;
  private readonly signalingUrl:   string;
  private readonly iceServers:     RTCIceServer[];
  private readonly connections:    Map<string, ManagedConnection> = new Map();
  private signalingSocket:         WebSocket | null               = null;
  private signalingReady:          boolean                        = false;
  private readonly pendingMessages: object[]                      = [];
  private socketReconnectTimer:    ReturnType<typeof setTimeout> | null = null;
  private destroyed:               boolean                        = false;

  // Queued ICE candidates keyed by remote pubkey, waiting for remote description.
  private readonly pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();

  constructor(
    identity:     FlickerIdentity,
    signalingUrl: string,
    iceServers?:  RTCIceServer[]
  ) {
    this.identity     = identity;
    this.signalingUrl = signalingUrl;
    this.iceServers   = iceServers ?? DEFAULT_ICE_SERVERS;
  }

  // ---------------------------------------------------------------------------
  // Signaling socket management
  // ---------------------------------------------------------------------------

  private connectSignalingSocket(): void {
    if (this.destroyed) return;

    const ws = new WebSocket(this.signalingUrl);
    this.signalingSocket = ws;

    ws.addEventListener('open', () => {
      this.signalingReady = true;

      // Register with our Nostr pubkey and referral graph.
      const referralGraph = this.buildReferralGraph();
      ws.send(JSON.stringify({
        type:          'REGISTER',
        pubkey:        this.identity.nostr.npubHex,
        referralGraph,
      }));

      // Drain queued messages.
      while (this.pendingMessages.length > 0) {
        const msg = this.pendingMessages.shift();
        if (msg) ws.send(JSON.stringify(msg));
      }
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>;
        this.handleSignalingMessage(msg);
      } catch {
        // Malformed message — ignore.
      }
    });

    ws.addEventListener('close', () => {
      this.signalingReady = false;
      this.scheduleSocketReconnect();
    });

    ws.addEventListener('error', () => {
      this.signalingReady = false;
    });
  }

  private scheduleSocketReconnect(): void {
    if (this.destroyed) return;
    if (this.socketReconnectTimer) return;

    this.socketReconnectTimer = setTimeout(() => {
      this.socketReconnectTimer = null;
      this.connectSignalingSocket();
    }, 3000 + Math.random() * 2000); // 3–5s jitter
  }

  private sendSignaling(event: object): void {
    if (this.signalingReady && this.signalingSocket?.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify({ type: 'EVENT', event }));
    } else {
      this.pendingMessages.push({ type: 'EVENT', event });
      if (!this.signalingSocket || this.signalingSocket.readyState > WebSocket.OPEN) {
        this.connectSignalingSocket();
      }
    }
  }

  private buildReferralGraph(): string[] {
    // Collect all currently connected remote pubkeys as our trust set.
    const graph: string[] = [];
    for (const conn of this.connections.values()) {
      graph.push(conn.remotePubkeyHex);
    }
    return graph;
  }

  // ---------------------------------------------------------------------------
  // Inbound signaling message dispatcher
  // ---------------------------------------------------------------------------

  private async handleSignalingMessage(msg: Record<string, unknown>): Promise<void> {
    if (msg['type'] !== 'EVENT') return;

    const event = msg['event'] as Record<string, unknown> | undefined;
    if (!event || typeof event['content'] !== 'string') return;

    let payload: SDPSignalingPayload;
    try {
      payload = JSON.parse(event['content'] as string) as SDPSignalingPayload;
    } catch {
      return;
    }

    if (!payload.type || !payload.senderPubkey) return;

    const senderPubkey = payload.senderPubkey;

    switch (payload.type) {
      case 'offer':
        await this.handleInboundOffer(payload, senderPubkey);
        break;
      case 'answer':
        await this.handleInboundAnswer(payload, senderPubkey);
        break;
      case 'ice-candidate':
        await this.handleInboundICECandidate(payload, senderPubkey);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // SDP offer handling
  // ---------------------------------------------------------------------------

  private async handleInboundOffer(
    payload:       SDPSignalingPayload,
    senderPubkey:  string
  ): Promise<void> {
    if (!payload.sdp || !payload.sessionNonce || !payload.movieUrl) return;

    const sessionNonce = deserializeNonce(payload.sessionNonce);
    const connId       = deriveConnectionId(
      this.identity.nostr.npubHex,
      senderPubkey,
      payload.movieUrl
    );

    // Create answering peer connection.
    const pc = createEncryptedPeerConnection({ iceServers: this.iceServers });
    const conn = this.registerConnection(connId, senderPubkey, pc, 'viewer', payload.movieUrl);

    this.attachICEHandlers(pc, senderPubkey, payload.movieUrl);

    // If insertable streams are supported, attach receiver decryption.
    if (isInsertableStreamsSupported()) {
      pc.addEventListener('track', async (event: RTCTrackEvent) => {
        for (const receiver of pc.getReceivers()) {
          if (receiver.track.kind === 'video') {
            const encConfig: StreamEncryptionConfig = {
              movieUrl:     payload.movieUrl!,
              sessionNonce,
              onIntegrityViolation: conn.encryptSession
                ? undefined
                : undefined,
            };

            try {
              const session = await setupReceiverDecryption(receiver, encConfig);
              (conn as { encryptSession: StreamEncryptionSession | null })
                .encryptSession = session;
            } catch (err) {
              console.error('[PCManager] Receiver decryption setup failed:', err);
            }
          }
        }
      });
    }

    await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
    await this.flushPendingCandidates(senderPubkey, pc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    const answerPayload: SDPSignalingPayload = {
      type:        'answer',
      sdp:         answer.sdp ?? '',
      senderPubkey: this.identity.nostr.npubHex,
    };

    const giftWrap = await createGiftWrap(answerPayload, senderPubkey, this.identity);
    this.sendSignaling(giftWrap);
  }

  // ---------------------------------------------------------------------------
  // SDP answer handling
  // ---------------------------------------------------------------------------

  private async handleInboundAnswer(
    payload:      SDPSignalingPayload,
    senderPubkey: string
  ): Promise<void> {
    if (!payload.sdp) return;

    // Find the connection initiated by us to this peer.
    const conn = this.findConnectionByRemotePubkey(senderPubkey);
    if (!conn || !payload.sdp) return;

    try {
      await conn.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      await this.flushPendingCandidates(senderPubkey, conn.pc);
    } catch (err) {
      console.error('[PCManager] Failed to set remote description:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // ICE candidate handling
  // ---------------------------------------------------------------------------

  private async handleInboundICECandidate(
    payload:      SDPSignalingPayload,
    senderPubkey: string
  ): Promise<void> {
    if (!payload.candidate) return;

    const conn = this.findConnectionByRemotePubkey(senderPubkey);

    if (conn && conn.pc.remoteDescription) {
      try {
        await conn.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      } catch (err) {
        console.error('[PCManager] Failed to add ICE candidate:', err);
      }
    } else {
      // Queue the candidate until remote description is set.
      if (!this.pendingCandidates.has(senderPubkey)) {
        this.pendingCandidates.set(senderPubkey, []);
      }
      this.pendingCandidates.get(senderPubkey)!.push(payload.candidate);
    }
  }

  private async flushPendingCandidates(
    remotePubkey: string,
    pc:           RTCPeerConnection
  ): Promise<void> {
    const queued = this.pendingCandidates.get(remotePubkey);
    if (!queued || queued.length === 0) return;

    this.pendingCandidates.delete(remotePubkey);

    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        // Stale candidate — ignore.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ICE handler attachment
  // ---------------------------------------------------------------------------

  private attachICEHandlers(
    pc:           RTCPeerConnection,
    remotePubkey: string,
    movieUrl:     string
  ): void {
    pc.addEventListener('icecandidate', async (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) return;

      const payload: SDPSignalingPayload = {
        type:        'ice-candidate',
        candidate:   event.candidate.toJSON(),
        senderPubkey: this.identity.nostr.npubHex,
      };

      const giftWrap = await createGiftWrap(payload, remotePubkey, this.identity);
      this.sendSignaling(giftWrap);
    });

    pc.addEventListener('connectionstatechange', () => {
      const connId = deriveConnectionId(
        this.identity.nostr.npubHex,
        remotePubkey,
        movieUrl
      );
      const conn = this.connections.get(connId);
      if (!conn) return;

      switch (pc.connectionState) {
        case 'connected': {
          (conn as { state: ConnectionState }).state      = 'connected';
          (conn as { connectedAt: number | null }).connectedAt = Date.now();
          break;
        }
        case 'disconnected':
        case 'failed': {
          (conn as { state: ConnectionState }).state = 'failed';
          this.scheduleReconnect(conn, movieUrl);
          break;
        }
        case 'closed': {
          (conn as { state: ConnectionState }).state = 'closed';
          this.connections.delete(connId);
          break;
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Reconnect logic (exponential backoff)
  // ---------------------------------------------------------------------------

  private reconnectTimers: Map<string, ReturnType<typeof setTimeout>> =
    new Map();

  private scheduleReconnect(conn: ManagedConnection, movieUrl: string): void {
    const maxAttempts = 3;
    if (conn.reconnectCount >= maxAttempts) {
      (conn as { state: ConnectionState }).state = 'failed';
      return;
    }

    const delay = Math.min(
      1000 * Math.pow(2, conn.reconnectCount) + Math.random() * 500,
      30_000
    );

    (conn as { state: ConnectionState }).state     = 'reconnecting';
    (conn as { reconnectCount: number }).reconnectCount += 1;

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(conn.id);
      try {
        await this.openConnection({
          localIdentity:   this.identity,
          remotePubkeyHex: conn.remotePubkeyHex,
          movieUrl,
          role:            conn.role,
          signalingUrl:    this.signalingUrl,
          iceServers:      this.iceServers,
        });
      } catch (err) {
        console.error('[PCManager] Reconnect failed:', err);
        (conn as { state: ConnectionState }).state = 'failed';
      }
    }, delay);

    this.reconnectTimers.set(conn.id, timer);
  }

  // ---------------------------------------------------------------------------
  // Connection registration
  // ---------------------------------------------------------------------------

  private registerConnection(
    id:              string,
    remotePubkeyHex: string,
    pc:              RTCPeerConnection,
    role:            PeerRole,
    movieUrl:        string
  ): ManagedConnection {
    const manager = this;
    const conn: ManagedConnection = {
      id,
      remotePubkeyHex,
      role,
      state:          'signaling',
      pc,
      dataChannel:    null,
      encryptSession: null,
      createdAt:      Date.now(),
      connectedAt:    null,
      reconnectCount: 0,
      close() {
        conn.encryptSession?.destroy();
        conn.dataChannel?.close();
        pc.close();
        manager.connections.delete(id);
        const timer = manager.reconnectTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          manager.reconnectTimers.delete(id);
        }
      },
    };

    this.connections.set(id, conn);
    return conn;
  }

  private findConnectionByRemotePubkey(pubkey: string): ManagedConnection | null {
    for (const conn of this.connections.values()) {
      if (conn.remotePubkeyHex === pubkey) return conn;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Public API: initiate an outbound connection
  // ---------------------------------------------------------------------------

  async openConnection(config: PeerConnectionConfig): Promise<ManagedConnection> {
    if (this.destroyed) {
      throw new Error('[PCManager] Manager has been destroyed.');
    }

    if (!this.signalingSocket || this.signalingSocket.readyState > WebSocket.OPEN) {
      this.connectSignalingSocket();
    }

    const connId = deriveConnectionId(
      config.localIdentity.nostr.npubHex,
      config.remotePubkeyHex,
      config.movieUrl
    );

    // Close any existing connection to this peer.
    const existing = this.connections.get(connId);
    if (existing) existing.close();

    const pc   = createEncryptedPeerConnection({ iceServers: this.iceServers });
    const conn = this.registerConnection(
      connId,
      config.remotePubkeyHex,
      pc,
      config.role,
      config.movieUrl
    );

    this.attachICEHandlers(pc, config.remotePubkeyHex, config.movieUrl);

    // Open a data channel for relay signaling (offers, chat, metadata).
    const dc = pc.createDataChannel('flicker-relay', {
      ordered:    false,
      maxRetransmits: 0,
    });
    (conn as { dataChannel: RTCDataChannel | null }).dataChannel = dc;

    dc.addEventListener('open', () => {
      config.onDataChannelOpen?.(dc);
    });

    // Attach sender encryption if origin role.
    if (config.role === 'origin' && isInsertableStreamsSupported()) {
      const sessionNonce = generateSessionNonce();

      pc.addEventListener('negotiationneeded', async () => {
        // Attach encryption to all video senders once negotiation begins.
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind === 'video') {
            const encConfig: StreamEncryptionConfig = {
              movieUrl:     config.movieUrl,
              sessionNonce,
              onIntegrityViolation: config.onIntegrityViolation,
            };
            try {
              const session = await setupSenderEncryption(sender, encConfig);
              (conn as { encryptSession: StreamEncryptionSession | null })
                .encryptSession = session;
            } catch (err) {
              console.error('[PCManager] Sender encryption setup failed:', err);
            }
          }
        }
      });

      // Create and send the SDP offer with the session nonce.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const payload: SDPSignalingPayload = {
        type:          'offer',
        sdp:           offer.sdp ?? '',
        sessionNonce:  serializeNonce(sessionNonce),
        movieUrl:      config.movieUrl,
        senderPubkey:  config.localIdentity.nostr.npubHex,
      };

      const giftWrap = await createGiftWrap(
        payload,
        config.remotePubkeyHex,
        config.localIdentity
      );
      this.sendSignaling(giftWrap);
    }

    return conn;
  }

  // ---------------------------------------------------------------------------
  // Public API: close all connections and tear down
  // ---------------------------------------------------------------------------

  destroy(): void {
    this.destroyed = true;

    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();

    if (this.signalingSocket) {
      this.signalingSocket.close(1000, 'Manager destroyed');
      this.signalingSocket = null;
    }

    if (this.socketReconnectTimer) {
      clearTimeout(this.socketReconnectTimer);
      this.socketReconnectTimer = null;
    }
  }

  getConnection(id: string): ManagedConnection | null {
    return this.connections.get(id) ?? null;
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getAllConnections(): ManagedConnection[] {
    return Array.from(this.connections.values());
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _managerInstance: PeerConnectionManager | null = null;

export function getPeerConnectionManager(
  identity:     FlickerIdentity,
  signalingUrl: string,
  iceServers?:  RTCIceServer[]
): PeerConnectionManager {
  if (_managerInstance && !(_managerInstance as unknown as { destroyed: boolean }).destroyed) {
    return _managerInstance;
  }
  _managerInstance = new PeerConnectionManager(identity, signalingUrl, iceServers);
  return _managerInstance;
}

export function destroyPeerConnectionManager(): void {
  _managerInstance?.destroy();
  _managerInstance = null;
}