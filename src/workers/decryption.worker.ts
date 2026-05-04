/**
 * Decryption Worker
 * Phase 2 Fix: Offloads WebRTC cryptography from the main UI thread
 * Handles encryption/decryption of peer connection streams
 */

interface DecryptionMessage {
  type: 'init' | 'encrypt' | 'decrypt';
  key?: Uint8Array;
  data?: Uint8Array;
}

interface DecryptionResponse {
  type: 'success' | 'error';
  result?: Uint8Array;
  error?: string;
}

let cryptoKey: CryptoKey | null = null;

self.onmessage = async (event: MessageEvent<DecryptionMessage>) => {
  const { type, key, data } = event.data;

  try {
    switch (type) {
      case 'init':
        if (key) {
          cryptoKey = await crypto.subtle.importKey(
            'raw',
            key,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
          );
          self.postMessage({ type: 'success' } as DecryptionResponse);
        }
        break;

      case 'encrypt':
        if (cryptoKey && data) {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            cryptoKey,
            data
          );
          const result = new Uint8Array(iv.length + encrypted.byteLength);
          result.set(iv);
          result.set(new Uint8Array(encrypted), iv.length);
          self.postMessage({ type: 'success', result } as DecryptionResponse);
        }
        break;

      case 'decrypt':
        if (cryptoKey && data) {
          const iv = data.slice(0, 12);
          const encrypted = data.slice(12);
          const result = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            cryptoKey,
            encrypted
          );
          self.postMessage({
            type: 'success',
            result: new Uint8Array(result),
          } as DecryptionResponse);
        }
        break;
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    } as DecryptionResponse);
  }
};
