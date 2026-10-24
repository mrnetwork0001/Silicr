/**
 * Encrypted job channel between the buyer and the winning provider.
 *
 *   shared       = X25519(mySecret, theirPublic)            (all-zero output rejected)
 *   key          = HKDF-SHA256(shared, salt = rfqId, "silicr/v1/channel-key", 32)
 *   mailbox[k]   = hex(HKDF-SHA256(shared, salt = rfqId, "silicr/v1/mailbox/<k>", 16))
 *   seal(k, pt)  = nonce (24 B) | XChaCha20-Poly1305(key, nonce, pt, aad = "silicr/v1/blob/<k>" | rfqId)
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import type { BlobKind, Bytes, Channel } from './contract.ts';
import { ProtocolError, assertBytes, concat, describe, toHex, utf8 } from './bytes.ts';
import { RFQ_ID_BYTES } from './keys.ts';

// A Record so the compiler flags any BlobKind added to the contract without a mailbox.
const KINDS: Record<BlobKind, true> = { job: true, log: true, heartbeat: true, result: true, control: true, checkpoint: true };
export const BLOB_KINDS: readonly BlobKind[] = Object.freeze(Object.keys(KINDS) as BlobKind[]);

const NONCE_BYTES = 24;
const TAG_BYTES = 16;

export function deriveChannel(mySecret: Bytes, theirPublic: Bytes, rfqId: Bytes): Channel {
  assertBytes(mySecret, 32, 'X25519 secret key');
  assertBytes(theirPublic, 32, 'X25519 public key');
  assertBytes(rfqId, RFQ_ID_BYTES, 'rfqId');
  let shared: Bytes;
  try {
    shared = x25519.getSharedSecret(mySecret, theirPublic);
  } catch {
    throw new ProtocolError('X25519 rejected the peer public key (low-order or invalid point)');
  }
  // noble already refuses low-order points; check the output as RFC 7748 §6.1 recommends.
  if (shared.every((b) => b === 0)) throw new ProtocolError('X25519 shared secret is all zero (low-order peer key)');

  const salt = Uint8Array.from(rfqId);
  const kdf = (info: string, length: number): Bytes => hkdf(sha256, shared, salt, utf8(info), length);
  const key = kdf('silicr/v1/channel-key', 32);
  const mailboxes = Object.freeze(
    Object.fromEntries(BLOB_KINDS.map((kind) => [kind, toHex(kdf(`silicr/v1/mailbox/${kind}`, 16))])),
  ) as Record<BlobKind, string>;

  const aad = (kind: unknown): Bytes => {
    if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) {
      throw new ProtocolError(`blob kind must be one of ${BLOB_KINDS.join(', ')}`);
    }
    return concat(utf8(`silicr/v1/blob/${kind}`), salt);
  };

  return Object.freeze({
    // A copy: callers mutating channel.key can't affect sealing.
    key: Uint8Array.from(key),
    mailboxes,
    seal(kind: BlobKind, plaintext: Bytes): Bytes {
      const ad = aad(kind);
      if (!(plaintext instanceof Uint8Array)) {
        throw new ProtocolError(`plaintext must be a Uint8Array (got ${describe(plaintext)})`);
      }
      const out = new Uint8Array(NONCE_BYTES + plaintext.length + TAG_BYTES);
      const nonce = randomBytes(NONCE_BYTES);
      out.set(nonce);
      xchacha20poly1305(key, nonce, ad).encrypt(plaintext, out.subarray(NONCE_BYTES));
      return out;
    },
    open(kind: BlobKind, sealed: Bytes): Bytes {
      const ad = aad(kind);
      if (!(sealed instanceof Uint8Array) || sealed.length < NONCE_BYTES + TAG_BYTES) {
        throw new ProtocolError('sealed blob is too short');
      }
      try {
        return xchacha20poly1305(key, sealed.slice(0, NONCE_BYTES), ad).decrypt(sealed.subarray(NONCE_BYTES));
      } catch {
        throw new ProtocolError('sealed blob failed to authenticate (wrong channel, kind or rfqId, or tampered)');
      }
    },
  });
}
