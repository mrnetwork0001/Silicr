/**
 * @silicr/protocol contract: memo protocol v1, signatures and channel crypto.
 * Pure functions, no I/O. See ARCHITECTURE.md §3.
 *
 * Owned by the lead; engine is written against this in parallel. Additive,
 * backward-compatible changes are fine; flag anything else in your report.
 */

export type Bytes = Uint8Array;

export const MAGIC = 'SLC1';
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Memo messages. Each travels in one ZIP 302 memo (512 bytes), signed.

export interface Rfq {
  t: 'RFQ';
  /** 16 random bytes. */
  rfqId: Bytes;
  /** Lowercase model slug: 'h100' | 'a100' | 'l40s' | 'rtx4090' | 'cpu' | ... */
  gpu: string;
  /** Number of GPUs, 1..64. */
  count: number;
  /** Requested runtime, seconds. */
  durationS: number;
  /**
   * Buyer's ceiling for the whole job, per hour (all GPUs together).
   * 0 = undisclosed: the buyer keeps its budget private, providers bid their own
   * price and the buyer filters bids locally. Any other value is a public ceiling.
   */
  maxPricePerHourZats: bigint;
  /** One-time Orchard-only UA where BIDs (and provider CLOSEs) go. */
  replyTo: string;
  /** Ed25519 public key for this RFQ only. Signs this RFQ and every later buyer message. */
  buyerKey: Bytes;
  /** X25519 public key for this RFQ only. */
  buyerEph: Bytes;
  /** Bids mined after this height are ignored. */
  expiresHeight: number;
}

export interface Bid {
  t: 'BID';
  rfqId: Bytes;
  /** Provider's long-term Ed25519 directory key. Signs this BID. */
  providerId: Bytes;
  pricePerIntervalZats: bigint;
  intervalS: number;
  startWithinS: number;
  /** X25519 public key for this job only. */
  providerEph: Bytes;
  /** Fresh Orchard-only UA for this job's ACCEPT and PAY transactions. */
  payTo: string;
}

/** The transaction carrying ACCEPT pays for interval 0. */
export interface Accept {
  t: 'ACCEPT';
  rfqId: Bytes;
  providerId: Bytes;
  /** Maximum number of intervals the buyer intends to buy. */
  intervals: number;
  /** Echo of the accepted bid's price. */
  pricePerIntervalZats: bigint;
}

/** The transaction carrying PAY pays for interval `seq` (seq >= 1). */
export interface Pay {
  t: 'PAY';
  rfqId: Bytes;
  seq: number;
}

export type CloseReason = 'done' | 'buyer_stop' | 'provider_stop' | 'unpaid' | 'no_heartbeat' | 'error';

export interface Close {
  t: 'CLOSE';
  rfqId: Bytes;
  by: 'buyer' | 'provider';
  reason: CloseReason;
  /** Last interval that was paid for and served. */
  finalSeq: number;
  /** SHA-256 of the sealed result blob, when reason is 'done'. */
  resultDigest?: Bytes;
}

export type MemoMessage = Rfq | Bid | Accept | Pay | Close;
export type MemoType = MemoMessage['t'];

/**
 * 'binary': ZIP 302 arbitrary-data memo (0xFF prefix, then the frame, zero padded).
 * 'text':   a valid UTF-8 text memo "slc1:" + base64url(frame), for backends that
 *           only carry text memos (capabilities.binaryMemos === false).
 * Every message MUST fit in both transports; size tests enforce the worst case.
 */
export type Transport = 'binary' | 'text';

export interface Signer {
  readonly publicKey: Bytes;
  sign(message: Bytes): Bytes;
}

/** Result of decoding a memo. The signature is NOT trusted until verifiedBy() passes. */
export interface DecodedMemo {
  msg: MemoMessage;
  transport: Transport;
  /**
   * True if the signature verifies under `publicKey`. Who must have signed:
   *   RFQ → rfq.buyerKey · BID → bid.providerId · ACCEPT/PAY → the RFQ's buyerKey
   *   CLOSE by buyer → RFQ's buyerKey · CLOSE by provider → providerId
   */
  verifiedBy(publicKey: Bytes): boolean;
}

// ---------------------------------------------------------------------------
// Per-RFQ keys and the encrypted job channel

export interface X25519KeyPair {
  publicKey: Bytes;
  secretKey: Bytes;
}

export interface RfqKeys {
  signer: Signer;
  eph: X25519KeyPair;
}

/** What a sealed blob is for. Bound into the AEAD associated data, so blobs can't be swapped between roles. */
export type BlobKind = 'job' | 'log' | 'heartbeat' | 'result' | 'control' | 'checkpoint';

export interface Channel {
  /** 32-byte XChaCha20-Poly1305 key from X25519 → HKDF-SHA256. */
  readonly key: Bytes;
  /**
   * Relay mailbox ids (32 lowercase hex chars each), derived from the shared
   * secret so both sides know them without telling the relay anything.
   */
  readonly mailboxes: Record<BlobKind, string>;
  seal(kind: BlobKind, plaintext: Bytes): Bytes;
  /** Throws on authentication failure or kind mismatch. */
  open(kind: BlobKind, sealed: Bytes): Bytes;
}

/** Signed by the provider, then sealed with kind 'heartbeat'. */
export interface Heartbeat {
  rfqId: Bytes;
  seq: number;
  /** Unix ms. */
  ts: number;
  /** Progress counter reported by the job. */
  step: number;
  /** SHA-256 of the latest checkpoint files (32 zero bytes if none). */
  checkpointDigest: Bytes;
  status: 'starting' | 'running' | 'paused' | 'finished' | 'failed';
  /** Interval currently being served. */
  servingSeq: number;
  note?: string;
}

// ---------------------------------------------------------------------------
// Provider directory (public, pseudonymous)

export interface DirectoryEntry {
  v: 1;
  /** Hex Ed25519 public key. */
  providerId: string;
  /** Pseudonym, e.g. "amber-otter-17". */
  alias: string;
  /** Orchard-only UA that receives RFQs. */
  address: string;
  gpus: { model: string; count: number; vramGb: number }[];
  /** Decimal zatoshis. */
  minPricePerHourZats: string;
  bondZats?: string;
  /** Optional coarse region (continent). */
  region?: string;
  /** Unix seconds. */
  updatedAt: number;
  /** Hex Ed25519 signature over canonicalDirectoryBytes(entry without sig). */
  sig: string;
}
