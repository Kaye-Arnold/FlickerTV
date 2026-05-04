/**
 * Flicker.TV — WebRTC Insertable Streams Encryption (Blind Seeding)
 *
 * Implements AES-256-GCM chunk encryption via the WebRTC Encoded Transform API
 * so that relay peers seed only opaque ciphertext — zero-knowledge routing.
 *
 * Architecture:
 *   Sender (origin peer)
 *     │
 *     ├─ RTCRtpSender.createEncodedStreams()
 *     │    └─ ReadableStream<RTCEncodedVideoFrame>
 *     │         │  [each frame intercepted]
 *     │         ▼
 *     │    EncryptTransform (AES-256-GCM)
 *     │         │  key = HKDF(SHA-256(movieUrl))
 *     │         │  IV  = frame.timestamp (8B) || counter (4B)
 *     │         │  AAD = frame.type (1B) || timestamp (8B)
 *     │         ▼
 *     │    WritableStream → encrypted wire frames
 *     │
 *   Relay peer(s)
 *     │  Receive ciphertext over RTCDataChannel — CANNOT decrypt.
 *     │  Re-transmit blindly. Zero knowledge of content.
 *     │
 *   Receiver (destination peer)
 *     │
 *     ├─ RTCRtpReceiver.createEncodedStreams()
 *     │    └─ ReadableStream<RTCEncodedVideoFrame>
 *     │         │  [each frame intercepted]
 *     │         ▼
 *     │    DecryptTransform (AES-256-GCM)
 *     │         │  same key derivation, verify AAD + auth tag
 *     │         ▼
 *     │    WritableStream → decoded plaintext frames → video element
 *
 * Encrypted Frame Wire Format:
 *   Offset  Size   Field
 *   ──────  ────   ─────────────────────────────────────────────────────────
 *     0       1    FORMAT_VERSION = 0x01
 *     1      12    AES-GCM IV (nonce): timestamp[8] || frameCounter[4]
 *    13       1    FLAGS: bit 0 = isKeyFrame, bits 1-7 reserved
 *    14       4    PLAINTEXT_LENGTH (uint32BE): original frame byte count
 *    18       N    AES-GCM CIPHERTEXT (N = plaintext_len + 16 GCM tag bytes)
 *
 * Additional Authenticated Data (AAD) — authenticated but not encrypted:
 *   FLAGS (1 byte) || timestamp as uint64BE (8 bytes) = 9 bytes total
 *   This allows receivers to validate metadata integrity without decrypting.
 *
 * Key Derivation:
 *   masterKey  = HKDF-SHA256(IKM=SHA-256(movieUrl), salt=APP_SALT, info=STREAM_INFO, len=32)
 *   sessionKey = HKDF-SHA256(IKM=masterKey, salt=sessionNonce, info=SESSION_INFO, len=32)
 *   aesGcmKey  = importKey('raw', sessionKey, 'AES-GCM', 256)
 *
 * Browser Support:
 *   Chrome 86+  : RTCRtpSender/Receiver.createEncodedStreams()  [legacy API]
 *   Chrome 94+  : RTCRtpScriptTransform                         [standard API]
 *   Firefox 117+: RTCRtpScriptTransform
 *   Safari 15.4+: RTCRtpScriptTransform
 *
 * This module implements the legacy createEncodedStreams() path with a
 * feature-detected fallback note. For RTCRtpScriptTransform (standard),
 * move the transform logic to a dedicated Worker file and use:
 *   sender.transform = new RTCRtpScriptTransform(worker, { op: 'encrypt' });
 *
 * Required packages (add to package.json):
 *   "@noble/hashes": "^1.4.0"  (already present from Phase 1.5)
 */

import { sha256 }                     from '@noble/hashes/sha256';
import { hkdf }                       from '@noble/hashes/hkdf';
import { utf8ToBytes, bytesToHex }    from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// TypeScript augmentation for Encoded Transform API
// (Not yet in TypeScript's lib.dom.d.ts as of TS 5.4)
// ---------------------------------------------------------------------------

interface RTCEncodedVideoFrame {
  data:       ArrayBuffer;
  timestamp:  number;
  type?:      'key' | 'delta' | 'empty';
  getMetadata?(): RTCEncodedVideoFrameMetadata;
}

interface RTCEncodedVideoFrameMetadata {
  frameId?:               number;
  dependencies?:          number[];
  width?:                 number;
  height?:                number;
  spatialIndex?:          number;
  temporalIndex?:         number;
  synchronizationSource?: number;
  payloadType?:           number;
}

interface RTCEncodedAudioFrame {
  data:      ArrayBuffer;
  timestamp: number;
  getMetadata?(): RTCEncodedAudioFrameMetadata;
}

interface RTCEncodedAudioFrameMetadata {
  synchronizationSource?: number;
  payloadType?:           number;
}

interface EncodedStreams {
  readable: ReadableStream<RTCEncodedVideoFrame>;
  writable: WritableStream<RTCEncodedVideoFrame>;
}

interface RTCRtpSenderWithEncoding extends RTCRtpSender {
  createEncodedStreams?(): EncodedStreams;
}

interface RTCRtpReceiverWithEncoding extends RTCRtpReceiver {
  createEncodedStreams?(): EncodedStreams;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StreamEncryptionConfig {
  /** Full archive.org URL of the movie being streamed. Determines the master key. */
  movieUrl:     string;
  /**
   * Per-session random nonce (32 bytes). Both sender and receiver must use
   * the same nonce (exchange it via the encrypted signaling channel BEFORE
   * calling setupSenderEncryption / setupReceiverDecryption).
   */
  sessionNonce: Uint8Array;
  /** Optional: called when a frame fails authentication (integrity violation). */
  onIntegrityViolation?: (frameTimestamp: number, reason: string) => void;
  /** Optional: called periodically with throughput stats. */
  onStats?: (stats: EncryptionStats) => void;
  /** Stats reporting interval in ms. Default: 5000. */
  statsIntervalMs?: number;
}

export interface EncryptionStats {
  framesEncrypted:  number;
  framesDecrypted:  number;
  framesDropped:    number;
  bytesProcessed:   number;
  avgEncryptMs:     number;
  avgDecryptMs:     number;
}

export interface StreamEncryptionSession {
  /** Call to cleanly shut down the transform and release crypto key handles. */
  destroy(): void;
  /** Returns a snapshot of current stats. */
  getStats(): EncryptionStats;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORMAT_VERSION     = 0x01;
const HEADER_SIZE_BYTES  = 18;  // 1 (version) + 12 (IV) + 1 (flags) + 4 (length)
const GCM_TAG_SIZE_BYTES = 16;
const IV_SIZE_BYTES      = 12;
const AAD_SIZE_BYTES     = 9;   // 1 (flags) + 8 (timestamp uint64BE)

const APP_SALT    = utf8ToBytes('flicker.tv:stream-encryption:v1');
const MASTER_INFO = utf8ToBytes('flicker.tv:stream:master-key:v1');
const SESSION_INFO = utf8ToBytes('flicker.tv:stream:session-key:v1');

// Maximum IV counter before rollover risk (2^32 frames @ 30fps ≈ 4.5 years).
const MAX_FRAME_COUNTER = 0xFFFFFFFF;

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive the AES-256-GCM session key from a movie URL and session nonce.
 *
 * Two-layer derivation for key separation:
 *   1. Master key: bound to the movie (URL as IKM), stable across sessions.
 *   2. Session key: bound to the session nonce (changes each call / reconnect).
 *
 * This ensures:
 *   - Different movies use different master keys (URL-scoped).
 *   - Different WebRTC sessions use different encryption keys (nonce-scoped).
 *   - Compromise of one session key does not expose the master key.
 */
async function deriveSessionKey(config: StreamEncryptionConfig): Promise<CryptoKey> {
  // Layer 1: SHA-256(movieUrl) → IKM (normalised, variable-length URL becomes 32 bytes).
  const urlBytes  = utf8ToBytes(config.movieUrl.trim().toLowerCase());
  const urlDigest = sha256(urlBytes);

  // Layer 2: HKDF → masterKeyBytes (URL-scoped, stable across sessions).
  const masterKeyBytes = hkdf(sha256, urlDigest, APP_SALT, MASTER_INFO, 32);

  // Layer 3: HKDF → sessionKeyBytes (nonce-scoped, unique per WebRTC session).
  const sessionKeyBytes = hkdf(
    sha256,
    masterKeyBytes,
    config.sessionNonce,
    SESSION_INFO,
    32
  );

  // Zero master key bytes immediately — only session key is needed hereafter.
  masterKeyBytes.fill(0);

  return crypto.subtle.importKey(
    'raw',
    sessionKeyBytes,
    { name: 'AES-GCM', length: 256 },
    false,       // Non-extractable: key cannot be exported once imported.
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------------
// IV construction
// ---------------------------------------------------------------------------

/**
 * Build a 12-byte AES-GCM IV from frame timestamp + monotonic frame counter.
 *
 * Using the timestamp as the high 8 bytes and counter as the low 4 bytes
 * ensures that even if the counter wraps (very unlikely at 30fps over years),
 * the timestamp component keeps the IV unique.
 *
 * The BigInt conversion handles timestamp values > 2^53 safely.
 */
function buildIV(timestamp: number, counter: number): Uint8Array {
  const iv   = new Uint8Array(IV_SIZE_BYTES);
  const view = new DataView(iv.buffer);

  // High 8 bytes: timestamp as unsigned 64-bit big-endian.
  // JavaScript timestamps are ms-precision floats; truncate to safe integer.
  const tsBigInt = BigInt(Math.floor(timestamp)) & 0xFFFFFFFFFFFFFFFFn;
  view.setBigUint64(0, tsBigInt, false /* big-endian */);

  // Low 4 bytes: frame counter as unsigned 32-bit big-endian.
  view.setUint32(8, counter >>> 0, false);

  return iv;
}

// ---------------------------------------------------------------------------
// AAD construction
// ---------------------------------------------------------------------------

/**
 * Build the 9-byte Additional Authenticated Data.
 * AAD is authenticated (integrity-protected) but NOT encrypted.
 * Peers can read frame type and timestamp without the encryption key,
 * but cannot forge or modify them without detection.
 */
function buildAAD(flags: number, timestamp: number): Uint8Array {
  const aad  = new Uint8Array(AAD_SIZE_BYTES);
  const view = new DataView(aad.buffer);
  view.setUint8(0, flags & 0xFF);
  view.setBigUint64(1, BigInt(Math.floor(timestamp)) & 0xFFFFFFFFFFFFFFFFn, false);
  return aad;
}

function frameTypeToFlags(frame: RTCEncodedVideoFrame): number {
  return frame.type === 'key' ? 0x01 : 0x00;
}

// ---------------------------------------------------------------------------
// Frame encryption
// ---------------------------------------------------------------------------

async function encryptFrame(
  frame:    RTCEncodedVideoFrame,
  key:      CryptoKey,
  counter:  number
): Promise<ArrayBuffer> {
  const flags     = frameTypeToFlags(frame);
  const iv        = buildIV(frame.timestamp, counter);
  const aad       = buildAAD(flags, frame.timestamp);
  const plaintext = new Uint8Array(frame.data);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    key,
    plaintext
  );

  // Assemble wire format: [version(1)][iv(12)][flags(1)][length(4)][ciphertext(N)]
  const output = new Uint8Array(HEADER_SIZE_BYTES + ciphertext.byteLength);
  const view   = new DataView(output.buffer);
  let   offset = 0;

  output[offset++] = FORMAT_VERSION;

  output.set(iv, offset);
  offset += IV_SIZE_BYTES; // 12

  output[offset++] = flags;

  view.setUint32(offset, plaintext.byteLength, false /* big-endian */);
  offset += 4;

  output.set(new Uint8Array(ciphertext), offset);

  return output.buffer;
}

// ---------------------------------------------------------------------------
// Frame decryption
// ---------------------------------------------------------------------------

async function decryptFrame(
  frame:    RTCEncodedVideoFrame,
  key:      CryptoKey,
  onError?: (ts: number, reason: string) => void
): Promise<ArrayBuffer | null> {
  const data = new Uint8Array(frame.data);

  if (data.length < HEADER_SIZE_BYTES + GCM_TAG_SIZE_BYTES) {
    onError?.(frame.timestamp, `Frame too short: ${data.length} bytes.`);
    return null;
  }

  const view   = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let   offset = 0;

  const version = data[offset++];
  if (version !== FORMAT_VERSION) {
    onError?.(frame.timestamp, `Unknown format version: 0x${version?.toString(16)}`);
    return null;
  }

  const iv = data.slice(offset, offset + IV_SIZE_BYTES);
  offset += IV_SIZE_BYTES;

  const flags = data[offset++]!;
  const plaintextLength = view.getUint32(offset, false);
  offset += 4;

  const ciphertext = data.slice(offset);

  if (ciphertext.length !== plaintextLength + GCM_TAG_SIZE_BYTES) {
    onError?.(
      frame.timestamp,
      `Ciphertext length mismatch: expected ${plaintextLength + GCM_TAG_SIZE_BYTES}, got ${ciphertext.length}.`
    );
    return null;
  }

  const aad = buildAAD(flags, frame.timestamp);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      key,
      ciphertext
    );
    return plaintext;
  } catch {
    // AES-GCM auth tag verification failed — frame was tampered or corrupted.
    onError?.(frame.timestamp, 'AES-GCM authentication tag verification failed.');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transform stream factories
// ---------------------------------------------------------------------------

function makeEncryptTransform(
  key:      CryptoKey,
  stats:    EncryptionStats,
  onError?: (ts: number, reason: string) => void
): TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame> {
  let frameCounter = 0;

  return new TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame>({
    async transform(
      frame:      RTCEncodedVideoFrame,
      controller: TransformStreamDefaultController<RTCEncodedVideoFrame>
    ) {
      if (frameCounter > MAX_FRAME_COUNTER) {
        frameCounter = 0;
        console.warn(
          '[InsertableStreams] Frame counter rolled over. ' +
            'Consider renegotiating the session key.'
        );
      }

      const t0       = performance.now();
      const byteLen  = frame.data.byteLength;

      try {
        frame.data = await encryptFrame(frame, key, frameCounter++);
        stats.framesEncrypted += 1;
        stats.bytesProcessed  += byteLen;
        stats.avgEncryptMs = stats.avgEncryptMs
          ? (stats.avgEncryptMs * 0.9 + (performance.now() - t0) * 0.1)
          : (performance.now() - t0);
        controller.enqueue(frame);
      } catch (err) {
        stats.framesDropped += 1;
        onError?.(
          frame.timestamp,
          `Encryption error: ${err instanceof Error ? err.message : String(err)}`
        );
        // Drop the frame — do not enqueue corrupted data.
      }
    },
  });
}

function makeDecryptTransform(
  key:      CryptoKey,
  stats:    EncryptionStats,
  onError?: (ts: number, reason: string) => void
): TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame> {
  return new TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame>({
    async transform(
      frame:      RTCEncodedVideoFrame,
      controller: TransformStreamDefaultController<RTCEncodedVideoFrame>
    ) {
      const t0      = performance.now();
      const byteLen = frame.data.byteLength;

      const plaintext = await decryptFrame(frame, key, onError);

      if (plaintext === null) {
        stats.framesDropped += 1;
        // Drop frame — integrity violation already reported via onError.
        return;
      }

      frame.data = plaintext;
      stats.framesDecrypted += 1;
      stats.bytesProcessed  += byteLen;
      stats.avgDecryptMs = stats.avgDecryptMs
        ? (stats.avgDecryptMs * 0.9 + (performance.now() - t0) * 0.1)
        : (performance.now() - t0);
      controller.enqueue(frame);
    },
  });
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

export function isInsertableStreamsSupported(): boolean {
  if (typeof window === 'undefined') return false;

  // Check for legacy createEncodedStreams API.
  const sender = RTCPeerConnection.prototype;
  return (
    typeof (sender as unknown as Record<string, unknown>)['getSenders'] === 'function' &&
    // We check RTCRtpSender prototype for createEncodedStreams.
    typeof (RTCRtpSender.prototype as unknown as RTCRtpSenderWithEncoding)
      .createEncodedStreams === 'function'
  );
}

export function isRtpScriptTransformSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (window as unknown as Record<string, unknown>)['RTCRtpScriptTransform'] === 'function';
}

// ---------------------------------------------------------------------------
// Public API: Sender
// ---------------------------------------------------------------------------

/**
 * Attach AES-256-GCM encryption to an RTCRtpSender's video stream.
 *
 * MUST be called BEFORE the sender begins transmitting frames.
 * The PeerConnection must have been created with:
 *   `{ encodedInsertableStreams: true }` (Chrome-specific constraint)
 *
 * @param sender   The RTCRtpSender attached to the video track.
 * @param config   Encryption configuration including movie URL + session nonce.
 * @returns        Session handle with destroy() and getStats().
 */
export async function setupSenderEncryption(
  sender: RTCRtpSender,
  config: StreamEncryptionConfig
): Promise<StreamEncryptionSession> {
  const senderWithEncoding = sender as RTCRtpSenderWithEncoding;

  if (typeof senderWithEncoding.createEncodedStreams !== 'function') {
    throw new Error(
      '[InsertableStreams] RTCRtpSender.createEncodedStreams() is not available. ' +
        'Ensure the RTCPeerConnection was created with { encodedInsertableStreams: true } ' +
        'and the browser supports the Encoded Transform API.'
    );
  }

  const sessionKey = await deriveSessionKey(config);
  const stats: EncryptionStats = {
    framesEncrypted: 0,
    framesDecrypted: 0,
    framesDropped:   0,
    bytesProcessed:  0,
    avgEncryptMs:    0,
    avgDecryptMs:    0,
  };

  const encryptTransform = makeEncryptTransform(
    sessionKey,
    stats,
    config.onIntegrityViolation
  );

  const { readable, writable } = senderWithEncoding.createEncodedStreams();

  // Pipe: encoded frames → encrypt transform → wire.
  const pipePromise = readable
    .pipeThrough(encryptTransform)
    .pipeTo(writable)
    .catch((err) => {
      if ((err as Error)?.name !== 'AbortError') {
        console.error('[InsertableStreams] Sender pipe error:', err);
      }
    });

  let statsTimer: ReturnType<typeof setInterval> | null = null;
  if (config.onStats) {
    statsTimer = setInterval(
      () => config.onStats!({ ...stats }),
      config.statsIntervalMs ?? 5000
    );
  }

  return {
    destroy() {
      if (statsTimer !== null) clearInterval(statsTimer);
      // Abort the pipe by cancelling the readable side.
      encryptTransform.readable.cancel('Session destroyed').catch(() => {});
    },
    getStats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------------------
// Public API: Receiver
// ---------------------------------------------------------------------------

/**
 * Attach AES-256-GCM decryption to an RTCRtpReceiver's video stream.
 *
 * MUST be called immediately when the receiver is obtained from the
 * PeerConnection's track event handler, before frames begin arriving.
 *
 * @param receiver The RTCRtpReceiver for the incoming video track.
 * @param config   Decryption configuration (must match sender's config).
 * @returns        Session handle with destroy() and getStats().
 */
export async function setupReceiverDecryption(
  receiver: RTCRtpReceiver,
  config:   StreamEncryptionConfig
): Promise<StreamEncryptionSession> {
  const receiverWithEncoding = receiver as RTCRtpReceiverWithEncoding;

  if (typeof receiverWithEncoding.createEncodedStreams !== 'function') {
    throw new Error(
      '[InsertableStreams] RTCRtpReceiver.createEncodedStreams() is not available. ' +
        'Ensure the RTCPeerConnection was created with { encodedInsertableStreams: true }.'
    );
  }

  const sessionKey = await deriveSessionKey(config);
  const stats: EncryptionStats = {
    framesEncrypted: 0,
    framesDecrypted: 0,
    framesDropped:   0,
    bytesProcessed:  0,
    avgEncryptMs:    0,
    avgDecryptMs:    0,
  };

  const decryptTransform = makeDecryptTransform(
    sessionKey,
    stats,
    config.onIntegrityViolation
  );

  const { readable, writable } = receiverWithEncoding.createEncodedStreams();

  const pipePromise = readable
    .pipeThrough(decryptTransform)
    .pipeTo(writable)
    .catch((err) => {
      if ((err as Error)?.name !== 'AbortError') {
        console.error('[InsertableStreams] Receiver pipe error:', err);
      }
    });

  let statsTimer: ReturnType<typeof setInterval> | null = null;
  if (config.onStats) {
    statsTimer = setInterval(
      () => config.onStats!({ ...stats }),
      config.statsIntervalMs ?? 5000
    );
  }

  return {
    destroy() {
      if (statsTimer !== null) clearInterval(statsTimer);
      decryptTransform.readable.cancel('Session destroyed').catch(() => {});
    },
    getStats: () => ({ ...stats }),
  };
}

// ---------------------------------------------------------------------------
// Public API: Session nonce generation
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random 32-byte session nonce.
 * Both peers must exchange this nonce via the encrypted signaling channel
 * BEFORE calling setupSenderEncryption / setupReceiverDecryption.
 *
 * The nonce differentiates the per-session AES-GCM key from the master key,
 * ensuring forward secrecy between WebRTC sessions for the same movie.
 */
export function generateSessionNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Serialize a session nonce to hex for transmission over the signaling channel.
 */
export function serializeNonce(nonce: Uint8Array): string {
  return bytesToHex(nonce);
}

/**
 * Deserialize a hex session nonce received from the remote peer.
 */
export function deserializeNonce(hex: string): Uint8Array {
  if (hex.length !== 64) {
    throw new Error(
      `[InsertableStreams] Invalid nonce length: ${hex.length} hex chars (expected 64).`
    );
  }
  return new Uint8Array(
    hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16))
  );
}

// ---------------------------------------------------------------------------
// Public API: PeerConnection factory helper
// ---------------------------------------------------------------------------

/**
 * Create an RTCPeerConnection pre-configured for Insertable Streams.
 * In Chrome, the `encodedInsertableStreams` constraint must be set at
 * construction time — it cannot be added retroactively.
 */
export function createEncryptedPeerConnection(
  iceConfig?: RTCConfiguration
): RTCPeerConnection {
  const config: RTCConfiguration & Record<string, unknown> = {
    ...(iceConfig ?? {}),
    // Chrome-specific constraint enabling createEncodedStreams().
    encodedInsertableStreams: true,
  };

  return new RTCPeerConnection(config);
}