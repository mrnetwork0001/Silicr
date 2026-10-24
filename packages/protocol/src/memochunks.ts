/**
 * BLOB memos: sealed channel blobs carried inside Zcash memos (relay-less mode).
 *
 * A sealed blob (the ciphertext `Channel.seal()` produces) is cut into chunks, each
 * carried by one output of a shielded transaction. Every chunk is a signed frame in
 * the memo protocol v1 format with its own type code, additive to the five message
 * types in memo.ts (whose decoder reports it as "unknown message type", i.e. null):
 *
 *   frame = "SLC1" | version u8 | 6 | CBOR [rfqId, kind, seq, index, total, sha256?, payload] | Ed25519 sig
 *   sig   = Sign(utf8("silicr/v1/memo") | version | 6 | body)       (same scheme as memo.ts)
 *
 *   kind     BlobKind as a small integer, in BLOB_KINDS order (job 0, log 1, heartbeat 2, result 3, control 4, ...)
 *   seq      the sender's blob number for this (rfqId, kind): chunks of one blob share it
 *   index    0-based chunk index; total = chunk count (1..65535)
 *   sha256   SHA-256 of the whole sealed blob, on index 0 only (null elsewhere)
 *   payload  the chunk's bytes, packed to fill the 380-byte frame budget
 *
 * Who signs: buyer → provider blobs with the RFQ's buyerKey, provider → buyer blobs with
 * the provider's directory key. The payload is already AEAD-sealed to the channel (kind
 * and rfqId bound into its associated data), so the signature only has to keep junk out
 * of the reassembly buffer; it reveals nothing the shielded memo didn't already hide.
 *
 * Transport and cost: the frame is wrapped exactly like any other memo (binary 0xFF or
 * text "slc1:" + base64url). Each output costs the backend's minimum note value plus one
 * ZIP 317 logical action (5,000 zats); a 40-output transaction (~10.8 KB of sealed data)
 * costs 41 actions = 0.00205 ZEC.
 */
import { base64urlnopad } from '@scure/base';
import { MAGIC, PROTOCOL_VERSION } from './contract.ts';
import type { BlobKind, Bytes, Signer, Transport } from './contract.ts';
import { ProtocolError, concat, sha256, toHex, utf8 } from './bytes.ts';
import { BLOB_KINDS } from './channel.ts';
import { decodeCbor, encodeCbor, type CborValue } from './cbor.ts';
import { RFQ_ID_BYTES, verifySignature } from './keys.ts';
import { ARBITRARY_DATA_MARKER, MAX_FRAME_BYTES, TEXT_PREFIX } from './memo.ts';

/** Type byte of a BLOB frame. 1..5 are RFQ, BID, ACCEPT, PAY, CLOSE (memo.ts). */
export const BLOB_TYPE_CODE = 6;
export const MAX_CHUNKS_PER_BLOB = 0xffff;
const MEMO_BYTES = 512;
const HEADER_BYTES = 4 + 2;
const SIG_BYTES = 64;
const U32_MAX = 0xffff_ffff;
const MAGIC_BYTES = utf8(MAGIC);
const TEXT_PREFIX_BYTES = utf8(TEXT_PREFIX);
const SIGNATURE_DOMAIN = utf8('silicr/v1/memo');

// Wire codes follow BLOB_KINDS order (job 0, log 1, heartbeat 2, result 3, control 4, ...): a kind
// added to the contract gets the next code. Codes are never reused, so order there must not change.
const KIND_CODE = Object.fromEntries(BLOB_KINDS.map((k, i) => [k, i])) as Record<BlobKind, number>;
const KIND_BY_CODE = new Map<bigint, BlobKind>(BLOB_KINDS.map((k, i) => [BigInt(i), k]));

export interface BlobChunk {
  rfqId: Bytes;
  kind: BlobKind;
  seq: number;
  index: number;
  total: number;
  /** SHA-256 of the whole sealed blob. Present exactly when index === 0. */
  sha256?: Bytes;
  payload: Bytes;
}

export interface DecodedBlobMemo {
  chunk: BlobChunk;
  transport: Transport;
  /** True if the signature verifies under `publicKey` (buyerKey or providerId, by direction). */
  verifiedBy(publicKey: Bytes): boolean;
}

function body(c: BlobChunk): Bytes {
  return encodeCbor([c.rfqId, KIND_CODE[c.kind], c.seq, c.index, c.total, c.sha256 ?? null, c.payload]);
}

/** The largest payload a chunk can carry: computed from the worst-case header, once. */
function capacity(first: boolean): number {
  const probe: BlobChunk = {
    rfqId: new Uint8Array(RFQ_ID_BYTES),
    kind: 'control',
    seq: U32_MAX,
    index: MAX_CHUNKS_PER_BLOB - 1,
    total: MAX_CHUNKS_PER_BLOB,
    payload: new Uint8Array(0),
  };
  if (first) probe.sha256 = new Uint8Array(32);
  for (let n = MAX_FRAME_BYTES; n > 0; n--) {
    probe.payload = new Uint8Array(n);
    if (HEADER_BYTES + body(probe).length + SIG_BYTES <= MAX_FRAME_BYTES) return n;
  }
  throw new ProtocolError('frame budget leaves no room for a chunk payload');
}

/** Payload bytes per chunk: the first chunk also carries the blob digest. */
export const CHUNK_PAYLOAD_BYTES = Object.freeze({ first: capacity(true), rest: capacity(false) });

export function payloadCapacity(index: number): number {
  return index === 0 ? CHUNK_PAYLOAD_BYTES.first : CHUNK_PAYLOAD_BYTES.rest;
}

/** Chunks needed for a sealed blob of `bytes` bytes (0 bytes still takes one chunk). */
export function chunkCount(bytes: number): number {
  if (!Number.isInteger(bytes) || bytes < 0) throw new ProtocolError('blob size must be a non-negative integer');
  if (bytes <= CHUNK_PAYLOAD_BYTES.first) return 1;
  return 1 + Math.ceil((bytes - CHUNK_PAYLOAD_BYTES.first) / CHUNK_PAYLOAD_BYTES.rest);
}

/** The largest blob that fits `chunks` chunks, e.g. maxBlobBytes(40) for one 40-output transaction. */
export function maxBlobBytes(chunks: number): number {
  return CHUNK_PAYLOAD_BYTES.first + Math.max(0, chunks - 1) * CHUNK_PAYLOAD_BYTES.rest;
}

function checkChunk(c: BlobChunk): void {
  if (!(c.rfqId instanceof Uint8Array) || c.rfqId.length !== RFQ_ID_BYTES) throw new ProtocolError(`rfqId must be ${RFQ_ID_BYTES} bytes`);
  if (!Object.hasOwn(KIND_CODE, c.kind)) throw new ProtocolError(`kind must be one of ${BLOB_KINDS.join(', ')}`);
  for (const [name, v, max] of [
    ['seq', c.seq, U32_MAX],
    ['index', c.index, MAX_CHUNKS_PER_BLOB - 1],
    ['total', c.total, MAX_CHUNKS_PER_BLOB],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > max) throw new ProtocolError(`${name} must be an integer in 0..${max}`);
  }
  if (c.total < 1 || c.index >= c.total) throw new ProtocolError('index must be below total (total ≥ 1)');
  if ((c.index === 0) !== (c.sha256 !== undefined)) throw new ProtocolError('sha256 is present exactly on chunk 0');
  if (c.sha256 !== undefined && (!(c.sha256 instanceof Uint8Array) || c.sha256.length !== 32)) throw new ProtocolError('sha256 must be 32 bytes');
  if (!(c.payload instanceof Uint8Array)) throw new ProtocolError('payload must be a Uint8Array');
  if (c.payload.length > payloadCapacity(c.index)) {
    throw new ProtocolError(`chunk ${c.index} payload is ${c.payload.length} bytes; at most ${payloadCapacity(c.index)} fit a memo`);
  }
}

/** Cut a sealed blob into chunks for (rfqId, kind, seq). */
export function splitBlob(rfqId: Bytes, kind: BlobKind, seq: number, sealed: Bytes): BlobChunk[] {
  if (!(sealed instanceof Uint8Array)) throw new ProtocolError('sealed blob must be a Uint8Array');
  const total = chunkCount(sealed.length);
  if (total > MAX_CHUNKS_PER_BLOB) throw new ProtocolError(`blob needs ${total} chunks; at most ${MAX_CHUNKS_PER_BLOB} are allowed`);
  const digest = sha256(sealed);
  const out: BlobChunk[] = [];
  let at = 0;
  for (let index = 0; index < total; index++) {
    const n = Math.min(payloadCapacity(index), sealed.length - at);
    const chunk: BlobChunk = { rfqId: Uint8Array.from(rfqId), kind, seq, index, total, payload: sealed.slice(at, at + n) };
    if (index === 0) chunk.sha256 = digest;
    checkChunk(chunk);
    out.push(chunk);
    at += n;
  }
  return out;
}

function signedBytes(b: Bytes): Bytes {
  return concat(SIGNATURE_DOMAIN, Uint8Array.of(PROTOCOL_VERSION, BLOB_TYPE_CODE), b);
}

/** The signed BLOB frame, before transport wrapping. */
export function encodeBlobFrame(chunk: BlobChunk, signer: Signer): Bytes {
  checkChunk(chunk);
  const b = body(chunk);
  const size = HEADER_BYTES + b.length + SIG_BYTES;
  if (size > MAX_FRAME_BYTES) throw new ProtocolError(`BLOB frame would be ${size} bytes; the budget is ${MAX_FRAME_BYTES}`);
  const sig = signer.sign(signedBytes(b));
  if (!(sig instanceof Uint8Array) || sig.length !== SIG_BYTES) throw new ProtocolError('signer must return a 64-byte Ed25519 signature');
  return concat(MAGIC_BYTES, Uint8Array.of(PROTOCOL_VERSION, BLOB_TYPE_CODE), b, sig);
}

/** One 512-byte memo carrying the chunk, in the given transport (same wrapping as encodeMemo). */
export function encodeBlobMemo(chunk: BlobChunk, signer: Signer, transport: Transport): Bytes {
  if (transport !== 'binary' && transport !== 'text') throw new ProtocolError("transport must be 'binary' or 'text'");
  const frame = encodeBlobFrame(chunk, signer);
  const memo = new Uint8Array(MEMO_BYTES);
  if (transport === 'binary') {
    memo[0] = ARBITRARY_DATA_MARKER;
    memo.set(frame, 1);
  } else {
    memo.set(utf8(TEXT_PREFIX + base64urlnopad.encode(frame)));
  }
  return memo;
}

function parseFrame(buf: Bytes, start: number): { chunk: BlobChunk; signed: Bytes; sig: Bytes; end: number } {
  for (let i = 0; i < MAGIC_BYTES.length; i++) if (buf[start + i] !== MAGIC_BYTES[i]) throw new ProtocolError('not a Silicr frame');
  if (buf[start + 4] !== PROTOCOL_VERSION) throw new ProtocolError('unsupported protocol version');
  if (buf[start + 5] !== BLOB_TYPE_CODE) throw new ProtocolError('not a BLOB frame');
  const bodyStart = start + HEADER_BYTES;
  const { value, end: bodyEnd } = decodeCbor(buf, bodyStart);
  const end = bodyEnd + SIG_BYTES;
  if (end > buf.length || end - start > MAX_FRAME_BYTES) throw new ProtocolError('frame truncated or over budget');
  const chunk = fromCbor(value);
  return { chunk, signed: signedBytes(buf.subarray(bodyStart, bodyEnd)), sig: buf.slice(bodyEnd, end), end };
}

function fromCbor(v: CborValue): BlobChunk {
  if (!Array.isArray(v) || v.length !== 7) throw new ProtocolError('BLOB body must be an array of 7 fields');
  const [rfqId, kindCode, seq, index, total, digest, payload] = v as [CborValue, CborValue, CborValue, CborValue, CborValue, CborValue, CborValue];
  const num = (x: CborValue, name: string, max: number): number => {
    if (typeof x !== 'bigint' || x < 0n || x > BigInt(max)) throw new ProtocolError(`${name} must be an integer in 0..${max}`);
    return Number(x);
  };
  if (!(rfqId instanceof Uint8Array)) throw new ProtocolError('rfqId must be bytes');
  const kind = typeof kindCode === 'bigint' ? KIND_BY_CODE.get(kindCode) : undefined;
  if (kind === undefined) throw new ProtocolError('unknown blob kind');
  if (!(payload instanceof Uint8Array)) throw new ProtocolError('payload must be bytes');
  const chunk: BlobChunk = {
    rfqId,
    kind,
    seq: num(seq, 'seq', U32_MAX),
    index: num(index, 'index', MAX_CHUNKS_PER_BLOB - 1),
    total: num(total, 'total', MAX_CHUNKS_PER_BLOB),
    payload,
  };
  if (digest !== null) {
    if (!(digest instanceof Uint8Array)) throw new ProtocolError('sha256 must be bytes or null');
    chunk.sha256 = digest;
  }
  checkChunk(chunk);
  return chunk;
}

/** Decodes a BLOB memo (binary or text). Null for anything else, including the five message types. */
export function decodeBlobMemo(memo: Bytes): DecodedBlobMemo | null {
  try {
    if (!(memo instanceof Uint8Array) || memo.length > MEMO_BYTES) return null;
    const m = new Uint8Array(MEMO_BYTES);
    m.set(memo);
    if (m[0] === ARBITRARY_DATA_MARKER) {
      if (m[6] !== BLOB_TYPE_CODE) return null; // cheap reject: every other memo type, dummies
      const f = parseFrame(m, 1);
      for (let i = f.end; i < m.length; i++) if (m[i] !== 0) return null;
      return { chunk: f.chunk, transport: 'binary', verifiedBy: (pk) => verifySignature(pk, f.signed, f.sig) };
    }
    let len = m.length;
    while (len > 0 && m[len - 1] === 0) len--;
    if (len <= TEXT_PREFIX_BYTES.length) return null;
    for (let i = 0; i < TEXT_PREFIX_BYTES.length; i++) if (m[i] !== TEXT_PREFIX_BYTES[i]) return null;
    const frame = base64urlnopad.decode(String.fromCharCode(...m.subarray(TEXT_PREFIX_BYTES.length, len)));
    const f = parseFrame(frame, 0);
    if (f.end !== frame.length) return null;
    return { chunk: f.chunk, transport: 'text', verifiedBy: (pk) => verifySignature(pk, f.signed, f.sig) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transport negotiation: the HELLO blob

/**
 * A buyer that wants a relay-less deal sends, in the same transaction as the RFQ, one extra
 * output per provider carrying this chunk (kind 'control', seq 0, signed by buyerKey). A
 * provider that sees it next to the RFQ knows every later blob of this deal travels in memos.
 * The payload is a fixed tag, not sealed: there is no channel before the BID.
 */
export const HELLO_PAYLOAD: Bytes = utf8('silicr/v1/transport/memo');

export function helloChunk(rfqId: Bytes): BlobChunk {
  return { rfqId: Uint8Array.from(rfqId), kind: 'control', seq: 0, index: 0, total: 1, sha256: sha256(HELLO_PAYLOAD), payload: Uint8Array.from(HELLO_PAYLOAD) };
}

export function isHelloChunk(c: BlobChunk): boolean {
  if (c.kind !== 'control' || c.seq !== 0 || c.index !== 0 || c.total !== 1 || c.payload.length !== HELLO_PAYLOAD.length) return false;
  for (let i = 0; i < HELLO_PAYLOAD.length; i++) if (c.payload[i] !== HELLO_PAYLOAD[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Reassembly

export interface AssembledBlob {
  rfqId: Bytes;
  kind: BlobKind;
  seq: number;
  sealed: Bytes;
}

export interface AssemblerOptions {
  /** Blobs under assembly at once; the oldest is dropped beyond this. Default 256. */
  maxGroups?: number;
  /** Chunks declaring a blob larger than this (total × capacity) are dropped. Default maxBlobBytes(4 × 40). */
  maxBlobBytes?: number;
  /** Completed blob ids remembered to drop late duplicates. Default 4096. */
  maxDone?: number;
}

interface Group {
  total: number;
  parts: Map<number, Bytes>;
  sha256: Bytes | null;
  bytes: number;
}

/**
 * Collects chunks per (rfqId, kind, seq) and returns the sealed blob once every index is in.
 * Duplicates, chunks whose total or digest disagree with the first one seen, oversize blobs
 * and blobs that fail their digest are dropped. Memory is bounded by maxGroups × maxBlobBytes.
 * Chunks are expected to be signature-checked by the caller first.
 */
export class MemoBlobAssembler {
  private readonly groups = new Map<string, Group>();
  private readonly done = new Set<string>();
  private readonly maxGroups: number;
  private readonly maxBytes: number;
  private readonly maxDone: number;
  /** Chunks dropped so far, by reason. */
  readonly dropped: Record<'duplicate' | 'mismatch' | 'oversize' | 'digest' | 'evicted', number> = {
    duplicate: 0,
    mismatch: 0,
    oversize: 0,
    digest: 0,
    evicted: 0,
  };

  constructor(o: AssemblerOptions = {}) {
    this.maxGroups = o.maxGroups ?? 256;
    this.maxBytes = o.maxBlobBytes ?? maxBlobBytes(4 * 40);
    this.maxDone = o.maxDone ?? 4096;
  }

  get pending(): number {
    return this.groups.size;
  }

  push(c: BlobChunk): AssembledBlob | null {
    checkChunk(c);
    const key = `${toHex(c.rfqId)}/${c.kind}/${c.seq}`;
    if (this.done.has(key)) {
      this.dropped.duplicate++;
      return null;
    }
    if (maxBlobBytes(c.total) > this.maxBytes) {
      this.dropped.oversize++;
      return null;
    }
    let g = this.groups.get(key);
    if (!g) {
      while (this.groups.size >= this.maxGroups) {
        const oldest = this.groups.keys().next().value!;
        this.groups.delete(oldest);
        this.dropped.evicted++;
      }
      g = { total: c.total, parts: new Map(), sha256: null, bytes: 0 };
      this.groups.set(key, g);
    }
    if (c.total !== g.total) {
      this.dropped.mismatch++;
      return null;
    }
    if (c.sha256) {
      if (g.sha256 && !equal(g.sha256, c.sha256)) {
        this.dropped.mismatch++;
        return null;
      }
      g.sha256 = Uint8Array.from(c.sha256);
    }
    if (g.parts.has(c.index)) {
      this.dropped.duplicate++;
      return null;
    }
    g.parts.set(c.index, Uint8Array.from(c.payload));
    g.bytes += c.payload.length;
    if (g.parts.size < g.total) return null;
    this.groups.delete(key);
    const ordered: Bytes[] = [];
    for (let i = 0; i < g.total; i++) ordered.push(g.parts.get(i)!);
    const sealed = concat(...ordered);
    if (!g.sha256 || !equal(sha256(sealed), g.sha256)) {
      this.dropped.digest++;
      return null;
    }
    this.done.add(key);
    if (this.done.size > this.maxDone) this.done.delete(this.done.keys().next().value!);
    return { rfqId: Uint8Array.from(c.rfqId), kind: c.kind, seq: c.seq, sealed };
  }
}

function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
