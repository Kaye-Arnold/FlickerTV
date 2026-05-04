/**
 * Flicker.TV — WebAuthn PRF Identity Manager
 *
 * Derives a deterministic cryptographic identity from a hardware passkey
 * using the PRF (Pseudo-Random Function) WebAuthn Level 3 extension.
 *
 * ITP Survival Architecture:
 *   iOS Safari's 7-day ITP wipe destroys IndexedDB, localStorage, and all
 *   origin storage for sites not visited within the window. This module
 *   survives because:
 *     1. The credential ID stored in localStorage is re-discoverable from
 *        the platform authenticator (Secure Enclave / Face ID) even after
 *        a wipe — the hardware key never expires.
 *     2. The cryptographic seed is NEVER persisted. It is re-derived from
 *        the hardware PRF output on every session.
 *     3. The PRF is deterministic: given the same hardware token + fixed
 *        salt, it always returns bit-for-bit identical output regardless of
 *        how many times localStorage has been wiped.
 *     4. If the credential ID is wiped too, re-registration against the
 *        SAME hardware token with the SAME PRF salt produces IDENTICAL keys
 *        (the Secure Enclave binds the PRF to the credential, not to the
 *        credential ID string).
 *
 * Derived Outputs (all deterministic from one hardware interaction):
 *   - Nostr identity: secp256k1 privkey + pubkey per NIP-01
 *   - Gun.js SEA pair: P-256 ECDSA (signing) + P-256 ECDH (encryption)
 *   - 32-byte root seed for arbitrary downstream HKDF derivations
 *
 * Required packages (add to package.json):
 *   "@noble/curves": "^1.4.0"
 *   "@noble/hashes": "^1.4.0"
 *   "@simplewebauthn/browser": "^10.0.0"
 *   "@simplewebauthn/types": "^10.0.0"
 */

import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
} from '@simplewebauthn/browser';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/types';
import { secp256k1 }  from '@noble/curves/secp256k1';
import { p256 }       from '@noble/curves/p256';
import { sha256 }     from '@noble/hashes/sha256';
import { hkdf }       from '@noble/hashes/hkdf';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface NostrIdentity {
  /**
   * Hex-encoded secp256k1 private key (32 bytes).
   * MUST NEVER leave the device. Treat as HSM-equivalent secret.
   */
  privkey: string;
  /** Hex-encoded secp256k1 compressed public key (33 bytes, 02/03 prefix). */
  pubkey:  string;
  /**
   * NIP-01 x-only public key (32 bytes, no compression prefix).
   * This is the canonical Nostr public key used in npub / nprofile.
   */
  npubHex: string;
}

export interface GunSEAPair {
  /** Base64url SPKI-encoded P-256 ECDSA public key. */
  pub:   string;
  /** Base64url PKCS#8-encoded P-256 ECDSA private key. */
  priv:  string;
  /** Base64url SPKI-encoded P-256 ECDH public key. */
  epub:  string;
  /** Base64url PKCS#8-encoded P-256 ECDH private key. */
  epriv: string;
}

export interface FlickerIdentity {
  nostr:        NostrIdentity;
  gun:          GunSEAPair;
  /**
   * Raw 32-byte root seed. Use `deriveSubkeyFromIdentity()` to derive
   * purpose-specific subkeys via HKDF without exposing this directly.
   */
  rootSeed:     Uint8Array;
  credentialId: string;
  derivedAt:    string;
}

// ---------------------------------------------------------------------------
// PRF extension type augmentation
// @simplewebauthn/types does not yet expose full PRF typing (WebAuthn L3).
// ---------------------------------------------------------------------------

interface PRFExtensionEvalInput {
  first:   string;  // base64url-encoded salt (32 bytes)
  second?: string;
}

interface PRFExtensionResult {
  enabled?: boolean;
  results?: {
    first?:  ArrayBuffer;
    second?: ArrayBuffer;
  };
}

interface AuthClientExtensionsWithPRF extends AuthenticationExtensionsClientOutputs {
  prf?: PRFExtensionResult;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RP_NAME = 'Flicker.TV — The MovieDom';

const STORAGE_CREDENTIAL_ID = 'flicker:webauthn:cid:v1';
const STORAGE_DERIVED_AT    = 'flicker:webauthn:at:v1';

/**
 * PRF salt — public, fixed, app-specific constant.
 * Pre-hashed from UTF-8("flicker.tv:prf-salt:v1") for cross-browser consistency.
 * CHANGING THIS VALUE INVALIDATES ALL EXISTING DERIVED IDENTITIES.
 */
const PRF_SALT: Uint8Array = sha256(utf8ToBytes('flicker.tv:prf-salt:v1'));

/** Domain-separated HKDF info strings — each purpose gets an isolated subkey. */
const HKDF_INFO = {
  rootEntropy:   utf8ToBytes('flicker.tv:root-entropy:v1'),
  nostrSigning:  utf8ToBytes('flicker.tv:nostr:signing-key:v1'),
  gunECDSA:      utf8ToBytes('flicker.tv:gun:ecdsa-key:v1'),
  gunECDH:       utf8ToBytes('flicker.tv:gun:ecdh-key:v1'),
  rootSeedExport:utf8ToBytes('flicker.tv:root-seed:v1'),
} as const;

// ---------------------------------------------------------------------------
// Utility: safe base64url encoding
// ---------------------------------------------------------------------------

function toBase64url(bytes: Uint8Array): string {
  // Avoid spread operator on large arrays — use Array.from for safety.
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function fromBase64url(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin    = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Utility: BigInt ↔ Uint8Array (curve scalar operations)
// ---------------------------------------------------------------------------

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const byte of bytes) {
    n = (n << 8n) | BigInt(byte);
  }
  return n;
}

function bigIntToBytes32(n: bigint): Uint8Array {
  const hex   = n.toString(16).padStart(64, '0');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// HKDF subkey derivation
// ---------------------------------------------------------------------------

function deriveSubkey(
  ikm:    Uint8Array,
  info:   Uint8Array,
  length: number = 32
): Uint8Array {
  // salt = PRF_SALT ensures domain separation even if IKM has low entropy.
  return hkdf(sha256, ikm, PRF_SALT, info, length);
}

// ---------------------------------------------------------------------------
// Curve scalar normalization
// ---------------------------------------------------------------------------

/**
 * Reduce a 32-byte seed to a valid secp256k1 private key scalar.
 * secp256k1 requires: 0 < privkey < n
 * We reduce modulo (n - 1) then add 1 to ensure the result is in [1, n-1].
 */
function normToSecp256k1Scalar(seed: Uint8Array): Uint8Array {
  const n    = secp256k1.CURVE.n;
  const raw  = bytesToBigInt(seed.slice(0, 32));
  const normalized = ((raw % (n - 1n)) + 1n);
  return bigIntToBytes32(normalized);
}

/**
 * Reduce a 32-byte seed to a valid P-256 private key scalar.
 * P-256 (secp256r1) requires: 0 < privkey < n
 */
function normToP256Scalar(seed: Uint8Array): Uint8Array {
  const n    = p256.CURVE.n;
  const raw  = bytesToBigInt(seed.slice(0, 32));
  const normalized = ((raw % (n - 1n)) + 1n);
  return bigIntToBytes32(normalized);
}

// ---------------------------------------------------------------------------
// Secp256k1 Nostr identity
// ---------------------------------------------------------------------------

function deriveNostrIdentity(seed: Uint8Array): NostrIdentity {
  const privBytes = normToSecp256k1Scalar(seed);
  // Compressed public key (33 bytes: 02/03 prefix + 32-byte x).
  const pubBytes  = secp256k1.getPublicKey(privBytes, true);
  // NIP-01 x-only key = drop the 1-byte compression prefix.
  const npubBytes = pubBytes.slice(1);

  return {
    privkey: bytesToHex(privBytes),
    pubkey:  bytesToHex(pubBytes),
    npubHex: bytesToHex(npubBytes),
  };
}

// ---------------------------------------------------------------------------
// P-256 Gun.js SEA keypair derivation
// ---------------------------------------------------------------------------

/**
 * Derive a P-256 ECDSA keypair for Gun.js SEA signing operations.
 * Uses JWK import — portable and avoids manual DER/PKCS#8 construction.
 */
async function deriveP256ECDSAKeypair(
  seed: Uint8Array
): Promise<{ pub: string; priv: string }> {
  const privScalar = normToP256Scalar(seed);
  // Uncompressed public key: 04 || x (32 bytes) || y (32 bytes) = 65 bytes.
  const pubUncompressed = p256.getPublicKey(privScalar, false);
  const x = pubUncompressed.slice(1, 33);
  const y = pubUncompressed.slice(33, 65);

  const jwkPriv: JsonWebKey = {
    kty:     'EC',
    crv:     'P-256',
    x:       toBase64url(x),
    y:       toBase64url(y),
    d:       toBase64url(privScalar),
    key_ops: ['sign'],
    ext:     true,
  };

  const jwkPub: JsonWebKey = {
    kty:     'EC',
    crv:     'P-256',
    x:       toBase64url(x),
    y:       toBase64url(y),
    key_ops: ['verify'],
    ext:     true,
  };

  const ecdsaParams = { name: 'ECDSA', namedCurve: 'P-256' } as const;

  const [cryptoPrivKey, cryptoPubKey] = await Promise.all([
    crypto.subtle.importKey('jwk', jwkPriv, ecdsaParams, true, ['sign']),
    crypto.subtle.importKey('jwk', jwkPub,  ecdsaParams, true, ['verify']),
  ]);

  const [privExported, pubExported] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', cryptoPrivKey),
    crypto.subtle.exportKey('spki',  cryptoPubKey),
  ]);

  return {
    pub:  toBase64url(new Uint8Array(pubExported)),
    priv: toBase64url(new Uint8Array(privExported)),
  };
}

/**
 * Derive a P-256 ECDH keypair for Gun.js SEA encryption operations.
 */
async function deriveP256ECDHKeypair(
  seed: Uint8Array
): Promise<{ epub: string; epriv: string }> {
  const privScalar = normToP256Scalar(seed);
  const pubUncompressed = p256.getPublicKey(privScalar, false);
  const x = pubUncompressed.slice(1, 33);
  const y = pubUncompressed.slice(33, 65);

  const jwkPriv: JsonWebKey = {
    kty:     'EC',
    crv:     'P-256',
    x:       toBase64url(x),
    y:       toBase64url(y),
    d:       toBase64url(privScalar),
    key_ops: ['deriveKey', 'deriveBits'],
    ext:     true,
  };

  const jwkPub: JsonWebKey = {
    kty:     'EC',
    crv:     'P-256',
    x:       toBase64url(x),
    y:       toBase64url(y),
    key_ops: [],
    ext:     true,
  };

  const ecdhParams = { name: 'ECDH', namedCurve: 'P-256' } as const;

  const [cryptoPrivKey, cryptoPubKey] = await Promise.all([
    crypto.subtle.importKey('jwk', jwkPriv, ecdhParams, true, ['deriveKey', 'deriveBits']),
    crypto.subtle.importKey('jwk', jwkPub,  ecdhParams, true, []),
  ]);

  const [privExported, pubExported] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', cryptoPrivKey),
    crypto.subtle.exportKey('spki',  cryptoPubKey),
  ]);

  return {
    epub:  toBase64url(new Uint8Array(pubExported)),
    epriv: toBase64url(new Uint8Array(privExported)),
  };
}

// ---------------------------------------------------------------------------
// PRF output extraction
// ---------------------------------------------------------------------------

function extractPRFOutput(
  extensions: AuthClientExtensionsWithPRF
): Uint8Array {
  const prf = extensions.prf;

  if (!prf) {
    throw new Error(
      '[WebAuthnIdentity] PRF extension absent from authenticator response. ' +
        'The authenticator must support FIDO2 CTAP2.1+ with PRF extension.'
    );
  }

  if (prf.enabled === false) {
    throw new Error(
      '[WebAuthnIdentity] PRF extension present but disabled by the authenticator. ' +
        'Some authenticators require the PRF extension to be enabled during registration.'
    );
  }

  if (!prf.results?.first) {
    throw new Error(
      '[WebAuthnIdentity] PRF extension returned no result. ' +
        'The authenticator may have declined the PRF eval or does not support it.'
    );
  }

  const output = new Uint8Array(prf.results.first);

  if (output.length < 32) {
    throw new Error(
      `[WebAuthnIdentity] PRF output too short: ${output.length} bytes (expected ≥32).`
    );
  }

  return output;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function saveCredentialId(id: string): void {
  try {
    localStorage.setItem(STORAGE_CREDENTIAL_ID, id);
    localStorage.setItem(STORAGE_DERIVED_AT, new Date().toISOString());
  } catch {
    // Private browsing or quota — non-fatal. Identity re-derived fresh next session.
  }
}

function loadCredentialId(): string | null {
  try {
    return localStorage.getItem(STORAGE_CREDENTIAL_ID);
  } catch {
    return null;
  }
}

function loadDerivedAt(): string {
  try {
    return localStorage.getItem(STORAGE_DERIVED_AT) ?? new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// RP configuration
// ---------------------------------------------------------------------------

function getRpId(): string {
  if (typeof window === 'undefined') return 'flicker.tv';
  return window.location.hostname;
}

function makeChallenge(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

function prfSaltB64(): string {
  return toBase64url(PRF_SALT);
}

// ---------------------------------------------------------------------------
// Registration (first use or post-ITP-wipe)
// ---------------------------------------------------------------------------

async function registerNewPasskey(): Promise<{
  credentialId: string;
  prfOutput:    Uint8Array;
}> {
  const options: PublicKeyCredentialCreationOptionsJSON = {
    challenge:  makeChallenge(),
    rp: {
      name: RP_NAME,
      id:   getRpId(),
    },
    user: {
      // No PII stored in the user handle — random bytes only.
      id:          toBase64url(crypto.getRandomValues(new Uint8Array(16))),
      name:        'flicker.tv-viewer',
      displayName: 'Flicker.TV Viewer',
    },
    pubKeyCredParams: [
      { alg: -7,   type: 'public-key' }, // ES256 (P-256)
      { alg: -257, type: 'public-key' }, // RS256 (RSA fallback)
    ],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey:             'required',
      userVerification:        'required',
    },
    extensions: {
      prf: {
        eval: {
          first: prfSaltB64(),
        },
      },
    } as Record<string, unknown>,
    timeout: 120_000,
  };

  const response: RegistrationResponseJSON = await startRegistration({
    optionsJSON: options,
  });

  const credentialId = response.id;
  const prfOutput    = extractPRFOutput(
    response.clientExtensionResults as AuthClientExtensionsWithPRF
  );

  saveCredentialId(credentialId);
  return { credentialId, prfOutput };
}

// ---------------------------------------------------------------------------
// Authentication (re-derive on every subsequent session)
// ---------------------------------------------------------------------------

async function authenticateWithPasskey(
  credentialId: string
): Promise<Uint8Array> {
  const options: PublicKeyCredentialRequestOptionsJSON = {
    challenge: makeChallenge(),
    rpId:      getRpId(),
    allowCredentials: [
      { id: credentialId, type: 'public-key' },
    ],
    userVerification: 'required',
    extensions: {
      prf: {
        eval: {
          first: prfSaltB64(),
        },
      },
    } as Record<string, unknown>,
    timeout: 120_000,
  };

  const response: AuthenticationResponseJSON = await startAuthentication({
    optionsJSON: options,
  });

  return extractPRFOutput(
    response.clientExtensionResults as AuthClientExtensionsWithPRF
  );
}

// ---------------------------------------------------------------------------
// Master identity derivation from PRF output
// ---------------------------------------------------------------------------

/**
 * Full derivation tree:
 *
 *   PRF_output [32 bytes, hardware-bound]
 *     │
 *     └── SHA-256(PRF_output ‖ "flicker.tv:root-entropy:v1")
 *           → root_entropy [32 bytes]
 *               │
 *               ├── HKDF(info="nostr:signing-key:v1")  → nostr_seed
 *               │     └── secp256k1 scalar  → privkey, pubkey, npubHex
 *               │
 *               ├── HKDF(info="gun:ecdsa-key:v1")  → gun_ecdsa_seed
 *               │     └── P-256 ECDSA pair  → pub, priv
 *               │
 *               ├── HKDF(info="gun:ecdh-key:v1")   → gun_ecdh_seed
 *               │     └── P-256 ECDH pair   → epub, epriv
 *               │
 *               └── HKDF(info="root-seed:v1")      → rootSeed (exported)
 */
async function deriveIdentityFromPRFOutput(
  prfOutput:    Uint8Array,
  credentialId: string
): Promise<FlickerIdentity> {
  // Layer 1: Hash PRF output to add domain separation and normalize distribution.
  const rootEntropy = sha256(
    new Uint8Array([...prfOutput, ...utf8ToBytes('flicker.tv:root-entropy:v1')])
  );

  // Layer 2: HKDF-expand into purpose-specific seeds.
  const nostrSeed   = deriveSubkey(rootEntropy, HKDF_INFO.nostrSigning,  32);
  const gunECDSASeed = deriveSubkey(rootEntropy, HKDF_INFO.gunECDSA,     32);
  const gunECDHSeed  = deriveSubkey(rootEntropy, HKDF_INFO.gunECDH,      32);
  const rootSeed     = deriveSubkey(rootEntropy, HKDF_INFO.rootSeedExport, 32);

  // Layer 3: Derive actual keypairs.
  const nostr = deriveNostrIdentity(nostrSeed);
  const [ecdsaPair, ecdhPair] = await Promise.all([
    deriveP256ECDSAKeypair(gunECDSASeed),
    deriveP256ECDHKeypair(gunECDHSeed),
  ]);

  const gun: GunSEAPair = {
    pub:   ecdsaPair.pub,
    priv:  ecdsaPair.priv,
    epub:  ecdhPair.epub,
    epriv: ecdhPair.epriv,
  };

  return {
    nostr,
    gun,
    rootSeed,
    credentialId,
    derivedAt: loadDerivedAt(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive the user's FlickerIdentity via hardware passkey PRF.
 *
 * This function is idempotent: calling it multiple times on the same hardware
 * token with the same PRF salt produces byte-for-bit identical output.
 *
 * @param onProgress  Optional UX callback for status messages.
 * @returns           Fully derived FlickerIdentity (never persisted to disk).
 * @throws            If WebAuthn is unsupported, no platform authenticator
 *                    exists, or the user cancels the gesture.
 */
export async function deriveFlickerIdentity(
  onProgress?: (status: string) => void
): Promise<FlickerIdentity> {
  if (typeof window === 'undefined') {
    throw new Error('[WebAuthnIdentity] Must be called in a browser context.');
  }

  if (!browserSupportsWebAuthn()) {
    throw new Error(
      '[WebAuthnIdentity] WebAuthn not supported. ' +
        'A modern browser with FIDO2 support is required.'
    );
  }

  const hasPlatformAuth = await platformAuthenticatorIsAvailable();
  if (!hasPlatformAuth) {
    throw new Error(
      '[WebAuthnIdentity] No platform authenticator available. ' +
        'This device requires Face ID, Touch ID, or Windows Hello.'
    );
  }

  const storedId = loadCredentialId();
  let credentialId: string;
  let prfOutput:    Uint8Array;

  if (storedId) {
    onProgress?.('Touch ID / Face ID to verify your identity…');
    try {
      prfOutput    = await authenticateWithPasskey(storedId);
      credentialId = storedId;
      onProgress?.('Passkey verified. Deriving cryptographic identity…');
    } catch (authErr) {
      // Credential was deleted from the authenticator or ITP cleared the ID.
      // Re-register: if the same hardware token is used, derived keys WILL
      // be identical (PRF is bound to the authenticator, not the credential ID).
      console.warn(
        '[WebAuthnIdentity] Stored credential unavailable, re-registering:',
        authErr
      );
      onProgress?.('Passkey not found. Creating new identity…');
      ({ credentialId, prfOutput } = await registerNewPasskey());
      onProgress?.('Passkey created. Deriving identity…');
    }
  } else {
    onProgress?.('No passkey found. Touch ID / Face ID to create one…');
    ({ credentialId, prfOutput } = await registerNewPasskey());
    onProgress?.('Passkey registered. Deriving identity…');
  }

  const identity = await deriveIdentityFromPRFOutput(prfOutput, credentialId);

  // Overwrite PRF output from memory — it should not linger.
  prfOutput.fill(0);

  onProgress?.('Identity ready.');
  return identity;
}

/**
 * Derive an additional purpose-specific subkey from a FlickerIdentity
 * without exposing the root seed directly.
 *
 * Example: `deriveSubkeyFromIdentity(identity, 'stream-encryption', 32)`
 */
export function deriveSubkeyFromIdentity(
  identity: FlickerIdentity,
  purpose:  string,
  length:   number = 32
): Uint8Array {
  return deriveSubkey(
    identity.rootSeed,
    utf8ToBytes(`flicker.tv:subkey:${purpose}:v1`),
    length
  );
}

/**
 * Wipe the stored credential ID from localStorage, forcing fresh
 * registration on the next `deriveFlickerIdentity()` call.
 *
 * NOTE: This does NOT revoke the passkey from the platform authenticator.
 * The hardware credential continues to exist until removed via OS settings.
 */
export function clearStoredCredential(): void {
  try {
    localStorage.removeItem(STORAGE_CREDENTIAL_ID);
    localStorage.removeItem(STORAGE_DERIVED_AT);
  } catch {
    // ignore
  }
}

/** Returns true if a credential ID is present in localStorage. */
export function hasStoredCredential(): boolean {
  return loadCredentialId() !== null;
}

export type { FlickerIdentity, NostrIdentity, GunSEAPair };