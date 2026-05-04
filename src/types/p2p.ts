/**
 * P2P Types
 * Phase 2 Fix: Shared schemas for WebRTC/Nostr contracts
 */

export interface PeerInfo {
  peerId: string;
  publicKey: string;
  endpoints: string[];
  lastSeen: number;
}

export interface SignalingMessage {
  type: 'offer' | 'answer' | 'candidate' | 'ping' | 'pong';
  from: string;
  to: string;
  data?: any;
  timestamp: number;
}

export interface NostrSignalingEvent {
  kind: 21000; // Custom kind for signaling
  pubkey: string;
  content: string; // Encrypted signaling message
  tags: [['e', 'event-id'], ['p', 'peer-pubkey']];
}

export interface RTCSignalingData {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface IceCandidate {
  candidate: string;
  sdpMLineIndex: number;
  sdpMid?: string;
}

export interface PeerMetrics {
  peerId: string;
  latency: number;
  bytesReceived: number;
  bytesSent: number;
  packetsLost: number;
}
