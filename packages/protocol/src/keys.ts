import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import type { Bytes, RfqKeys, Signer, X25519KeyPair } from './contract.ts';
import { assertBytes, utf8 } from './bytes.ts';

export const RFQ_ID_BYTES = 16;

export function newRfqId(): Bytes {
  return randomBytes(RFQ_ID_BYTES);
}

/** Ed25519 signer. The secret lives only in this closure, so printing a Signer never shows it. */
export function signerFromSecret(secret32: Bytes): Signer {
  assertBytes(secret32, 32, 'Ed25519 secret key');
  const secret = Uint8Array.from(secret32);
  const publicKey = ed25519.getPublicKey(secret);
  return Object.freeze({ publicKey, sign: (message: Bytes) => ed25519.sign(message, secret) });
}

export function generateSigner(): { signer: Signer; secret: Bytes } {
  const secret = randomBytes(32);
  return { signer: signerFromSecret(secret), secret };
}

/** X25519 key pair from a stored 32-byte secret (any 32 bytes are valid; X25519 clamps). */
export function x25519FromSecret(secret32: Bytes): X25519KeyPair {
  assertBytes(secret32, 32, 'X25519 secret key');
  const secretKey = Uint8Array.from(secret32);
  return { publicKey: x25519.getPublicKey(secretKey), secretKey };
}

export function generateX25519(): X25519KeyPair {
  return x25519FromSecret(randomBytes(32));
}

/** Deterministic per-RFQ buyer keys: HKDF-SHA256(ikm = masterSeed, salt = rfqId). */
export function deriveRfqKeys(masterSeed: Bytes, rfqId: Bytes): RfqKeys {
  assertBytes(masterSeed, 32, 'master seed');
  assertBytes(rfqId, RFQ_ID_BYTES, 'rfqId');
  const derive = (info: string): Bytes => hkdf(sha256, masterSeed, rfqId, utf8(info), 32);
  return {
    signer: signerFromSecret(derive('silicr/v1/rfq-sign')),
    eph: x25519FromSecret(derive('silicr/v1/rfq-eph')),
  };
}

/**
 * Strict Ed25519 verification (RFC 8032 / FIPS 186-5, not ZIP 215): canonical
 * encodings only, s < L, small-order public keys rejected, so a valid signature
 * cannot be mutated into another valid one. Never throws.
 */
export function verifySignature(publicKey: unknown, message: Bytes, signature: Bytes): boolean {
  try {
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return false;
    if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
