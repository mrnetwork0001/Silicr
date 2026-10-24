import { describe, expect, it } from 'vitest';
import {
  BLOB_TYPE_CODE,
  CHUNK_PAYLOAD_BYTES,
  MAX_FRAME_BYTES,
  MemoBlobAssembler,
  ProtocolError,
  chunkCount,
  decodeBlobMemo,
  decodeMemo,
  deriveChannel,
  encodeBlobFrame,
  encodeBlobMemo,
  encodeMemo,
  generateSigner,
  generateX25519,
  helloChunk,
  isHelloChunk,
  maxBlobBytes,
  newRfqId,
  splitBlob,
  type BlobChunk,
} from '../src/index.ts';
import { sampleMessages } from './helpers.ts';

const { signer } = generateSigner();
const other = generateSigner().signer;
const rfqId = newRfqId();
const transports = ['binary', 'text'] as const;

function sealedBlob(bytes: number): Uint8Array {
  const a = generateX25519();
  const b = generateX25519();
  const ch = deriveChannel(a.secretKey, b.publicKey, rfqId);
  const plain = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) plain[i] = (i * 31) & 0xff;
  return ch.seal('job', plain);
}

function shuffled<T>(xs: T[], seed = 7): T[] {
  const out = xs.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('chunk sizing', () => {
  it('fills the 380-byte frame budget in both transports', () => {
    expect(CHUNK_PAYLOAD_BYTES.first).toBeGreaterThan(200);
    // the first chunk gives up 32 digest bytes plus the CBOR heads (digest 2 bytes vs null 1; the shorter payload needs the same 3-byte head)
    expect(CHUNK_PAYLOAD_BYTES.rest - CHUNK_PAYLOAD_BYTES.first).toBeGreaterThanOrEqual(32);
    expect(CHUNK_PAYLOAD_BYTES.rest - CHUNK_PAYLOAD_BYTES.first).toBeLessThanOrEqual(34);
    const full = splitBlob(rfqId, 'result', 0xffff_ffff, sealedBlob(maxBlobBytes(3) - 40)); // seal adds a 24-byte nonce and a 16-byte tag
    expect(full).toHaveLength(3);
    for (const c of full) {
      // worst-case header, as the capacity was computed for (chunk 0 keeps index 0 and its digest)
      c.total = 0xffff;
      if (c.index > 0) c.index = 0xfffe;
      expect(encodeBlobFrame(c, signer).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
      for (const t of transports) expect(encodeBlobMemo(c, signer, t)).toHaveLength(512);
    }
    // one byte more than a chunk holds is refused
    full[1]!.payload = new Uint8Array(CHUNK_PAYLOAD_BYTES.rest + 1);
    expect(() => encodeBlobFrame(full[1]!, signer)).toThrow(ProtocolError);
  });

  it('counts chunks and the 40-output transaction budget', () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(CHUNK_PAYLOAD_BYTES.first)).toBe(1);
    expect(chunkCount(CHUNK_PAYLOAD_BYTES.first + 1)).toBe(2);
    expect(maxBlobBytes(40)).toBe(CHUNK_PAYLOAD_BYTES.first + 39 * CHUNK_PAYLOAD_BYTES.rest);
    expect(maxBlobBytes(40)).toBeGreaterThan(10 * 1024);
    expect(chunkCount(maxBlobBytes(40))).toBe(40);
    expect(chunkCount(maxBlobBytes(40) + 1)).toBe(41);
  });
});

describe('encode / decode', () => {
  it('round-trips every chunk in both transports, signed', () => {
    const sealed = sealedBlob(1000);
    const chunks = splitBlob(rfqId, 'job', 5, sealed);
    expect(chunks.length).toBe(chunkCount(sealed.length));
    expect(chunks[0]!.sha256).toBeDefined();
    expect(chunks[1]!.sha256).toBeUndefined();
    for (const t of transports) {
      for (const c of chunks) {
        const memo = encodeBlobMemo(c, signer, t);
        expect(decodeMemo(memo)).toBeNull(); // the message decoder leaves BLOB memos alone
        const d = decodeBlobMemo(memo)!;
        expect(d).not.toBeNull();
        expect(d.transport).toBe(t);
        expect(d.chunk).toEqual(c);
        expect(d.verifiedBy(signer.publicKey)).toBe(true);
        expect(d.verifiedBy(other.publicKey)).toBe(false);
      }
    }
  });

  it('rejects other memo types, dummies, tampering and bad fields', () => {
    for (const msg of sampleMessages(signer)) expect(decodeBlobMemo(encodeMemo(msg, signer, 'binary'))).toBeNull();
    expect(decodeBlobMemo(new Uint8Array(512))).toBeNull();
    const junk = new Uint8Array(512);
    junk[0] = 0xff;
    junk.set([1, 2, 3, 4, 5, 6, 7], 1);
    expect(decodeBlobMemo(junk)).toBeNull();
    const c = splitBlob(rfqId, 'log', 1, sealedBlob(100))[0]!;
    const memo = encodeBlobMemo(c, signer, 'binary');
    expect(memo[6]).toBe(BLOB_TYPE_CODE);
    const flipped = Uint8Array.from(memo);
    flipped[40] = flipped[40]! ^ 1; // inside the body
    const d = decodeBlobMemo(flipped);
    expect(d === null || !d.verifiedBy(signer.publicKey)).toBe(true);
    const trailing = Uint8Array.from(memo);
    trailing[511] = 1;
    expect(decodeBlobMemo(trailing)).toBeNull();
    const bad: BlobChunk = { ...c, index: 1 }; // index 1 of 1
    expect(() => encodeBlobFrame(bad, signer)).toThrow(ProtocolError);
    expect(() => encodeBlobFrame({ ...c, sha256: undefined }, signer)).toThrow(/sha256/);
    expect(() => encodeBlobFrame({ ...c, rfqId: new Uint8Array(15) }, signer)).toThrow(/rfqId/);
  });

  it('hello chunks are recognised and signed by the buyer key', () => {
    const h = helloChunk(rfqId);
    expect(isHelloChunk(h)).toBe(true);
    const d = decodeBlobMemo(encodeBlobMemo(h, signer, 'text'))!;
    expect(isHelloChunk(d.chunk)).toBe(true);
    expect(d.verifiedBy(signer.publicKey)).toBe(true);
    expect(isHelloChunk({ ...h, seq: 1 })).toBe(false);
    expect(isHelloChunk(splitBlob(rfqId, 'control', 0, sealedBlob(10))[0]!)).toBe(false);
  });
});

describe('MemoBlobAssembler', () => {
  it('reassembles out-of-order chunks, drops duplicates and late repeats', () => {
    const sealed = sealedBlob(3000);
    const chunks = splitBlob(rfqId, 'result', 9, sealed);
    expect(chunks.length).toBeGreaterThan(5);
    const asm = new MemoBlobAssembler();
    const got: ReturnType<typeof asm.push>[] = [];
    for (const c of shuffled([...chunks, ...chunks.slice(0, 3)])) got.push(asm.push(c));
    const done = got.filter((x) => x !== null);
    expect(done).toHaveLength(1);
    expect(done[0]!.sealed).toEqual(sealed);
    expect(done[0]!.seq).toBe(9);
    expect(done[0]!.kind).toBe('result');
    expect(asm.pending).toBe(0);
    expect(asm.push(chunks[0]!)).toBeNull(); // the blob is done: a late copy is dropped
    expect(asm.dropped.duplicate).toBe(4);
  });

  it('keeps blobs apart by (rfqId, kind, seq) and refuses mismatched totals and digests', () => {
    const a = splitBlob(rfqId, 'job', 1, sealedBlob(700));
    const b = splitBlob(rfqId, 'job', 2, sealedBlob(700));
    const c = splitBlob(newRfqId(), 'job', 1, sealedBlob(700));
    const asm = new MemoBlobAssembler();
    const mixed = shuffled([...a, ...b, ...c], 3);
    const done = mixed.map((x) => asm.push(x)).filter((x) => x !== null);
    expect(done).toHaveLength(3);
    // a chunk claiming a different total for an in-progress blob is ignored
    const d = splitBlob(rfqId, 'log', 3, sealedBlob(900));
    asm.push(d[0]!);
    expect(asm.push({ ...d[1]!, total: d[1]!.total + 1 })).toBeNull();
    expect(asm.dropped.mismatch).toBe(1);
    for (const x of d.slice(1)) asm.push(x);
    expect(asm.pending).toBe(0);
  });

  it('drops a blob whose bytes were tampered with, and oversize blobs', () => {
    const chunks = splitBlob(rfqId, 'heartbeat', 4, sealedBlob(600));
    const asm = new MemoBlobAssembler();
    chunks[1]!.payload[0] = chunks[1]!.payload[0]! ^ 0xff;
    expect(chunks.map((c) => asm.push(c)).some((x) => x !== null)).toBe(false);
    expect(asm.dropped.digest).toBe(1);
    const small = new MemoBlobAssembler({ maxBlobBytes: maxBlobBytes(2) });
    const big = splitBlob(rfqId, 'job', 1, sealedBlob(maxBlobBytes(3)));
    expect(big.length).toBeGreaterThan(2);
    expect(big.map((c) => small.push(c)).some((x) => x !== null)).toBe(false);
    expect(small.dropped.oversize).toBe(big.length);
  });

  it('bounds memory: the oldest unfinished blob is evicted', () => {
    const asm = new MemoBlobAssembler({ maxGroups: 2 });
    const first = splitBlob(rfqId, 'job', 1, sealedBlob(1000));
    asm.push(first[0]!);
    asm.push(splitBlob(rfqId, 'job', 2, sealedBlob(1000))[0]!);
    asm.push(splitBlob(rfqId, 'job', 3, sealedBlob(1000))[0]!);
    expect(asm.pending).toBe(2);
    expect(asm.dropped.evicted).toBe(1);
    // blob 1 was evicted: the rest of it starts a fresh group, which completes only with chunk 0 again
    for (const c of first.slice(1)) expect(asm.push(c)).toBeNull();
    expect(asm.push(first[0]!)!.sealed.length).toBe(sealedBlob(1000).length);
  });
});
