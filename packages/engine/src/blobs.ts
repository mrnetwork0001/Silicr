// Large sealed payloads over the relay: split into ≤ 8 MiB chunks, each sealed on its own.
//
//   chunk plaintext = "SCK1" | u32be index | u32be total | u64be payloadLength | sha256(payload) (32) | bytes
//
// Delivery is at-least-once, so the reader keeps the first copy of each index, ignores chunks
// from a different upload (other digest), reassembles in order and checks length and digest.
// The digest a provider signs into CLOSE is sha256 over the sealed chunks in index order
// (for the usual single chunk that is exactly "the SHA-256 of the sealed result blob").
import type { BlobKind, Channel } from '@silicr/protocol';
import type { RelayClient } from '@silicr/relay';
import { bytesEqual, sleep } from './util.ts';

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;
const MAGIC = new TextEncoder().encode('SCK1');
const HEADER = 4 + 4 + 4 + 8 + 32;
const MAX_CHUNKS = Math.ceil(MAX_PAYLOAD_BYTES / 1024);

type Sha256 = (b: Uint8Array) => Uint8Array;

export interface Uploaded {
  /** sha256 over the sealed chunks, concatenated in index order. */
  sealedDigest: Uint8Array;
  parts: number;
  sealedBytes: number;
  /** First sealed chunk: what the relay stores, for the Leak Inspector. */
  first: Uint8Array;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function encodeChunk(index: number, total: number, payloadLength: number, digest: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER + data.length);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, index, false);
  dv.setUint32(8, total, false);
  dv.setBigUint64(12, BigInt(payloadLength), false);
  out.set(digest, 20);
  out.set(data, HEADER);
  return out;
}

export function decodeChunk(b: Uint8Array): { index: number; total: number; length: number; digest: Uint8Array; data: Uint8Array } | null {
  if (b.length < HEADER) return null;
  for (let i = 0; i < 4; i++) if (b[i] !== MAGIC[i]) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const index = dv.getUint32(4, false);
  const total = dv.getUint32(8, false);
  const length = Number(dv.getBigUint64(12, false));
  if (total < 1 || total > MAX_CHUNKS || index >= total || length > MAX_PAYLOAD_BYTES) return null;
  return { index, total, length, digest: b.slice(20, 52), data: b.slice(HEADER) };
}

export async function uploadChunked(relay: RelayClient, ch: Channel, kind: BlobKind, payload: Uint8Array, sha256: Sha256, chunkBytes = CHUNK_BYTES): Promise<Uploaded> {
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error(`payload is ${payload.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  const digest = sha256(payload);
  const total = Math.max(1, Math.ceil(payload.length / chunkBytes));
  const sealed: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const part = ch.seal(kind, encodeChunk(i, total, payload.length, digest, payload.subarray(i * chunkBytes, (i + 1) * chunkBytes)));
    await relay.append(ch.mailboxes[kind], part);
    sealed.push(part);
  }
  return { sealedDigest: sha256(concat(sealed)), parts: total, sealedBytes: sealed.reduce((n, p) => n + p.length, 0), first: sealed[0]! };
}

export interface Downloaded {
  payload: Uint8Array;
  sealedDigest: Uint8Array;
  parts: number;
}

/**
 * Read one chunked payload from the mailbox. Resolves null if `live()` turns false or the
 * deadline passes first. Throws if the reassembled payload fails its digest.
 */
export async function readChunked(
  relay: RelayClient,
  ch: Channel,
  kind: BlobKind,
  sha256: Sha256,
  o: {
    waitS: number;
    deadline: number;
    live: () => boolean;
    idleMs?: number;
    /** Refuse payloads declaring more than this many bytes. Default MAX_PAYLOAD_BYTES. */
    maxBytes?: number;
    /** Stop after downloading this many bytes in total (junk included). Default 2 × maxBytes + 16 MiB. */
    maxReadBytes?: number;
  },
): Promise<Downloaded | null> {
  const maxBytes = Math.min(o.maxBytes ?? MAX_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES);
  const maxRead = o.maxReadBytes ?? 2 * maxBytes + 16 * 1024 * 1024;
  let readBytes = 0;
  let after = 0;
  let meta: { total: number; length: number; digest: Uint8Array } | null = null;
  const parts = new Map<number, { data: Uint8Array; sealed: Uint8Array }>();
  while (o.live() && Date.now() < o.deadline) {
    let msgs: { seq: number; data: Uint8Array }[];
    try {
      msgs = await relay.read(ch.mailboxes[kind], after, Math.max(0, Math.min(o.waitS, (o.deadline - Date.now()) / 1000)));
    } catch {
      await sleep(500);
      continue;
    }
    for (const m of msgs) {
      after = Math.max(after, m.seq);
      readBytes += m.data.length;
      if (readBytes > maxRead) throw new Error(`gave up after downloading ${readBytes} bytes without a complete payload`);
      let plain: Uint8Array;
      try {
        plain = ch.open(kind, m.data);
      } catch {
        continue; // not ours / tampered
      }
      const c = decodeChunk(plain);
      if (!c) continue;
      if (c.length > maxBytes) throw new Error(`payload is ${c.length} bytes; at most ${maxBytes} are accepted`);
      if (!meta) meta = { total: c.total, length: c.length, digest: c.digest };
      else if (c.total !== meta.total || c.length !== meta.length || !bytesEqual(c.digest, meta.digest)) continue;
      if (!parts.has(c.index)) parts.set(c.index, { data: c.data, sealed: m.data });
    }
    if (meta && parts.size === meta.total) {
      const ordered = [...parts.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
      const payload = concat(ordered.map((p) => p.data));
      if (payload.length !== meta.length || !bytesEqual(sha256(payload), meta.digest)) throw new Error('reassembled payload failed its digest');
      return { payload, sealedDigest: sha256(concat(ordered.map((p) => p.sealed))), parts: meta.total };
    }
    if (msgs.length === 0) await sleep(o.idleMs ?? 200);
  }
  return null;
}

/**
 * Reassembles chunked payloads from a mailbox that carries MANY of them over time (checkpoints:
 * one per interval). Feed it every decrypted chunk in mailbox order; it returns a payload when
 * its last chunk arrives. A chunk from a newer upload (another digest) abandons the one in
 * progress: the newest payload is the one that matters. Duplicate chunks are ignored.
 */
export class ChunkAssembler {
  private meta: { total: number; length: number; digest: Uint8Array } | null = null;
  private readonly parts = new Map<number, Uint8Array>();
  private readonly sha256: Sha256;
  private readonly maxBytes: number;

  constructor(sha256: Sha256, maxBytes = MAX_PAYLOAD_BYTES) {
    this.sha256 = sha256;
    this.maxBytes = Math.min(maxBytes, MAX_PAYLOAD_BYTES);
  }

  /** Null until a payload completes. Throws on a payload above maxBytes or failing its digest. */
  push(plain: Uint8Array): Uint8Array | null {
    const c = decodeChunk(plain);
    if (!c) return null;
    if (c.length > this.maxBytes) throw new Error(`payload is ${c.length} bytes; at most ${this.maxBytes} are accepted`);
    if (!this.meta || c.total !== this.meta.total || c.length !== this.meta.length || !bytesEqual(c.digest, this.meta.digest)) {
      this.meta = { total: c.total, length: c.length, digest: c.digest };
      this.parts.clear();
    }
    if (!this.parts.has(c.index)) this.parts.set(c.index, c.data);
    if (this.parts.size < this.meta.total) return null;
    const ordered = [...this.parts.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
    const payload = concat(ordered);
    const ok = payload.length === this.meta.length && bytesEqual(this.sha256(payload), this.meta.digest);
    this.meta = null;
    this.parts.clear();
    if (!ok) throw new Error('reassembled payload failed its digest');
    return payload;
  }
}

// Log batches carry their own sequence number so a duplicated PUT is dropped by the reader.
export function encodeLogBatch(seq: number, lines: string[]): Uint8Array {
  const text = new TextEncoder().encode(lines.join('\n'));
  const out = new Uint8Array(4 + text.length);
  new DataView(out.buffer).setUint32(0, seq, false);
  out.set(text, 4);
  return out;
}

export function decodeLogBatch(b: Uint8Array): { seq: number; lines: string[] } | null {
  if (b.length < 4) return null;
  const seq = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, false);
  return { seq, lines: new TextDecoder().decode(b.subarray(4)).split('\n') };
}
