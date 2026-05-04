/**
 * Flicker.TV — NIP-17 WebRTC Signaling Proxy (Cloudflare Worker)
 *
 * Facilitates WebRTC SDP (Session Description Protocol) exchanges between
 * peers using Nostr NIP-17 Gift-Wrapped Direct Messages as the transport
 * layer. Enforces Friend-to-Friend (F2F) darknet isolation by validating
 * every inbound connection against the intended recipient's declared
 * referral graph.
 *
 * Protocol Overview:
 *
 *   1. Peer A connects via WebSocket.
 *   2. Peer A sends REGISTER message with:
 *        - Their Nostr pubkey (hex)
 *        - Their referral graph (array of trusted pubkeys)
 *   3. Peer A sends a NIP-17 gift-wrapped Nostr event (kind 1059)
 *      containing an encrypted SDP offer/answer/candidate.
 *   4. Worker validates:
 *        a. Event structure + Schnorr signature (NIP-01)
 *        b. Sender pubkey ∈ recipient's declared referral graph (F2F filter)
 *        c. Recipient is currently connected
 *   5. If all checks pass: forward the raw encrypted event to recipient.
 *      If any check fails: DROP silently (no error leakage to sender).
 *   6. Recipient decrypts the NIP-17 gift wrap locally using their Nostr
 *      privkey to extract the SDP payload.
 *
 * NIP-17 Gift Wrap Structure (what the worker sees — outer layer only):
 *   {
 *     kind: 1059,                           ← Gift wrap kind
 *     pubkey: "<ephemeral sender pubkey>",   ← Randomised per message
 *     tags: [["p", "<recipient pubkey>"]],   ← Routing target (plaintext)
 *     content: "<NIP-44 encrypted seal>",    ← Opaque to the worker
 *     sig: "<schnorr signature>",            ← Verifiable without decryption
 *     id: "<sha256 of serialized event>",
 *     created_at: <unix timestamp>,
 *   }
 *
 * The worker never decrypts the NIP-44 content. It only:
 *   - Verifies the outer Schnorr signature (NIP-01 event integrity)
 *   - Reads the plaintext `p` tag for routing
 *   - Enforces referral graph membership for the declared sender pubkey
 *
 * F2F Isolation:
 *   The referral graph is client-declared at REGISTER time. The worker
 *   enforces that message senders are members of the recipient's trust set.
 *   Senders outside the graph are silently dropped, preventing unknown peers
 *   from initiating connections. The graph is held in memory (per-isolate)
 *   and evicted when the WebSocket closes.
 *
 * Wrangler config (wrangler.toml):
 *   name = "flicker-signaling-proxy"
 *   main = "workers/signaling-proxy/index.ts"
 *   compatibility_date = "2024-09-01"
 *
 * Required npm packages (install in /workers/signaling-proxy/package.json):
 *   "@noble/curves": "^1.4.0"
 *   "@noble/hashes": "^1.4.0"
 */

import { secp256k1 }           from '@noble/curves/secp256k1';
import { sha256 }              from '@noble/hashes/sha256';
import { utf8ToBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// Environment bindings (declare in wrangler.toml)
// ---------------------------------------------------------------------------

export interface Env {
  /**
   * Optional: KV namespace for persisting referral graphs across isolate
   * restarts. If absent, referral graphs are in-memory only (ephemeral).
   */
  REFERRAL_GRAPH_KV?: KVNamespace;
  /**
   * Comma-separated list of allowed origin hostnames for CORS.
   * Default: any origin (suitable for development).
   */
  ALLOWED_ORIGINS?: string;
  /**
   * Maximum number of peers the worker will track simultaneously.
   * Excess connections are rejected with 503. Default: 500.
   */
  MAX_PEERS?: string;
}

// ---------------------------------------------------------------------------
// Nostr protocol types (NIP-01)
// ---------------------------------------------------------------------------

interface NostrEvent {
  id:         string;    // SHA-256 hex of the serialized event
  pubkey:     string;    // 32-byte hex public key of the event creator
  created_at: number;    // Unix timestamp (seconds)
  kind:       number;    // Event kind number
  tags:       string[][]; // Array of tag arrays
  content:    string;    // Arbitrary content string
  sig:        string;    // 64-byte hex Schnorr signature
}

interface NostrClientMessage {
  type: 'EVENT' | 'REQ' | 'CLOSE';
  subscriptionId?: string;
  event?: NostrEvent;
  filters?: object[];
}

// ---------------------------------------------------------------------------
// Flicker-specific protocol messages (sent over the same WebSocket)
// ---------------------------------------------------------------------------

interface RegisterMessage {
  type:          'REGISTER';
  pubkey:        string;    // Registering peer's Nostr pubkey (hex, 64 chars)
  referralGraph: string[];  // Pubkeys this peer will accept messages from
}

interface PingMessage {
  type: 'PING';
}

type InboundMessage = RegisterMessage | PingMessage | { type: 'EVENT'; event: NostrEvent };

// ---------------------------------------------------------------------------
// Peer registry (in-memory, per isolate)
// ---------------------------------------------------------------------------

interface PeerRecord {
  pubkey:        string;
  referralGraph: Set<string>;
  socket:        WebSocket;
  connectedAt:   number;
  lastMessageAt: number;
  messageCount:  number;
}

// Global peer map: pubkey (hex) → PeerRecord
const peers = new Map<string, PeerRecord>();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NIP17_GIFT_WRAP_KIND  = 1059;
const MAX_EVENT_AGE_SECONDS = 300;    // Events older than 5 min are dropped
const MAX_MESSAGE_RATE      = 60;     // Max messages per peer per minute
const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PEERS     = 500;

// ---------------------------------------------------------------------------
// NIP-01: Nostr event ID computation
// ---------------------------------------------------------------------------

/**
 * Compute the canonical NIP-01 event ID: SHA-256 of the JSON serialization.
 * [0, pubkey, created_at, kind, tags, content]
 */
function computeEventId(event: Omit<NostrEvent, 'id' | 'sig'>): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  const hash = sha256(utf8ToBytes(serialized));
  return bytesToHex(hash);
}

// ---------------------------------------------------------------------------
// NIP-01: Schnorr signature verification
// ---------------------------------------------------------------------------

/**
 * Verify a Nostr event's Schnorr signature using secp256k1.
 * NIP-01 uses BIP-340 Schnorr signatures over the event ID.
 *
 * The pubkey in NIP-01 is the 32-byte x-coordinate (x-only key).
 * secp256k1.schnorr.verify() accepts x-only pubkeys natively.
 */
function verifyNostrSignature(event: NostrEvent): boolean {
  try {
    const messageHash = hexToBytes(event.id);
    const signature   = hexToBytes(event.sig);
    const pubkeyBytes = hexToBytes(event.pubkey);

    if (messageHash.length !== 32)  return false;
    if (signature.length   !== 64)  return false;
    if (pubkeyBytes.length !== 32)  return false;

    return secp256k1.schnorr.verify(signature, messageHash, pubkeyBytes);
  } catch {
    return false;
  }
}

/**
 * Verify the event ID matches the recomputed hash of its fields.
 * This prevents ID spoofing independent of signature verification.
 */
function verifyEventId(event: NostrEvent): boolean {
  try {
    const expected = computeEventId({
      pubkey:     event.pubkey,
      created_at: event.created_at,
      kind:       event.kind,
      tags:       event.tags,
      content:    event.content,
    });
    return expected === event.id;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event validation
// ---------------------------------------------------------------------------

/**
 * Full NIP-01 event validation:
 *   1. Structural schema check
 *   2. Event ID recomputation
 *   3. Schnorr signature verification
 *   4. Timestamp staleness check
 */
function validateNostrEvent(event: unknown): event is NostrEvent {
  if (!event || typeof event !== 'object') return false;

  const e = event as Record<string, unknown>;

  if (typeof e['id']         !== 'string')  return false;
  if (typeof e['pubkey']     !== 'string')  return false;
  if (typeof e['created_at'] !== 'number')  return false;
  if (typeof e['kind']       !== 'number')  return false;
  if (!Array.isArray(e['tags']))            return false;
  if (typeof e['content']    !== 'string')  return false;
  if (typeof e['sig']        !== 'string')  return false;

  const nostrEvent = e as unknown as NostrEvent;

  // Check hex string lengths.
  if (nostrEvent.id.length     !== 64) return false;
  if (nostrEvent.pubkey.length !== 64) return false;
  if (nostrEvent.sig.length    !== 128) return false;

  // Staleness check — drop events older than MAX_EVENT_AGE_SECONDS.
  const ageSeconds = Math.floor(Date.now() / 1000) - nostrEvent.created_at;
  if (ageSeconds > MAX_EVENT_AGE_SECONDS || ageSeconds < -60) return false;

  // ID integrity.
  if (!verifyEventId(nostrEvent)) return false;

  // Signature integrity.
  if (!verifyNostrSignature(nostrEvent)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Hex validation helpers
// ---------------------------------------------------------------------------

function isHex64(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}

function normalizeHex(s: string): string {
  return s.toLowerCase();
}

// ---------------------------------------------------------------------------
// NIP-17 routing: extract recipient pubkey from gift wrap p-tag
// ---------------------------------------------------------------------------

/**
 * Extract the recipient pubkey from a NIP-17 gift wrap's p-tag.
 * Returns null if the event is not a valid gift wrap or has no p-tag.
 */
function extractGiftWrapRecipient(event: NostrEvent): string | null {
  if (event.kind !== NIP17_GIFT_WRAP_KIND) return null;

  for (const tag of event.tags) {
    if (Array.isArray(tag) && tag[0] === 'p' && isHex64(tag[1])) {
      return normalizeHex(tag[1] as string);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// F2F referral graph enforcement
// ---------------------------------------------------------------------------

/**
 * Validate that `senderPubkey` is in the recipient's declared referral graph.
 *
 * In NIP-17, the gift wrap's outer `pubkey` is an ephemeral key generated
 * per-message — it does NOT identify the actual sender. The real sender's
 * identity is inside the encrypted seal (the `kind: 13` event), which the
 * worker CANNOT read.
 *
 * For F2F enforcement we use the REGISTERED pubkey of the sending WebSocket
 * connection as the sender identity. This means:
 *   - Only registered peers can send.
 *   - The sending WebSocket's declared pubkey is what's checked against the
 *     recipient's referral graph.
 *   - The ephemeral pubkey in the gift wrap is ignored for routing purposes.
 *
 * This provides network-level F2F isolation (unknown IP/pubkey pairs cannot
 * deliver messages) even though it does not cryptographically bind the
 * registered pubkey to the gift wrap's inner content (that's the job of
 * end-to-end NIP-17 encryption between the peers themselves).
 */
function isInReferralGraph(
  recipientRecord: PeerRecord,
  senderPubkey:    string
): boolean {
  return (
    recipientRecord.referralGraph.has(normalizeHex(senderPubkey)) ||
    // Always allow self-messages (for echo testing and reconnect flows).
    recipientRecord.pubkey === normalizeHex(senderPubkey)
  );
}

// ---------------------------------------------------------------------------
// Rate limiting (simple per-peer token bucket)
// ---------------------------------------------------------------------------

function isRateLimited(peer: PeerRecord): boolean {
  const now          = Date.now();
  const windowStart  = now - 60_000; // 1-minute rolling window
  peer.lastMessageAt = now;
  peer.messageCount += 1;

  // Simple approximation: if the connection is younger than 1 minute,
  // scale the threshold proportionally.
  const connectionAge = Math.min(now - peer.connectedAt, 60_000);
  const scaledLimit   = Math.ceil((connectionAge / 60_000) * MAX_MESSAGE_RATE);

  if (peer.messageCount > Math.max(scaledLimit, 10)) {
    return true;
  }

  // Reset counter every minute.
  if (peer.connectedAt < windowStart) {
    peer.messageCount = 1;
    peer.connectedAt  = now;
  }

  return false;
}

// ---------------------------------------------------------------------------
// WebSocket message handlers
// ---------------------------------------------------------------------------

function sendToSocket(socket: WebSocket, payload: object): void {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  } catch {
    // Socket may have closed between check and send — ignore.
  }
}

function handleRegister(
  msg:        RegisterMessage,
  socket:     WebSocket,
  maxPeers:   number
): void {
  const pubkey = normalizeHex(msg.pubkey);

  if (!isHex64(pubkey)) {
    sendToSocket(socket, {
      type:    'ERROR',
      message: 'Invalid pubkey: must be 64-character lowercase hex.',
    });
    return;
  }

  if (peers.size >= maxPeers && !peers.has(pubkey)) {
    sendToSocket(socket, {
      type:    'ERROR',
      message: 'Signaling proxy at capacity. Retry later.',
    });
    return;
  }

  if (!Array.isArray(msg.referralGraph)) {
    sendToSocket(socket, {
      type:    'ERROR',
      message: 'referralGraph must be an array of hex pubkeys.',
    });
    return;
  }

  // Validate and normalize referral graph entries.
  const graph = new Set<string>();
  for (const entry of msg.referralGraph) {
    if (isHex64(entry)) {
      graph.add(normalizeHex(entry));
    }
  }

  // Evict any previous record for this pubkey (reconnect case).
  const existing = peers.get(pubkey);
  if (existing) {
    try { existing.socket.close(1000, 'Replaced by new connection'); } catch {}
  }

  peers.set(pubkey, {
    pubkey,
    referralGraph: graph,
    socket,
    connectedAt:   Date.now(),
    lastMessageAt: Date.now(),
    messageCount:  0,
  });

  sendToSocket(socket, {
    type:      'REGISTERED',
    pubkey,
    graphSize: graph.size,
    peersOnline: peers.size,
  });
}

function handleNostrEvent(
  event:        NostrEvent,
  senderPubkey: string | null
): void {
  // Only route NIP-17 gift wraps (kind 1059) — drop everything else silently.
  if (event.kind !== NIP17_GIFT_WRAP_KIND) return;

  const recipientPubkey = extractGiftWrapRecipient(event);
  if (!recipientPubkey) return;

  const recipientRecord = peers.get(recipientPubkey);
  if (!recipientRecord) {
    // Recipient not connected — silently drop.
    return;
  }

  // F2F enforcement: the sending peer's registered pubkey must be in the
  // recipient's referral graph.
  if (senderPubkey && !isInReferralGraph(recipientRecord, senderPubkey)) {
    // Unknown sender — silently drop. Do NOT notify sender.
    // Leaking "recipient is online but rejected you" enables graph probing.
    return;
  }

  // Forward the raw encrypted gift wrap to the recipient.
  // The worker never reads the NIP-44 content — pure relay.
  sendToSocket(recipientRecord.socket, {
    type:  'EVENT',
    event,
  });
}

// ---------------------------------------------------------------------------
// Per-connection WebSocket handler
// ---------------------------------------------------------------------------

function handleWebSocketConnection(
  socket:   WebSocket,
  maxPeers: number
): void {
  let registeredPubkey: string | null = null;

  // Heartbeat: send a PING every 30s to keep the connection alive through
  // Cloudflare's 100-second idle WebSocket timeout.
  const heartbeatTimer = setInterval(() => {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'PING' }));
      } else {
        clearInterval(heartbeatTimer);
      }
    } catch {
      clearInterval(heartbeatTimer);
    }
  }, HEARTBEAT_INTERVAL_MS);

  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      // Malformed JSON — drop.
      return;
    }

    if (!parsed || typeof parsed !== 'object') return;

    const msg = parsed as Record<string, unknown>;

    // Rate limiting (only applies after registration).
    if (registeredPubkey) {
      const peerRecord = peers.get(registeredPubkey);
      if (peerRecord && isRateLimited(peerRecord)) {
        sendToSocket(socket, {
          type:    'NOTICE',
          message: 'Rate limit exceeded. Slow down.',
        });
        return;
      }
    }

    switch (msg['type']) {
      case 'REGISTER': {
        const registerMsg = msg as unknown as RegisterMessage;
        handleRegister(registerMsg, socket, maxPeers);
        registeredPubkey = isHex64(registerMsg.pubkey)
          ? normalizeHex(registerMsg.pubkey)
          : null;
        break;
      }

      case 'EVENT': {
        if (!registeredPubkey) {
          sendToSocket(socket, {
            type:    'NOTICE',
            message: 'Must REGISTER before sending events.',
          });
          return;
        }

        const rawEvent = msg['event'];
        if (!validateNostrEvent(rawEvent)) {
          sendToSocket(socket, {
            type:    'NOTICE',
            message: 'Invalid Nostr event: failed NIP-01 validation.',
          });
          return;
        }

        handleNostrEvent(rawEvent, registeredPubkey);
        break;
      }

      case 'PING': {
        sendToSocket(socket, { type: 'PONG' });
        break;
      }

      case 'PONG': {
        // Heartbeat response — no action needed.
        break;
      }

      default: {
        // Unknown message type — silently ignore for forward compatibility.
        break;
      }
    }
  });

  socket.addEventListener('close', () => {
    clearInterval(heartbeatTimer);
    if (registeredPubkey) {
      const record = peers.get(registeredPubkey);
      // Only remove if this socket owns the record (reconnect may have replaced it).
      if (record && record.socket === socket) {
        peers.delete(registeredPubkey);
      }
    }
  });

  socket.addEventListener('error', () => {
    clearInterval(heartbeatTimer);
    if (registeredPubkey) {
      const record = peers.get(registeredPubkey);
      if (record && record.socket === socket) {
        peers.delete(registeredPubkey);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// CORS helper
// ---------------------------------------------------------------------------

function getCORSHeaders(request: Request, env: Env): HeadersInit {
  const origin         = request.headers.get('Origin') ?? '';
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : ['*'];

  const isAllowed =
    allowedOrigins.includes('*') || allowedOrigins.includes(origin);

  return {
    'Access-Control-Allow-Origin':  isAllowed ? origin || '*' : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Upgrade, Connection',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin',
  };
}

// ---------------------------------------------------------------------------
// HTTP health check handler
// ---------------------------------------------------------------------------

function handleHTTP(request: Request, env: Env): Response {
  const url    = new URL(request.url);
  const cors   = getCORSHeaders(request, env);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (url.pathname === '/health') {
    return new Response(
      JSON.stringify({
        status:       'ok',
        service:      'Flicker.TV Signaling Proxy',
        protocol:     'NIP-17 Gift-Wrapped WebRTC SDP Exchange',
        peersOnline:  peers.size,
        timestamp:    new Date().toISOString(),
      }),
      {
        status:  200,
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  if (url.pathname === '/peers') {
    // Returns count only — no pubkey list exposed (privacy).
    return new Response(
      JSON.stringify({ peersOnline: peers.size }),
      {
        status:  200,
        headers: { 'Content-Type': 'application/json', ...cors },
      }
    );
  }

  return new Response(
    JSON.stringify({
      service:  'Flicker.TV Signaling Proxy',
      protocol: 'Nostr NIP-17 WebRTC Signaling',
      version:  '1.0.0',
      endpoints: {
        websocket: 'GET / (Upgrade: websocket)',
        health:    'GET /health',
        peers:     'GET /peers',
      },
    }),
    {
      status:  200,
      headers: { 'Content-Type': 'application/json', ...cors },
    }
  );
}

// ---------------------------------------------------------------------------
// Main Worker export
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    const maxPeers      = parseInt(env.MAX_PEERS ?? String(DEFAULT_MAX_PEERS), 10);

    // Handle WebSocket upgrade.
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      if (peers.size >= maxPeers) {
        return new Response('Signaling proxy at capacity.', { status: 503 });
      }

      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];

      server.accept();
      handleWebSocketConnection(server, maxPeers);

      return new Response(null, {
        status:  101,
        webSocket: client,
      });
    }

    // Handle HTTP requests.
    return handleHTTP(request, env);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Type augmentation for Cloudflare Workers WebSocket API
// ---------------------------------------------------------------------------

// Cloudflare Workers exposes WebSocketPair differently from the browser.
// The following augmentation ensures TypeScript accepts the CF Worker API.
declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
  [key: string]: WebSocket;
}

interface WebSocket {
  accept(): void;
}

interface ResponseInit {
  webSocket?: WebSocket;
}

interface ExportedHandler<Env = unknown> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}